import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";
process.env.JWT_SECRET = "test-jwt-secret-123";
process.env.JWT_ADMIN_SECRET = "test-admin-secret-123";
process.env.COOKIE_SECRET = "test-cookie-secret-123456789012345";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD_HASH = `$2b$12$${"a".repeat(53)}`;
process.env.GOOGLE_APPLICATION_CREDENTIALS = "./does-not-exist-service-account.json";

const { turso } = await import("../src/config/db.js");
const firebase = await import("../src/services/firebase.js");
const jobsRepo = await import("../src/repositories/notification-jobs.js");
const planner = await import("../src/services/notification-planner.js");
const todosService = await import("../src/services/todos.js");
const checklistsService = await import("../src/services/checklists.js");
const contentService = await import("../src/services/content.js");
const usersService = await import("../src/services/users.js");
const { processPush } = await import("../src/services/sync.service.js");
const { runTick } = await import("../src/services/notification-tick.js");
const { localDateTimeToUtc } = await import("../src/utils/time.js");
const { default: Fastify } = await import("fastify");
const { default: userAuth } = await import("../src/plugins/user-auth.js");
const { default: notificationSettingsRoutes } = await import(
  "../src/routes/api/v1/notification-settings.js"
);
const { default: internalNotificationRoutes, secretMatches } = await import(
  "../src/routes/internal/notifications.js"
);
const { signUserToken } = await import("../src/services/api-auth.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID, OTHER_USER_ID } = fx;

const DATE = fx.utcDateFromToday(3);
const runAtVn = (date: string, hhmm: string): string =>
  localDateTimeToUtc(date, hhmm, "Asia/Ho_Chi_Minh").toISOString();

type CreateInput = Parameters<typeof todosService.createTodo>[1];
const makeTodo = async (input: CreateInput) =>
  (await todosService.createTodo(USER_ID, input)).todo;

const reminder = (todoId: string) =>
  jobsRepo.getEventJob(USER_ID, "todo_reminder", todoId);

const app = Fastify();

before(async () => {
  await applyAllMigrations(turso);
  await app.register(userAuth);
  await app.register(notificationSettingsRoutes, { prefix: "/notification-settings" });
  await app.register(internalNotificationRoutes, {
    prefix: "/internal/notifications",
    secret: "s3cret-s3cret-s3cret",
    dryRun: true,
  });
  await app.register(internalNotificationRoutes, {
    prefix: "/unset/notifications",
  });
  await app.ready();
});

after(async () => {
  await app.close();
});

beforeEach(async () => {
  for (const table of [
    "notification_jobs",
    "todo_timers",
    "notification_settings",
    "user_devices",
    "habit_logs",
    "habits",
    "checklist_run_items",
    "checklist_runs",
    "checklist_template_items",
    "daily_todo_logs",
    "daily_todo_summaries",
    "todo_tags",
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await turso.execute("DELETE FROM checklist_templates WHERE user_id <> '00000000-0000-0000-0000-000000000001'");
  await turso.execute("UPDATE todos SET parent_id = NULL, trigger_after_todo_id = NULL, recurrence_template_id = NULL");
  await turso.execute("DELETE FROM todos");
  await turso.execute(`DELETE FROM users WHERE id IN ('${USER_ID}', '${OTHER_USER_ID}')`);

  await fx.insertUser(turso, USER_ID);
  await fx.insertUser(turso, OTHER_USER_ID);
  firebase.setMessagingClientForTests(fx.fakeMessaging().client);
  firebase.setPushLogger(fx.silentLogger);
});

// ── REST write paths ─────────────────────────────────────────────────────────

test("creating a todo with a future reminder time creates one pending job at the right UTC instant", async () => {
  const created = await makeTodo({
    title: "Họp nhóm",
    scheduled_date: DATE,
    time: "09:00",
  });

  const job = await reminder(created.id);
  assert.equal(job?.status, "pending");
  assert.equal(job?.run_at, runAtVn(DATE, "09:00"));
  assert.equal(job?.target_device_id, null, "reminders go to every device");
});

test("no job for a todo without a time, or whose time is already in the past", async () => {
  const noTime = await makeTodo({ title: "A", scheduled_date: DATE });
  assert.equal(await reminder(noTime.id), null);

  const past = await makeTodo({
    title: "B",
    scheduled_date: fx.utcDateFromToday(-2),
    time: "09:00",
  });
  assert.equal(await reminder(past.id), null);
});

test("changing or removing the reminder time re-times or cancels the job", async () => {
  const todo = await makeTodo({ title: "A", scheduled_date: DATE, time: "09:00" });

  await todosService.updateTodo(USER_ID, todo.id, { time: "10:30" });
  assert.equal((await reminder(todo.id))?.run_at, runAtVn(DATE, "10:30"));
  assert.equal((await reminder(todo.id))?.status, "pending");

  await todosService.updateTodo(USER_ID, todo.id, { time: null });
  assert.equal((await reminder(todo.id))?.status, "cancelled");

  await todosService.updateTodo(USER_ID, todo.id, { time: "11:00" });
  assert.equal((await reminder(todo.id))?.status, "pending", "setting a time again re-arms the same job");
  assert.equal((await reminder(todo.id))?.run_at, runAtVn(DATE, "11:00"));
  const count = await turso.execute("SELECT COUNT(*) AS c FROM notification_jobs WHERE ref_id = '" + todo.id + "'");
  assert.equal(Number((count.rows[0] as unknown as { c: number }).c), 1, "still one job per todo");
});

test("editing an unrelated field after the reminder was sent does not send it again", async () => {
  const todo = await makeTodo({ title: "A", scheduled_date: DATE, time: "09:00" });
  await turso.execute({
    sql: "UPDATE notification_jobs SET status = 'sent', sent_at = ?, attempts = 1 WHERE ref_id = ?",
    args: ["2026-06-20T01:00:00.000Z", todo.id],
  });

  await todosService.updateTodo(USER_ID, todo.id, { title: "Đổi tên" });

  assert.equal((await reminder(todo.id))?.status, "sent");
});

test("moving the todo to another day moves the reminder; moving to no day cancels it", async () => {
  const todo = await makeTodo({ title: "A", scheduled_date: DATE, time: "09:00" });
  const other = fx.utcDateFromToday(5);

  await todosService.moveToDay(USER_ID, todo.id, { date: other });
  assert.equal((await reminder(todo.id))?.run_at, runAtVn(other, "09:00"));

  await todosService.moveToDay(USER_ID, todo.id, { date: null });
  assert.equal((await reminder(todo.id))?.status, "cancelled");
});

test("completing cancels the reminder; un-completing brings it back", async () => {
  const todo = await makeTodo({ title: "A", scheduled_date: DATE, time: "09:00" });

  await todosService.completeTodo(USER_ID, todo.id, {});
  assert.equal((await reminder(todo.id))?.status, "cancelled");

  await todosService.uncompleteTodo(USER_ID, todo.id);
  assert.equal((await reminder(todo.id))?.status, "pending");
});

test("deleting a todo cancels its reminder", async () => {
  const todo = await makeTodo({ title: "A", scheduled_date: DATE, time: "09:00" });
  await todosService.deleteTodo(USER_ID, todo.id);
  assert.equal((await reminder(todo.id))?.status, "cancelled");
});

test("a recurring series: completing creates the next occurrence WITH its own reminder; undoing parks it and drops that reminder", async () => {
  const root = await makeTodo({
    title: "Uống thuốc",
    scheduled_date: DATE,
    time: "08:00",
    recurrence_type: "daily",
    recurrence_interval: 1,
  });
  assert.equal((await reminder(root.id))?.status, "pending");

  const result = await todosService.completeTodo(USER_ID, root.id, {});
  const next = result.next_recurring_todo;
  assert.ok(next, "server generates the next occurrence");
  assert.equal((await reminder(root.id))?.status, "cancelled");
  const nextJob = await reminder(next.id);
  assert.equal(nextJob?.status, "pending");
  const tomorrow = new Date(Date.parse(`${DATE}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  assert.equal(nextJob?.run_at, runAtVn(tomorrow, "08:00"));

  await todosService.uncompleteTodo(USER_ID, root.id);
  assert.equal((await reminder(root.id))?.status, "pending", "reopened todo is armed again");
  assert.equal((await reminder(next.id))?.status, "cancelled", "parked (archived) occurrence has no reminder");

  // completing again revives the parked occurrence and its reminder
  await todosService.completeTodo(USER_ID, root.id, {});
  assert.equal((await reminder(next.id))?.status, "pending");
});

test("deleting a whole recurring series cancels every occurrence's reminder", async () => {
  const root = await makeTodo({
    title: "Tập thể dục",
    scheduled_date: DATE,
    time: "06:00",
    recurrence_type: "daily",
    recurrence_interval: 1,
  });
  const next = (await todosService.completeTodo(USER_ID, root.id, {})).next_recurring_todo;
  assert.ok(next);

  await todosService.deleteTodo(USER_ID, next.id, "all");

  assert.equal((await reminder(root.id))?.status, "cancelled");
  assert.equal((await reminder(next.id))?.status, "cancelled");
});

// ── admin write paths ────────────────────────────────────────────────────────

test("an admin soft-delete cancels the reminder too", async () => {
  const todo = await makeTodo({ title: "A", scheduled_date: DATE, time: "09:00" });
  assert.equal(await contentService.deleteTodo(todo.id), true);
  assert.equal((await reminder(todo.id))?.status, "cancelled");
});

test("an admin timezone edit moves the pending digests", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await planner.planAllUsers(new Date());
  const before = await fx.jobsFor(turso, USER_ID, "AND status = 'pending'");
  assert.ok(before.length > 0);

  await usersService.updateUserProfile(USER_ID, { timezone: "America/New_York" });

  for (const job of await fx.jobsFor(turso, USER_ID, "AND status = 'pending'")) {
    const kind = job.kind as "digest_morning" | "digest_todos" | "digest_habits";
    const hhmm = { digest_morning: "07:00", digest_todos: "17:00", digest_habits: "17:30" }[kind];
    assert.equal(
      job.run_at,
      localDateTimeToUtc(String(job.local_date), hhmm, "America/New_York").toISOString()
    );
  }
});

// ── sync push ────────────────────────────────────────────────────────────────

const stamp = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

test("sync push: create arms the reminder, clearing the time cancels it, delete keeps it cancelled", async () => {
  const id = "sync-todo-1";
  const [created] = await processPush(USER_ID, [
    {
      op: "create",
      type: "todo",
      payload: { id, title: "Từ máy khác", status: "open", position: 0, scheduled_date: DATE, time: "09:00", created_at: stamp(), updated_at: stamp() },
    },
  ]);
  assert.equal(created.status, "applied");
  assert.equal((await reminder(id))?.status, "pending");
  assert.equal((await reminder(id))?.run_at, runAtVn(DATE, "09:00"));

  await processPush(USER_ID, [
    { op: "update", type: "todo", payload: { id, time: "11:15", updated_at: stamp(1000) } },
  ]);
  assert.equal((await reminder(id))?.run_at, runAtVn(DATE, "11:15"));

  await processPush(USER_ID, [
    { op: "update", type: "todo", payload: { id, time: null, updated_at: stamp(2000) } },
  ]);
  assert.equal((await reminder(id))?.status, "cancelled");

  await processPush(USER_ID, [
    { op: "update", type: "todo", payload: { id, time: "12:00", updated_at: stamp(3000) } },
    { op: "delete", type: "todo", payload: { id, deleted_at: stamp(4000) } },
  ]);
  assert.equal((await reminder(id))?.status, "cancelled");
});

test("sync push: completing a todo cancels its reminder", async () => {
  const id = "sync-todo-2";
  await processPush(USER_ID, [
    { op: "create", type: "todo", payload: { id, title: "X", status: "open", position: 0, scheduled_date: DATE, time: "09:00", created_at: stamp(), updated_at: stamp() } },
  ]);
  await processPush(USER_ID, [
    { op: "update", type: "todo", payload: { id, status: "done", completed_at: stamp(500), updated_at: stamp(1000) } },
  ]);
  assert.equal((await reminder(id))?.status, "cancelled");
});

test("sync push: a pushed user entity with a new timezone moves the pending digests", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await planner.planAllUsers(new Date());

  await processPush(USER_ID, [
    { op: "update", type: "user", payload: { id: USER_ID, timezone: "Asia/Tokyo", updated_at: stamp(3_600_000) } },
  ]);

  const morning = (await fx.jobsFor(turso, USER_ID, "AND status = 'pending' AND kind = 'digest_morning'"))[0];
  assert.ok(morning);
  assert.equal(
    morning.run_at,
    localDateTimeToUtc(String(morning.local_date), "07:00", "Asia/Tokyo").toISOString()
  );
});

// ── checklist runs ───────────────────────────────────────────────────────────

const checklistJob = (runId: string) =>
  jobsRepo.getEventJob(USER_ID, "checklist_30m", runId);

test("REST: starting a run arms a job 30 minutes after started_at; complete/abandon/delete cancel it", async () => {
  await fx.insertTemplateWithItems(turso, { id: "tpl-1", itemCount: 2 });

  const started = await checklistsService.startRun(USER_ID, { template_id: "tpl-1" });
  const job = await checklistJob(started.run.id);
  assert.equal(job?.status, "pending");
  assert.equal(job?.run_at, new Date(Date.parse(started.run.started_at) + 30 * 60_000).toISOString());

  await checklistsService.abandonRun(USER_ID, started.run.id);
  assert.equal((await checklistJob(started.run.id))?.status, "cancelled");

  const second = await checklistsService.startRun(USER_ID, { template_id: "tpl-1" });
  assert.equal((await checklistJob(second.run.id))?.status, "pending");
  await checklistsService.completeRun(USER_ID, second.run.id, {});
  assert.equal((await checklistJob(second.run.id))?.status, "cancelled");

  const third = await checklistsService.startRun(USER_ID, { template_id: "tpl-1" });
  await checklistsService.deleteRun(USER_ID, third.run.id);
  assert.equal((await checklistJob(third.run.id))?.status, "cancelled");
});

test("sync push: a run created offline arms the job, finishing or deleting it cancels", async () => {
  await fx.insertTemplateWithItems(turso, { id: "tpl-2", itemCount: 1 });
  const startedAt = stamp(-60_000);
  const runId = "sync-run-1";

  await processPush(USER_ID, [
    { op: "create", type: "checklist_run", payload: { id: runId, template_id: "tpl-2", name: null, status: "in_progress", started_at: startedAt, created_at: startedAt, updated_at: startedAt } },
  ]);
  assert.equal((await checklistJob(runId))?.status, "pending");

  await processPush(USER_ID, [
    { op: "update", type: "checklist_run", payload: { id: runId, template_id: "tpl-2", name: null, status: "completed", started_at: startedAt, completed_at: stamp(), created_at: startedAt, updated_at: stamp(2000) } },
  ]);
  assert.equal((await checklistJob(runId))?.status, "cancelled");

  const other = "sync-run-2";
  await processPush(USER_ID, [
    { op: "create", type: "checklist_run", payload: { id: other, template_id: "tpl-2", name: null, status: "in_progress", started_at: startedAt, created_at: startedAt, updated_at: startedAt } },
  ]);
  assert.equal((await checklistJob(other))?.status, "pending");
  await processPush(USER_ID, [
    { op: "delete", type: "checklist_run", payload: { id: other, deleted_at: stamp(3000) } },
  ]);
  assert.equal((await checklistJob(other))?.status, "cancelled");
});

test("a run that was already far past its 30 minutes when it syncs gets no reminder", async () => {
  await fx.insertTemplateWithItems(turso, { id: "tpl-3", itemCount: 1 });
  const longAgo = stamp(-3 * 3_600_000);
  await processPush(USER_ID, [
    { op: "create", type: "checklist_run", payload: { id: "old-run", template_id: "tpl-3", name: null, status: "in_progress", started_at: longAgo, created_at: longAgo, updated_at: longAgo } },
  ]);
  assert.equal(await checklistJob("old-run"), null);
});

// ── safety net: todos that never got a job ───────────────────────────────────

test("the tick creates missing reminder jobs for existing todos (future -> pending, past -> missed)", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await fx.insertTodo(turso, { id: "future", scheduledDate: fx.utcDateFromToday(2), time: "10:00" });
  await fx.insertTodo(turso, { id: "past", scheduledDate: fx.utcDateFromToday(-1), time: "08:00" });
  await fx.insertTodo(turso, { id: "done", scheduledDate: fx.utcDateFromToday(2), time: "10:00", status: "done" });
  await fx.insertTodo(turso, { id: "sub", scheduledDate: fx.utcDateFromToday(2), time: null, parentId: "future" });
  await fx.insertTodo(turso, { id: "no-time", scheduledDate: fx.utcDateFromToday(2) });
  await fx.insertTodo(turso, { id: "other-user", userId: OTHER_USER_ID, scheduledDate: fx.utcDateFromToday(2), time: "10:00" });

  const first = await runTick({ dryRun: true, logger: fx.silentLogger });
  assert.equal(first.backfilled, 2);
  assert.equal((await reminder("future"))?.status, "pending");
  assert.equal((await reminder("past"))?.status, "missed");
  for (const id of ["done", "sub", "no-time"]) assert.equal(await reminder(id), null, id);
  assert.equal(
    await jobsRepo.getEventJob(OTHER_USER_ID, "todo_reminder", "other-user"),
    null,
    "a user without a device gets no jobs"
  );

  const second = await runTick({ dryRun: true, logger: fx.silentLogger });
  assert.equal(second.backfilled, 0, "idempotent");
});

// ── notification settings API ────────────────────────────────────────────────

const authHeader = () => ({ authorization: `Bearer ${signUserToken(app, USER_ID)}` });

test("GET /notification-settings returns the defaults and the derived habit time", async () => {
  const res = await app.inject({ method: "GET", url: "/notification-settings", headers: authHeader() });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    morningTime: "07:00",
    eveningTime: "17:00",
    habitSummaryTime: "17:30",
    timezone: "Asia/Ho_Chi_Minh",
  });
});

test("PUT /notification-settings saves, changes users.timezone and moves pending digests", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await planner.planAllUsers(new Date());

  const res = await app.inject({
    method: "PUT",
    url: "/notification-settings",
    headers: authHeader(),
    payload: { morningTime: "06:15", eveningTime: "20:00", timezone: "America/New_York" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    morningTime: "06:15",
    eveningTime: "20:00",
    habitSummaryTime: "20:30",
    timezone: "America/New_York",
  });

  const user = await turso.execute({ sql: "SELECT timezone, updated_at FROM users WHERE id = ?", args: [USER_ID] });
  assert.equal((user.rows[0] as unknown as { timezone: string }).timezone, "America/New_York");
  assert.notEqual((user.rows[0] as unknown as { updated_at: string }).updated_at, "2026-06-01T00:00:00.000Z");

  const again = await app.inject({ method: "GET", url: "/notification-settings", headers: authHeader() });
  assert.equal(again.json().morningTime, "06:15");

  const times = { digest_morning: "06:15", digest_todos: "20:00", digest_habits: "20:30" } as const;
  const pending = await fx.jobsFor(turso, USER_ID, "AND status = 'pending'");
  assert.ok(pending.length > 0);
  for (const job of pending) {
    assert.equal(
      job.run_at,
      localDateTimeToUtc(String(job.local_date), times[job.kind as keyof typeof times], "America/New_York").toISOString()
    );
  }
  // idempotent: no duplicate digest rows after the change
  const rows = await fx.jobsFor(turso, USER_ID);
  const keys = rows.map((job) => `${job.kind}|${job.local_date}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("a digest that was already sent is not touched by a settings change", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await planner.planAllUsers(new Date());
  const [first] = await fx.jobsFor(turso, USER_ID, "AND kind = 'digest_morning'");
  await turso.execute({ sql: "UPDATE notification_jobs SET status = 'sent' WHERE id = ?", args: [first.id as string] });

  await app.inject({
    method: "PUT",
    url: "/notification-settings",
    headers: authHeader(),
    payload: { morningTime: "05:00", eveningTime: "17:00", timezone: "Asia/Ho_Chi_Minh" },
  });

  const after = await turso.execute({ sql: "SELECT run_at, status FROM notification_jobs WHERE id = ?", args: [first.id as string] });
  assert.equal((after.rows[0] as unknown as { status: string }).status, "sent");
  assert.equal((after.rows[0] as unknown as { run_at: string }).run_at, first.run_at);
});

test("evening 23:29 is accepted (habit summary capped at 23:59); 23:30 and bad input are 400", async () => {
  const put = (payload: unknown) =>
    app.inject({ method: "PUT", url: "/notification-settings", headers: authHeader(), payload: payload as object });

  const ok = await put({ morningTime: "07:00", eveningTime: "23:29", timezone: "Asia/Ho_Chi_Minh" });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().habitSummaryTime, "23:59");

  for (const bad of [
    { morningTime: "07:00", eveningTime: "23:30", timezone: "Asia/Ho_Chi_Minh" },
    { morningTime: "7:00", eveningTime: "17:00", timezone: "Asia/Ho_Chi_Minh" },
    { morningTime: "07:00", eveningTime: "17:00", timezone: "Mars/Base" },
    { morningTime: "07:00", eveningTime: "17:00" },
    {},
  ]) {
    const res = await put(bad);
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.equal(res.json().error, "bad_input");
  }
});

test("/notification-settings requires a user JWT", async () => {
  for (const method of ["GET", "PUT"] as const) {
    const res = await app.inject({ method, url: "/notification-settings", payload: method === "PUT" ? {} : undefined });
    assert.equal(res.statusCode, 401);
  }
});

// ── tick endpoint ────────────────────────────────────────────────────────────

test("tick endpoint rejects a missing or wrong secret and accepts the right one", async () => {
  const url = "/internal/notifications/tick";
  assert.equal((await app.inject({ method: "POST", url })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: "POST", url, headers: { "x-notify-tick-secret": "wrong" } })).statusCode,
    401
  );
  assert.equal(
    (await app.inject({ method: "POST", url, headers: { authorization: "Bearer s3cret-s3cret-s3cret" } })).statusCode,
    401,
    "only the dedicated header counts"
  );

  const ok = await app.inject({ method: "POST", url, headers: { "x-notify-tick-secret": "s3cret-s3cret-s3cret" } });
  assert.equal(ok.statusCode, 200);
  const body = ok.json();
  assert.equal(body.dry_run, true);
  for (const key of ["planned", "claimed", "sent", "cancelled", "missed", "failed"]) {
    assert.equal(typeof body[key], "number", key);
  }
});

test("with no NOTIFY_TICK_SECRET configured the endpoint rejects EVERY request", async () => {
  const url = "/unset/notifications/tick";
  assert.equal((await app.inject({ method: "POST", url })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: "POST", url, headers: { "x-notify-tick-secret": "" } })).statusCode,
    401
  );
  assert.equal(
    (await app.inject({ method: "POST", url, headers: { "x-notify-tick-secret": "undefined" } })).statusCode,
    401
  );
  assert.equal(secretMatches("anything", undefined), false);
  assert.equal(secretMatches("anything", ""), false);
  assert.equal(secretMatches(undefined, "abc"), false);
  assert.equal(secretMatches("abc", "abc"), true);
});

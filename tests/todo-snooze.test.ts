/**
 * Snooze a todo's reminder (`POST /todos/:id/snooze`): the reminder time moves N minutes later, the other devices
 * receive it through the normal sync, and the notification on the phones is removed at once. The notification
 * tests go through the real path: the tick sends, the snooze edits, the tick sends again.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import Fastify from "fastify";

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
const { runDispatch } = await import("../src/services/notification-tick.js");
const cards = await import("../src/services/notification-cards.js");
const todosService = await import("../src/services/todos.js");
const { snoozeTodo, computeSnoozeTarget, SnoozeError } = await import("../src/services/todo-snooze.js");
const { SnoozeTodoSchema } = await import("../src/schemas/api/todos.js");
const { SNOOZE } = await import("../src/config/notification-policy.js");
const { default: userAuth } = await import("../src/plugins/user-auth.js");
const { default: todosRoutes } = await import("../src/routes/api/v1/todos.js");
const { signUserToken } = await import("../src/services/api-auth.js");
const { getChangesSince, getSyncCursorTime } = await import("../src/repositories/sync.repo.js");
const { addDays, localDateTimeToUtc } = await import("../src/utils/time.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID, OTHER_USER_ID } = fx;
const VN = "Asia/Ho_Chi_Minh";
/** A few days ahead of the real clock, so no past-day lock applies and the reminder jobs really get created. */
const DATE = fx.utcDateFromToday(3);
const NEXT = addDays(DATE, 1);
/** Far enough ahead that a request made with the REAL clock always sees the reminder as not yet due. */
const FAR = fx.utcDateFromToday(30);

const at = (date: string, hhmm: string, seconds = 0, zone = VN): Date =>
  new Date(localDateTimeToUtc(date, hhmm, zone).getTime() + seconds * 1000);

const app = Fastify();
let fake = fx.fakeMessaging();

before(async () => {
  await applyAllMigrations(turso);
  await app.register(userAuth);
  await app.register(todosRoutes, { prefix: "/todos" });
  await app.ready();
});

after(async () => {
  await app.close();
  turso.close();
});

beforeEach(async () => {
  for (const table of [
    "notification_jobs",
    "todo_timers",
    "notification_settings",
    "user_devices",
    "daily_todo_logs",
    "daily_todo_summaries",
    "todo_tags",
    "todo_series_reminder_times",
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await turso.execute("UPDATE todos SET parent_id = NULL, trigger_after_todo_id = NULL, recurrence_template_id = NULL");
  await turso.execute("DELETE FROM todos");
  await turso.execute(`DELETE FROM users WHERE id IN ('${USER_ID}', '${OTHER_USER_ID}')`);

  await fx.insertUser(turso, USER_ID);
  await fx.insertUser(turso, OTHER_USER_ID);

  fake = fx.fakeMessaging();
  firebase.setMessagingClientForTests(fake.client);
  firebase.setPushLogger(fx.silentLogger);
});

const dismissMessages = () => fake.messages.filter((m) => m.data?.type === "dismiss");
const shownMessages = () => fake.messages.filter((m) => m.notification !== undefined);
const dispatchAt = (date: string, hhmm: string, seconds = 10) =>
  runDispatch({ now: at(date, hhmm, seconds), logger: fx.silentLogger });

const createTodo = async (fields: Partial<Parameters<typeof todosService.createTodo>[1]> = {}) =>
  (
    await todosService.createTodo(USER_ID, {
      title: "Nộp báo cáo",
      scheduled_date: DATE,
      time: "10:00",
      is_important: true,
      is_urgent: true,
      ...fields,
    })
  ).todo;

const rowOf = async (id: string) =>
  (await turso.execute({ sql: "SELECT scheduled_date, time, status FROM todos WHERE id = ?", args: [id] }))
    .rows[0] as unknown as { scheduled_date: string | null; time: string | null; status: string };

const jobs = async (id: string, kind: string, status = "pending") =>
  (await fx.jobsFor(turso, USER_ID, `AND ref_id = '${id}' AND kind = '${kind}' AND status = '${status}'`)).map((row) =>
    String(row.run_at)
  );

const cardKeys = async (id: string) =>
  (await fx.jobsFor(turso, USER_ID, `AND ref_id = '${id}' AND card_key IS NOT NULL`)).map((row) => [
    row.kind,
    row.card_key,
  ]);

/** Two devices, an important+urgent todo at 10:00, and its on-time reminder delivered to both. */
const sentReminder = async (fields: Partial<Parameters<typeof todosService.createTodo>[1]> = {}) => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await fx.insertDevice(turso, USER_ID, "reg-B", { id: "device-B", kind: "fid" });
  const todo = await createTodo(fields);
  await dispatchAt(DATE, "10:00");
  assert.equal(shownMessages().filter((m) => m.data?.id === todo.id).length, 2, "the 10:00 reminder reached both devices");
  fake.messages.length = 0;
  return todo;
};

// ── the new time ─────────────────────────────────────────────────────────────

test("the reminder moves N minutes after the later of its time and the current minute", () => {
  const appointment = at(DATE, "15:00");
  const target = (now: Date, minutes: number, zone = VN, from = appointment) =>
    computeSnoozeTarget(from, now, minutes, zone);

  // The example the feature was specified with: due 15:00, snoozed 30 minutes -> 15:30 (seconds do not count).
  for (const seconds of [0, 5, 59]) {
    const result = target(at(DATE, "15:00", seconds), 30);
    assert.deepEqual([result.date, result.time], [DATE, "15:30"], `tapped ${seconds}s after 15:00`);
    assert.equal(result.remindAt.toISOString(), at(DATE, "15:30").toISOString());
  }
  // Tapped late (a nudge, a card that sat in the tray): counted from now, or it would land in the past.
  assert.deepEqual([target(at(DATE, "17:03", 20), 15).date, target(at(DATE, "17:03", 20), 15).time], [DATE, "17:18"]);
  // Not due yet (snoozed from the todo screen): pushed N minutes past its current time.
  assert.equal(target(at(DATE, "14:00"), 30).time, "15:30");
  // Past midnight the date rolls over.
  const late = target(at(DATE, "23:50", 10), 30, VN, at(DATE, "23:50"));
  assert.deepEqual([late.date, late.time], [NEXT, "00:20"]);
  // The full day is the largest snooze: same clock time, next day.
  const day = target(at(DATE, "15:00", 5), SNOOZE.maxMinutes);
  assert.deepEqual([day.date, day.time], [NEXT, "15:00"]);
});

test("the time is computed in the user's zone, not the server's", () => {
  const zone = "America/New_York";
  const appointment = at(DATE, "15:00", 0, zone);
  const result = computeSnoozeTarget(appointment, at(DATE, "15:00", 20, zone), 45, zone);
  assert.deepEqual([result.date, result.time], [DATE, "15:45"]);
  assert.equal(result.remindAt.toISOString(), at(DATE, "15:45", 0, zone).toISOString());
});

// ── REST ─────────────────────────────────────────────────────────────────────

const request = (method: "GET" | "POST", url: string, payload?: object, userId: string | null = USER_ID) =>
  app.inject({
    method,
    url,
    payload,
    headers: userId ? { authorization: `Bearer ${signUserToken(app, userId)}` } : {},
  });

test("POST /todos/:id/snooze moves a 15:00 todo to 15:30 and answers with the new time", async () => {
  const todo = await createTodo({ scheduled_date: FAR, time: "15:00" });

  const response = await request("POST", `/todos/${todo.id}/snooze`, { minutes: 30 });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.todo.id, todo.id);
  assert.equal(body.todo.time, "15:30");
  assert.equal(body.todo.scheduled_date, FAR);
  assert.equal(body.minutes, 30);
  assert.equal(body.remind_at, at(FAR, "15:30").toISOString());
  assert.deepEqual(body.previous, { scheduled_date: FAR, time: "15:00" });
  // Saved, not just echoed: every later read (and the sync) sees it.
  assert.equal((await request("GET", `/todos/${todo.id}`)).json().todo.time, "15:30");
  assert.equal((await request("GET", `/todos/day/${FAR}`)).json().items.find((item: { id: string }) => item.id === todo.id).time, "15:30");
});

test("every preset and any custom number of minutes is accepted; snoozes add up", async () => {
  const todo = await createTodo({ scheduled_date: FAR, time: "08:00" });
  const times: string[] = [];
  for (const minutes of SNOOZE.presetMinutes) {
    const response = await request("POST", `/todos/${todo.id}/snooze`, { minutes });
    assert.equal(response.statusCode, 200, `${minutes} minutes`);
    times.push(response.json().todo.time);
  }
  assert.deepEqual(times, ["08:05", "08:15", "08:30", "09:00", "10:00"]);

  for (const [minutes, expected] of [[7, "10:07"], [1, "10:08"], [90, "11:38"]] as const) {
    const response = await request("POST", `/todos/${todo.id}/snooze`, { minutes });
    assert.equal(response.json().todo.time, expected, `custom ${minutes} minutes`);
  }
  assert.equal((await rowOf(todo.id)).time, "11:38");
});

test("minutes must be a whole number from 1 to a day", async () => {
  const todo = await createTodo({ scheduled_date: FAR, time: "08:00" });
  for (const bad of [0, -5, 1441, 2.5, "30", null, undefined, Number.NaN]) {
    const response = await request("POST", `/todos/${todo.id}/snooze`, { minutes: bad });
    assert.equal(response.statusCode, 400, `minutes = ${String(bad)}`);
    assert.equal(response.json().error, "bad_input");
  }
  assert.equal((await request("POST", `/todos/${todo.id}/snooze`, {})).statusCode, 400);
  assert.equal((await rowOf(todo.id)).time, "08:00", "a rejected request changes nothing");
  assert.ok(SnoozeTodoSchema.safeParse({ minutes: 1 }).success);
  assert.ok(SnoozeTodoSchema.safeParse({ minutes: 1440 }).success);
});

test("a todo that is unknown, someone else's, deleted, finished or has no reminder time cannot be snoozed", async () => {
  const todo = await createTodo({ scheduled_date: FAR, time: "08:00" });
  const snooze = (id: string, userId: string | null = USER_ID) => request("POST", `/todos/${id}/snooze`, { minutes: 5 }, userId);

  assert.equal((await snooze(todo.id, null)).statusCode, 401);
  assert.equal((await snooze("00000000-0000-7000-8000-000000000000")).statusCode, 404);
  assert.equal((await snooze(todo.id, OTHER_USER_ID)).statusCode, 404, "another user's todo looks like it does not exist");
  assert.equal((await rowOf(todo.id)).time, "08:00");

  const done = await createTodo({ scheduled_date: FAR, time: "09:00" });
  await todosService.completeTodo(USER_ID, done.id, {});
  assert.deepEqual([(await snooze(done.id)).statusCode, (await snooze(done.id)).json()], [409, { error: "todo_completed" }]);
  const archived = await createTodo({ scheduled_date: FAR, time: "09:30", status: "archived" });
  assert.deepEqual((await snooze(archived.id)).json(), { error: "todo_completed" });

  const untimed = await createTodo({ scheduled_date: FAR, time: null });
  assert.deepEqual([(await snooze(untimed.id)).statusCode, (await snooze(untimed.id)).json()], [409, { error: "no_reminder" }]);
  const undated = await createTodo({ scheduled_date: null, time: null });
  assert.deepEqual((await snooze(undated.id)).json(), { error: "no_reminder" });
  const sub = await createTodo({ parent_id: todo.id, scheduled_date: null, time: null });
  assert.deepEqual((await snooze(sub.id)).json(), { error: "no_reminder" }, "a subtask has no reminder of its own");

  await todosService.deleteTodo(USER_ID, todo.id);
  assert.equal((await snooze(todo.id)).statusCode, 404);
});

// ── the reminder jobs follow the new time ────────────────────────────────────

test("the delivered reminder is replaced by one at the new time, with its repeat and nudges moved along", async () => {
  const todo = await sentReminder();
  // The on-time send left a +5 min repeat (important+urgent) and the hourly nudges for the old time.
  assert.deepEqual(await jobs(todo.id, "todo_reminder_repeat"), [at(DATE, "10:05").toISOString()]);

  const result = await snoozeTodo(USER_ID, todo.id, { minutes: 30 }, at(DATE, "10:00", 30));
  await cards.flushDismissals();

  assert.equal(result.todo.time, "10:30");
  assert.equal(result.remind_at, at(DATE, "10:30").toISOString());
  assert.deepEqual(await jobs(todo.id, "todo_reminder"), [at(DATE, "10:30").toISOString()], "the sent job is pending again");
  assert.deepEqual(await jobs(todo.id, "todo_reminder_repeat"), [], "the repeat of the old time is gone");
  assert.deepEqual(
    await jobs(todo.id, "todo_overdue"),
    Array.from({ length: 13 }, (_, i) => at(DATE, `${11 + i}:30`).toISOString()),
    "nudges are hourly from the NEW time"
  );

  // It really rings at 10:30, under the same tag (it replaces the card), and then arms its own repeat.
  fake.messages.length = 0;
  await dispatchAt(DATE, "10:30");
  const shown = shownMessages();
  assert.equal(shown.length, 2);
  assert.equal(shown[0].notification?.title, "Nộp báo cáo");
  assert.equal(shown[0].android?.notification?.tag, "todo:" + todo.id);
  assert.equal(dismissMessages().length, 0, "no second dismissal on top of the new card");
  assert.deepEqual(await jobs(todo.id, "todo_reminder_repeat"), [at(DATE, "10:35").toISOString()]);
  assert.deepEqual(await cardKeys(todo.id), [["todo_reminder", `${DATE}T10:30`]]);
});

test("the notification is withdrawn from every device, once, with a short-lived silent message", async () => {
  const todo = await sentReminder();

  const now = at(DATE, "10:00", 30);
  await snoozeTodo(USER_ID, todo.id, { minutes: 30 }, now);
  await cards.flushDismissals();

  const dismiss = dismissMessages();
  assert.equal(dismiss.length, 2, "one per device, not two rounds");
  assert.deepEqual(fake.targets().sort(), ["reg-A", "reg-B"]);
  for (const message of dismiss) {
    assert.equal(message.notification, undefined, "data-only: the system shows nothing");
    assert.deepEqual(message.data, { type: "dismiss", id: todo.id, tag: `todo:${todo.id}`, before: now.toISOString() });
    assert.equal(message.android?.priority, "high");
    assert.equal(message.android?.ttl, 180_000);
  }
  assert.deepEqual(await cardKeys(todo.id), [], "the old card is accounted for");
});

test("a short snooze still removes the card now, and the message expires before the new reminder is due", async () => {
  const todo = await sentReminder();

  // 3 minutes: the new reminder (10:03) is inside the 4-minute window in which an ordinary time edit sends no dismiss.
  await snoozeTodo(USER_ID, todo.id, { minutes: 3 }, at(DATE, "10:00", 30));
  await cards.flushDismissals();
  assert.equal(dismissMessages().length, 2);
  // 10:03:00 is 150 s away: the message lives 135 s (150 s minus the 15 s margin), never longer than the new reminder.
  assert.equal(dismissMessages()[0].android?.ttl, 135_000);

  // 1 minute, tapped 20 s before it is due: shortest lifetime there is.
  fake.messages.length = 0;
  await snoozeTodo(USER_ID, todo.id, { minutes: 1 }, at(DATE, "10:03", 40));
  await cards.flushDismissals();
  assert.equal(dismissMessages().length, 2);
  assert.equal(dismissMessages()[0].android?.ttl, SNOOZE.dismissMinTtlMs);
  assert.equal((await rowOf(todo.id)).time, "10:04");
});

test("the card is removed even when no delivered card was recorded", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await fx.insertDevice(turso, USER_ID, "reg-B", { id: "device-B" });
  const todo = await createTodo();
  assert.deepEqual(await cardKeys(todo.id), [], "nothing was ever sent for this todo");

  await snoozeTodo(USER_ID, todo.id, { minutes: 10 }, at(DATE, "10:00", 5));
  await cards.flushDismissals();

  assert.equal(dismissMessages().length, 2, "the user asked for it; the server cannot know which phone holds a card");
});

test("an ordinary time edit keeps its rules: no dismiss when the next notification replaces the card", async () => {
  const todo = await sentReminder();

  await todosService.updateTodo(USER_ID, todo.id, { time: "10:03" }, { now: at(DATE, "10:00", 30) });
  await cards.flushDismissals();

  assert.equal(dismissMessages().length, 0, "10:03 is within 4 minutes: the new reminder replaces the card itself");
});

test("snoozing a nudge that came hours late counts from now", async () => {
  const todo = await createTodo();

  const result = await snoozeTodo(USER_ID, todo.id, { minutes: 15 }, at(DATE, "12:07", 20));

  assert.equal(result.todo.time, "12:22");
  assert.equal(result.todo.scheduled_date, DATE);
  assert.deepEqual(await jobs(todo.id, "todo_reminder"), [at(DATE, "12:22").toISOString()]);
  assert.deepEqual(
    await jobs(todo.id, "todo_overdue"),
    Array.from({ length: 11 }, (_, i) => at(DATE, `${13 + i}:22`).toISOString())
  );
});

test("a reminder not yet due is pushed back from its own time", async () => {
  const todo = await createTodo({ time: "15:00" });

  const result = await snoozeTodo(USER_ID, todo.id, { minutes: 30 }, at(DATE, "14:00"));

  assert.equal(result.todo.time, "15:30");
  assert.deepEqual(await jobs(todo.id, "todo_reminder"), [at(DATE, "15:30").toISOString()]);
});

test("past midnight the todo moves to the next day", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  const todo = await createTodo({ time: "23:50" });

  const result = await snoozeTodo(USER_ID, todo.id, { minutes: 30 }, at(DATE, "23:50", 10));
  await cards.flushDismissals();

  assert.deepEqual([result.todo.scheduled_date, result.todo.time], [NEXT, "00:20"]);
  assert.deepEqual(result.previous, { scheduled_date: DATE, time: "23:50" });
  assert.deepEqual(await jobs(todo.id, "todo_reminder"), [at(NEXT, "00:20").toISOString()]);
  const [job] = await fx.jobsFor(turso, USER_ID, `AND ref_id = '${todo.id}' AND kind = 'todo_reminder'`);
  assert.equal(job.local_date, NEXT);
  assert.equal(dismissMessages().length, 1);
});

test("an overdue todo snoozed the next day moves to that day", async () => {
  const yesterday = fx.utcDateFromToday(-1);
  await fx.insertTodo(turso, { id: "late", scheduledDate: yesterday, time: "09:00", isImportant: 1, isUrgent: 1 });
  const now = new Date();

  const result = await snoozeTodo(USER_ID, "late", { minutes: 30 }, now);

  const expected = computeSnoozeTarget(at(yesterday, "09:00"), now, 30, VN);
  assert.deepEqual([result.todo.scheduled_date, result.todo.time], [expected.date, expected.time]);
  assert.ok(result.todo.scheduled_date! > yesterday, "it is a reminder for later today, not for yesterday");
  // Yesterday is closed as for any edit of a past-day todo: its snapshot exists before the todo leaves it.
  const closed = await turso.execute({ sql: "SELECT 1 FROM daily_todo_logs WHERE user_id = ? AND log_date = ?", args: [USER_ID, yesterday] });
  assert.ok(closed.rows.length > 0, "the past day was closed first");
});

// ── recurring todos ──────────────────────────────────────────────────────────

test("snoozing one occurrence leaves the series' usual time alone", async () => {
  const root = await createTodo({ time: "08:00", recurrence_type: "daily", recurrence_interval: 1 });

  const result = await snoozeTodo(USER_ID, root.id, { minutes: 30 }, at(DATE, "08:00", 5));

  assert.equal(result.todo.time, "08:30", "today's run is later");
  const series = await turso.execute({ sql: "SELECT time FROM todo_series_reminder_times WHERE series_id = ?", args: [root.id] });
  assert.deepEqual(series.rows.map((row) => row.time), ["08:00"], "the series default stays 08:00");
  const next = (await todosService.completeTodo(USER_ID, root.id, {})).next_recurring_todo!;
  assert.equal(next.scheduled_date, NEXT);
  assert.equal(next.time, "08:00", "tomorrow's run keeps the usual time");
});

test("a generated occurrence can be snoozed the same way", async () => {
  const root = await createTodo({ time: "08:00", recurrence_type: "daily", recurrence_interval: 1 });
  const next = (await todosService.completeTodo(USER_ID, root.id, {})).next_recurring_todo!;

  const result = await snoozeTodo(USER_ID, next.id, { minutes: 15 }, at(NEXT, "08:00", 5));

  assert.equal(result.todo.time, "08:15");
  const after = (await todosService.completeTodo(USER_ID, next.id, {})).next_recurring_todo!;
  assert.equal(after.time, "08:00");
});

test("snoozing a recurring todo past midnight moves only this occurrence and keeps the series time", async () => {
  const root = await createTodo({ time: "23:50", recurrence_type: "daily", recurrence_interval: 1 });

  const result = await snoozeTodo(USER_ID, root.id, { minutes: 30 }, at(DATE, "23:50", 10));

  assert.deepEqual([result.todo.scheduled_date, result.todo.time], [NEXT, "00:20"]);
  const series = await turso.execute({ sql: "SELECT time FROM todo_series_reminder_times WHERE series_id = ?", args: [root.id] });
  assert.deepEqual(series.rows.map((row) => row.time), ["23:50"], "the date change does not turn 00:20 into the series time");
  // The next run is generated from the moved day and goes back to the usual time.
  const next = (await todosService.completeTodo(USER_ID, root.id, {})).next_recurring_todo!;
  assert.deepEqual([next.scheduled_date, next.time], [addDays(NEXT, 1), "23:50"]);
});

test("the REST route removes the card on every device too", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await fx.insertDevice(turso, USER_ID, "reg-B", { id: "device-B", kind: "fid" });
  const todo = await createTodo({ scheduled_date: FAR, time: "15:00" });

  const response = await request("POST", `/todos/${todo.id}/snooze`, { minutes: 30 });
  await cards.flushDismissals();

  assert.equal(response.statusCode, 200);
  assert.equal(dismissMessages().length, 2);
  assert.deepEqual(fake.targets().sort(), ["reg-A", "reg-B"]);
  assert.equal(dismissMessages()[0].data?.tag, `todo:${todo.id}`);
  assert.equal(dismissMessages()[0].android?.ttl, 180_000);

  // A rejected snooze removes nothing.
  fake.messages.length = 0;
  assert.equal((await request("POST", `/todos/${todo.id}/snooze`, { minutes: 0 })).statusCode, 400);
  await cards.flushDismissals();
  assert.equal(dismissMessages().length, 0);
});

test("a recurring todo is not rolled over to a day another occurrence already holds", async () => {
  const root = await createTodo({ time: "23:50", recurrence_type: "daily", recurrence_interval: 1 });
  await createTodo({
    time: "23:50",
    scheduled_date: NEXT,
    recurrence_type: "daily",
    recurrence_interval: 1,
    recurrence_template_id: root.id,
  });

  await assert.rejects(
    snoozeTodo(USER_ID, root.id, { minutes: 30 }, at(DATE, "23:50", 10)),
    (error: unknown) => error instanceof todosService.ServiceError && error.code === "duplicate"
  );
  assert.deepEqual(await rowOf(root.id), { scheduled_date: DATE, time: "23:50", status: "open" });
  // A snooze that stays inside the day is fine.
  const ok = await snoozeTodo(USER_ID, root.id, { minutes: 5 }, at(DATE, "23:50", 10));
  assert.equal(ok.todo.time, "23:55");
});

test("the REST route answers 409 duplicate for that refusal and changes nothing", async () => {
  const root = await createTodo({ scheduled_date: FAR, time: "23:50", recurrence_type: "daily", recurrence_interval: 1 });
  await createTodo({
    scheduled_date: addDays(FAR, 1),
    time: "23:50",
    recurrence_type: "daily",
    recurrence_interval: 1,
    recurrence_template_id: root.id,
  });

  const response = await request("POST", `/todos/${root.id}/snooze`, { minutes: 30 });

  assert.deepEqual([response.statusCode, response.json()], [409, { error: "duplicate" }]);
  assert.deepEqual(await rowOf(root.id), { scheduled_date: FAR, time: "23:50", status: "open" });
});

// ── guards ───────────────────────────────────────────────────────────────────

test("the service reports why a todo cannot be snoozed", async () => {
  const done = await createTodo();
  await todosService.completeTodo(USER_ID, done.id, {});
  await assert.rejects(snoozeTodo(USER_ID, done.id, { minutes: 5 }), (e: unknown) => e instanceof SnoozeError && e.code === "todo_completed");

  const untimed = await createTodo({ time: null });
  await assert.rejects(snoozeTodo(USER_ID, untimed.id, { minutes: 5 }), (e: unknown) => e instanceof SnoozeError && e.code === "no_reminder");

  await assert.rejects(snoozeTodo(USER_ID, "missing", { minutes: 5 }), (e: unknown) => e instanceof todosService.ServiceError && e.code === "not_found");
});

test("a started todo can be snoozed too, and stays started", async () => {
  const todo = await createTodo({ status: "in_progress" });

  const result = await snoozeTodo(USER_ID, todo.id, { minutes: 10 }, at(DATE, "10:00", 5));

  assert.equal(result.todo.time, "10:10");
  assert.equal(result.todo.status, "in_progress");
});

// ── every device sees it ─────────────────────────────────────────────────────

test("another device that already pulled receives the new time in its next delta", async () => {
  const todo = await createTodo({ scheduled_date: FAR, time: "15:00" });
  const cursor = await getSyncCursorTime(); // device B pulled: this is its cursor
  assert.ok(!(await getChangesSince(USER_ID, cursor)).todos.some((row) => row.id === todo.id));

  await snoozeTodo(USER_ID, todo.id, { minutes: 30 });

  const pulled = (await getChangesSince(USER_ID, cursor)).todos.find((row) => row.id === todo.id);
  assert.ok(pulled, "the snoozed todo is in the delta");
  assert.equal(pulled.time, "15:30");
  assert.equal(pulled.scheduled_date, FAR);
  assert.ok(!("synced_at" in pulled), "the stamp is not part of the payload");
});

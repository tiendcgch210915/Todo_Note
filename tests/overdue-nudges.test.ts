import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

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
const { runDispatch, runMaintenance } = await import("../src/services/notification-tick.js");
const nudges = await import("../src/services/overdue-nudges.js");
const dueService = await import("../src/services/checklist-due.js");
const todosService = await import("../src/services/todos.js");
const usersService = await import("../src/services/users.js");
const settingsService = await import("../src/services/notification-settings.js");
const triggers = await import("../src/services/notification-triggers.js");
const schedulesRepo = await import("../src/repositories/checklist-schedules.js");
const timersRepo = await import("../src/repositories/todo-timers.js");
const { getTodoByIdScoped } = await import("../src/repositories/todos.js");
const { processPush } = await import("../src/services/sync.service.js");
const { addDays, localDateOf, localDateTimeToUtc } = await import("../src/utils/time.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID, OTHER_USER_ID } = fx;
const VN = "Asia/Ho_Chi_Minh";
const MINUTE = 60_000;
const TPL = "tst-rời-nhà";

const iso = (d: Date): string => d.toISOString();
const runAtVn = (date: string, hhmm: string): string =>
  localDateTimeToUtc(date, hhmm, VN).toISOString();
const at = (date: string, hhmm: string, seconds = 0, tz = VN): Date =>
  new Date(localDateTimeToUtc(date, hhmm, tz).getTime() + seconds * 1000);

let fake = fx.fakeMessaging();

before(async () => {
  await applyAllMigrations(turso);
});

beforeEach(async () => {
  for (const table of [
    "notification_jobs",
    "todo_timers",
    "notification_settings",
    "user_devices",
    "checklist_schedule_overrides",
    "checklist_schedules",
    "checklist_run_items",
    "checklist_runs",
    "daily_todo_logs",
    "daily_todo_summaries",
    "todo_tags",
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await turso.execute("DELETE FROM checklist_template_items WHERE template_id LIKE 'tst-%'");
  await turso.execute("DELETE FROM checklist_templates WHERE id LIKE 'tst-%'");
  await turso.execute("UPDATE todos SET parent_id = NULL, trigger_after_todo_id = NULL, recurrence_template_id = NULL");
  await turso.execute("DELETE FROM todos");
  await turso.execute(`DELETE FROM users WHERE id IN ('${USER_ID}', '${OTHER_USER_ID}')`);

  await fx.insertUser(turso, USER_ID);
  await fx.insertUser(turso, OTHER_USER_ID);
  await fx.insertTemplateWithItems(turso, { id: TPL, title: "Rời nhà", itemCount: 3 });

  fake = fx.fakeMessaging();
  firebase.setMessagingClientForTests(fake.client);
  firebase.setPushLogger(fx.silentLogger);
});

const overdueRows = (kind = "todo_overdue", userId = USER_ID) =>
  fx.jobsFor(turso, userId, `AND kind = '${kind}'`);
const pendingRunAts = async (kind = "todo_overdue", refId?: string) =>
  (await overdueRows(kind))
    .filter((row) => row.status === "pending" && (refId === undefined || row.ref_id === refId))
    .map((row) => String(row.run_at))
    .sort();
const statusesOf = async (kind = "todo_overdue", refId?: string) =>
  (await overdueRows(kind))
    .filter((row) => refId === undefined || row.ref_id === refId)
    .map((row) => row.status);

const slotsVn = (date: string, hhmms: string[]): string[] => hhmms.map((h) => runAtVn(date, h)).sort();

// ── pure rules ───────────────────────────────────────────────────────────────

const todoFields = (overrides: Partial<Parameters<typeof nudges.todoWantsOverdue>[0]> = {}) => ({
  status: "open",
  parent_id: null,
  time: "10:00",
  scheduled_date: "2026-06-20",
  estimated_minutes: null as number | null,
  is_important: 1 as number | boolean | null,
  is_urgent: 1 as number | boolean | null,
  ...overrides,
});

test("which todos get repeat nudges", () => {
  const wants = (o: Parameters<typeof todoFields>[0] = {}) => nudges.todoWantsOverdue(todoFields(o));

  assert.equal(wants(), true);
  assert.equal(wants({ status: "in_progress" }), true);
  for (const status of ["done", "archived"]) assert.equal(wants({ status }), false, status);
  assert.equal(wants({ parent_id: "parent" }), false, "sub-tasks never carry a time");
  assert.equal(wants({ time: null }), false);
  assert.equal(wants({ scheduled_date: null }), false);

  // estimate: more than 2 hours -> never; exactly 2 hours and unknown -> yes
  assert.equal(wants({ estimated_minutes: 120 }), true);
  assert.equal(wants({ estimated_minutes: 121 }), false);
  assert.equal(wants({ estimated_minutes: 600 }), false);
  assert.equal(wants({ estimated_minutes: 0 }), true);
  assert.equal(wants({ estimated_minutes: null }), true);

  // important+urgent and urgent-only get per-todo nudges; important-only has the 17:00/07:00 digest
  // instead and not-important+not-urgent only gets the on-time reminder; unknown keeps the default.
  const flags: Array<[number | boolean | null, number | boolean | null, boolean]> = [
    [1, 1, true],
    [1, 0, false],
    [0, 1, true],
    [0, 0, false],
    [false, false, false],
    [true, false, false],
    [true, true, true],
    [null, null, true],
    [0, null, true],
    [null, 0, true],
    [null, false, true],
  ];
  for (const [important, urgent, expected] of flags) {
    assert.equal(
      wants({ is_important: important, is_urgent: urgent }),
      expected,
      `important=${important} urgent=${urgent}`
    );
  }
});

const localTimes = (slots: Date[], tz = VN): string[] =>
  slots.map((slot) => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(slot);
    return parts;
  });

test("slots are the appointment time + 2h, 4h, ... until the end of that local day", () => {
  const slots = (date: string, hhmm: string, tz = VN) =>
    localTimes(nudges.overdueSlots(localDateTimeToUtc(date, hhmm, tz), date, tz), tz);

  assert.deepEqual(slots("2026-06-20", "10:00"), ["12:00", "14:00", "16:00", "18:00", "20:00", "22:00"]);
  assert.deepEqual(slots("2026-06-20", "09:30"), ["11:30", "13:30", "15:30", "17:30", "19:30", "21:30", "23:30"]);
  assert.deepEqual(slots("2026-06-20", "21:59"), ["23:59"], "the last minute of the day still counts");
  assert.deepEqual(slots("2026-06-20", "22:00"), [], "22:00 + 2h is already tomorrow");
  assert.deepEqual(slots("2026-06-20", "23:30"), []);
  assert.equal(slots("2026-06-20", "00:00").length, 11);
  assert.deepEqual(slots("2026-06-20", "08:00", "Pacific/Auckland"), ["10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00"]);
});

test("slots stay on the same local day across daylight-saving changes", () => {
  const tz = "America/New_York";
  // 2026-11-01: clocks go back, the day is 25 hours long.
  const fallBack = nudges.overdueSlots(localDateTimeToUtc("2026-11-01", "00:30", tz), "2026-11-01", tz);
  assert.equal(fallBack.length, 12);
  for (const slot of fallBack) assert.equal(localDateOf(slot, tz), "2026-11-01");
  // 2026-03-08: clocks go forward, the day is 23 hours long.
  const springForward = nudges.overdueSlots(localDateTimeToUtc("2026-03-08", "00:30", tz), "2026-03-08", tz);
  assert.equal(springForward.length, 11);
  for (const slot of springForward) assert.equal(localDateOf(slot, tz), "2026-03-08");
});

test("only the real slots of the current appointment time are valid", () => {
  const date = "2026-06-20";
  const scheduledAt = at(date, "10:00");
  const valid = (hhmm: string, d = date) => nudges.isOverdueSlot(scheduledAt, at(d, hhmm), date, VN);

  for (const hhmm of ["12:00", "14:00", "22:00"]) assert.equal(valid(hhmm), true, hhmm);
  assert.equal(valid("10:00"), false, "the appointment itself is the normal reminder, not a nudge");
  assert.equal(valid("11:00"), false, "not a multiple of 2h");
  assert.equal(valid("12:01"), false);
  assert.equal(valid("09:00"), false, "before the appointment");
  assert.equal(valid("00:00", "2026-06-21"), false, "after midnight is another day");
  assert.equal(nudges.isOverdueSlot(at(date, "11:00"), at(date, "12:00"), date, VN), false, "time was edited");
});

test("a slot is still creatable for 30 minutes after it was due, never later", () => {
  const slot = at("2026-06-20", "12:00");
  const create = (secondsAfter: number) =>
    nudges.creatableOverdueSlots([slot], "todo_overdue", new Date(slot.getTime() + secondsAfter * 1000)).length;
  assert.equal(create(-3600), 1, "future slots are kept");
  assert.equal(create(0), 1);
  assert.equal(create(30 * 60), 1);
  assert.equal(create(30 * 60 + 1), 0);
});

// ── todo hooks (real services) ───────────────────────────────────────────────

const DATE = fx.utcDateFromToday(3);
type CreateInput = Parameters<typeof todosService.createTodo>[1];
const makeTodo = async (input: CreateInput) => (await todosService.createTodo(USER_ID, input)).todo;
const EVEN_SLOTS = ["12:00", "14:00", "16:00", "18:00", "20:00", "22:00"];

test("an urgent (not important) todo at 10:00 gets pending nudges at 12, 14, 16, 18, 20 and 22", async () => {
  const todo = await makeTodo({ title: "Nộp báo cáo", scheduled_date: DATE, time: "10:00", is_important: false, is_urgent: true });

  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), slotsVn(DATE, EVEN_SLOTS));
  const rows = await overdueRows();
  for (const row of rows) {
    assert.equal(row.local_date, DATE);
    assert.equal(row.target_device_id, null, "nudges go to every device");
  }
});

test("eligibility: unclassified, important+urgent, urgent-only and small estimates are nudged; the rest are not", async () => {
  const cases: Array<[string, CreateInput, boolean]> = [
    ["unclassified", { title: "a", scheduled_date: DATE, time: "10:00" }, true],
    ["urgent only", { title: "b", scheduled_date: DATE, time: "10:00", is_important: false, is_urgent: true }, true],
    ["important and urgent", { title: "b2", scheduled_date: DATE, time: "10:00", is_important: true, is_urgent: true }, true],
    ["important only (has the digest instead)", { title: "b3", scheduled_date: DATE, time: "10:00", is_important: true, is_urgent: false }, false],
    ["estimate exactly 120", { title: "c", scheduled_date: DATE, time: "10:00", estimated_minutes: 120 }, true],
    ["estimate 121", { title: "d", scheduled_date: DATE, time: "10:00", estimated_minutes: 121 }, false],
    ["not important, not urgent", { title: "e", scheduled_date: DATE, time: "10:00", is_important: false, is_urgent: false }, false],
    ["no time", { title: "f", scheduled_date: DATE }, false],
    ["no date", { title: "g", time: null }, false],
    ["too late in the day", { title: "h", scheduled_date: DATE, time: "22:00" }, false],
  ];
  for (const [label, input, expected] of cases) {
    const todo = await makeTodo(input);
    const rows = (await overdueRows()).filter((row) => row.ref_id === todo.id);
    assert.equal(rows.length > 0, expected, label);
  }
});

test("changing the time moves the nudges; clearing it, the estimate or the priority cancels them", async () => {
  const todo = await makeTodo({ title: "A", scheduled_date: DATE, time: "10:00", is_important: true });
  assert.equal((await pendingRunAts("todo_overdue", todo.id)).length, 6);

  await todosService.updateTodo(USER_ID, todo.id, { time: "11:00" });
  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), slotsVn(DATE, ["13:00", "15:00", "17:00", "19:00", "21:00", "23:00"]));
  assert.ok((await statusesOf("todo_overdue", todo.id)).includes("cancelled"), "the old slots are cancelled");

  await todosService.updateTodo(USER_ID, todo.id, { estimated_minutes: 180 });
  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), []);
  await todosService.updateTodo(USER_ID, todo.id, { estimated_minutes: 60 });
  assert.equal((await pendingRunAts("todo_overdue", todo.id)).length, 6, "a smaller estimate brings them back");

  await todosService.updateTodo(USER_ID, todo.id, { is_important: false, is_urgent: false });
  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), []);
  await todosService.updateTodo(USER_ID, todo.id, { is_urgent: true });
  assert.equal((await pendingRunAts("todo_overdue", todo.id)).length, 6);

  await todosService.updateTodo(USER_ID, todo.id, { time: null });
  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), []);

  const rows = await overdueRows();
  const keys = rows.map((row) => `${row.ref_id}|${row.run_at}`);
  assert.equal(new Set(keys).size, keys.length, "one row per slot, never duplicates");
});

test("completing, deleting or moving the todo stops the nudges; un-completing brings them back", async () => {
  const todo = await makeTodo({ title: "A", scheduled_date: DATE, time: "10:00", is_important: true });

  await todosService.completeTodo(USER_ID, todo.id, {});
  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), []);
  await todosService.uncompleteTodo(USER_ID, todo.id);
  assert.equal((await pendingRunAts("todo_overdue", todo.id)).length, 6);

  const other = addDays(DATE, 2);
  await todosService.moveToDay(USER_ID, todo.id, { date: other });
  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), slotsVn(other, EVEN_SLOTS));
  const moved = (await overdueRows()).filter((row) => row.status === "pending");
  assert.ok(moved.every((row) => row.local_date === other));

  await todosService.moveToDay(USER_ID, todo.id, { date: null });
  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), []);

  // Moving to "no day" also clears the time, so a day alone brings nothing back ...
  await todosService.moveToDay(USER_ID, todo.id, { date: DATE });
  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), []);
  // ... until the todo has a time again.
  await todosService.updateTodo(USER_ID, todo.id, { time: "10:00" });
  assert.equal((await pendingRunAts("todo_overdue", todo.id)).length, 6);
  await todosService.deleteTodo(USER_ID, todo.id);
  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), []);
});

test("editing an unrelated field after a nudge was sent does not send it again", async () => {
  const todo = await makeTodo({ title: "A", scheduled_date: DATE, time: "10:00", is_important: true });
  const first = slotsVn(DATE, ["12:00"])[0];
  await turso.execute({
    sql: "UPDATE notification_jobs SET status = 'sent', sent_at = ?, attempts = 1 WHERE ref_id = ? AND run_at = ?",
    args: ["2026-06-20T05:00:00.000Z", todo.id, first],
  });

  await todosService.updateTodo(USER_ID, todo.id, { title: "Đổi tên" });

  const row = (await overdueRows()).find((r) => r.run_at === first);
  assert.equal(row?.status, "sent");
  assert.equal((await pendingRunAts("todo_overdue", todo.id)).length, 5);
});

test("a recurring series: the next occurrence gets its own nudges", async () => {
  const root = await makeTodo({
    title: "Uống thuốc",
    scheduled_date: DATE,
    time: "08:00",
    is_important: true,
    recurrence_type: "daily",
    recurrence_interval: 1,
  });
  const result = await todosService.completeTodo(USER_ID, root.id, {});
  const next = result.next_recurring_todo;
  assert.ok(next);

  assert.deepEqual(await pendingRunAts("todo_overdue", root.id), []);
  assert.deepEqual(
    await pendingRunAts("todo_overdue", next.id),
    slotsVn(addDays(DATE, 1), ["10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00"])
  );
});

test("sync push arms, re-times and cancels the nudges the same way", async () => {
  const id = "sync-todo-1";
  const stamp = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();
  await processPush(USER_ID, [
    { op: "create", type: "todo", payload: { id, title: "Từ máy khác", status: "open", position: 0, scheduled_date: DATE, time: "10:00", is_important: true, created_at: stamp(), updated_at: stamp() } },
  ]);
  assert.equal((await pendingRunAts("todo_overdue", id)).length, 6);

  await processPush(USER_ID, [{ op: "update", type: "todo", payload: { id, time: "12:00", updated_at: stamp(1000) } }]);
  assert.deepEqual(await pendingRunAts("todo_overdue", id), slotsVn(DATE, ["14:00", "16:00", "18:00", "20:00", "22:00"]));

  await processPush(USER_ID, [{ op: "update", type: "todo", payload: { id, status: "done", updated_at: stamp(2000) } }]);
  assert.deepEqual(await pendingRunAts("todo_overdue", id), []);
});

test("changing the time zone re-times the nudges of upcoming todos", async () => {
  const todo = await makeTodo({ title: "A", scheduled_date: DATE, time: "10:00", is_important: true });
  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), slotsVn(DATE, EVEN_SLOTS));

  await usersService.updateUserProfile(USER_ID, { timezone: "America/New_York" });

  const expected = EVEN_SLOTS.map((h) => localDateTimeToUtc(DATE, h, "America/New_York").toISOString()).sort();
  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), expected);
});

test("changing the time zone through the settings API re-times them too", async () => {
  const todo = await makeTodo({ title: "A", scheduled_date: DATE, time: "10:00", is_important: true });

  await settingsService.updateNotificationSettings(USER_ID, {
    morningTime: "07:00",
    eveningTime: "17:00",
    timezone: "Pacific/Auckland",
  });

  const expected = EVEN_SLOTS.map((h) => localDateTimeToUtc(DATE, h, "Pacific/Auckland").toISOString()).sort();
  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), expected);
});

// ── reconcile with a fixed clock ─────────────────────────────────────────────

const TODAY = "2026-06-20";

const todoRow = async (id: string) => {
  const row = await getTodoByIdScoped(id, USER_ID);
  assert.ok(row);
  return row;
};

test("only slots that are in the future or at most 30 minutes late are created", async () => {
  await fx.insertTodo(turso, { id: "t1", scheduledDate: TODAY, time: "10:00", isImportant: 0, isUrgent: 1 });

  // 14:20: the 12:00 slot is long gone, 14:00 is 20 minutes late, 16:00 and later are ahead.
  await nudges.reconcileTodoOverdue(USER_ID, await todoRow("t1"), VN, at(TODAY, "14:20"));
  assert.deepEqual(await pendingRunAts("todo_overdue", "t1"), slotsVn(TODAY, ["14:00", "16:00", "18:00", "20:00", "22:00"]));

  // 14:31: 14:00 is now more than 30 minutes late, so a fresh reconcile drops it.
  await nudges.reconcileTodoOverdue(USER_ID, await todoRow("t1"), VN, at(TODAY, "14:31"));
  assert.deepEqual(await pendingRunAts("todo_overdue", "t1"), slotsVn(TODAY, ["16:00", "18:00", "20:00", "22:00"]));
});

// ── planner / backfill ───────────────────────────────────────────────────────

const maintenance = (now: Date) => runMaintenance({ now, logger: fx.silentLogger });

test("the tick creates the nudges of existing todos that never got any, once", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await fx.insertTodo(turso, { id: "t1", scheduledDate: TODAY, time: "10:00", isImportant: 0, isUrgent: 1 });

  const first = await maintenance(at(TODAY, "09:00"));
  assert.equal(first.overdue_backfilled, 6);
  assert.deepEqual(await pendingRunAts("todo_overdue", "t1"), slotsVn(TODAY, EVEN_SLOTS));

  const second = await maintenance(at(TODAY, "09:01"));
  assert.equal(second.overdue_backfilled, 0, "idempotent");
  assert.equal((await overdueRows()).length, 6);
});

test("backfill skips todos that are not eligible and users without a device", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  const base = { scheduledDate: TODAY, time: "10:00", isImportant: 0, isUrgent: 1 };
  await fx.insertTodo(turso, { id: "ok", ...base });
  await fx.insertTodo(turso, { id: "important-only", ...base, isImportant: 1, isUrgent: 0 });
  await fx.insertTodo(turso, { id: "done", ...base, status: "done" });
  await fx.insertTodo(turso, { id: "sub", ...base, parentId: "ok" });
  await fx.insertTodo(turso, { id: "big", ...base, estimatedMinutes: 240 });
  await fx.insertTodo(turso, { id: "q4", ...base, isImportant: 0, isUrgent: 0 });
  await fx.insertTodo(turso, { id: "late", ...base, time: "22:30" });
  await fx.insertTodo(turso, { id: "no-time", ...base, time: null });
  await fx.insertTodo(turso, { id: "deleted", ...base, deletedAt: "2026-06-01T00:00:00.000Z" });
  await fx.insertTodo(turso, { id: "nobody", ...base, userId: OTHER_USER_ID });

  await maintenance(at(TODAY, "09:00"));

  // "late" (22:30) is scanned but has no slot left for a 2-hour todo: only a 'missed' marker.
  const live = (await overdueRows()).filter((row) => row.status !== "missed");
  assert.deepEqual([...new Set(live.map((row) => row.ref_id))], ["ok"]);
  assert.deepEqual(
    (await overdueRows()).filter((row) => row.status === "missed").map((row) => row.ref_id),
    ["late"]
  );
  assert.equal((await overdueRows("todo_overdue", OTHER_USER_ID)).length, 0);
});

test("a todo whose slots are all too late gets one 'missed' marker so it is not rescanned forever", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await fx.insertTodo(turso, { id: "t1", scheduledDate: TODAY, time: "08:00", isImportant: 1 });

  const first = await maintenance(at(TODAY, "23:00"));
  assert.equal(first.overdue_backfilled, 0);
  const rows = await overdueRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "missed");

  await maintenance(at(TODAY, "23:01"));
  assert.equal((await overdueRows()).length, 1, "no new rows on the next scan");
  assert.equal(fake.messages.length, 0);
});

test("a candidate scan cannot be starved by todos that have no slot left", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  for (let i = 0; i < 3; i++) {
    await fx.insertTodo(turso, { id: `a-old-${i}`, scheduledDate: TODAY, time: "08:00", isImportant: 1 });
  }
  await fx.insertTodo(turso, { id: "z-new", scheduledDate: TODAY, time: "21:00", isImportant: 1 });

  await maintenance(at(TODAY, "21:10"));

  assert.deepEqual(await pendingRunAts("todo_overdue", "z-new"), [runAtVn(TODAY, "23:00")]);
});

// ── sending ──────────────────────────────────────────────────────────────────

const armTodo = async (overrides: Partial<Parameters<typeof fx.insertTodo>[1]> = {}) => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await fx.insertDevice(turso, USER_ID, "reg-B", { id: "device-B", kind: "fid" });
  await fx.insertTodo(turso, { id: "t1", title: "Nộp báo cáo", scheduledDate: TODAY, time: "10:00", isImportant: 0, isUrgent: 1, ...overrides });
  await maintenance(at(TODAY, "09:00"));
  assert.equal((await pendingRunAts("todo_overdue", "t1")).length, 6);
};

const dispatchAt = (date: string, hhmm: string, seconds = 10) =>
  runDispatch({ now: at(date, hhmm, seconds), logger: fx.silentLogger });
const overdueMessages = () => fake.messages.filter((m) => /Quá giờ/.test(m.notification?.body ?? ""));

test("the 12:00 nudge reaches every device with the todo title, the missed time and what to do", async () => {
  await armTodo();

  await dispatchAt(TODAY, "12:00");

  const messages = overdueMessages();
  assert.deepEqual(fake.targets().sort(), ["reg-A", "reg-B"]);
  assert.equal(messages.length, 2);
  const [message] = messages;
  assert.equal(message.notification?.title, "Nộp báo cáo");
  assert.equal(message.notification?.body, "⏰ Quá giờ 10:00 · Làm ngay hoặc dời lịch!");
  assert.deepEqual(message.data, { type: "todo", id: "t1", date: TODAY });
  assert.equal(message.android?.priority, "high");
  assert.equal(message.android?.ttl, 3_600_000);
  assert.equal(message.android?.notification?.channelId, "todo_reminders");
  for (const value of Object.values(message.data ?? {})) assert.equal(typeof value, "string");
});

test("it repeats every 2 hours until the end of the day, one push per slot", async () => {
  await armTodo();

  for (const hhmm of EVEN_SLOTS) await dispatchAt(TODAY, hhmm);

  assert.equal(overdueMessages().length, 6 * 2, "six slots, two devices");
  assert.deepEqual(
    (await overdueRows()).map((row) => row.status),
    ["sent", "sent", "sent", "sent", "sent", "sent"]
  );
  await dispatchAt(TODAY, "23:30");
  assert.equal(overdueMessages().length, 12, "nothing more after the last slot");
});

test("a repeated fast beat does not send the same slot twice", async () => {
  await armTodo();
  await dispatchAt(TODAY, "12:00");
  await dispatchAt(TODAY, "12:00", 13);
  await dispatchAt(TODAY, "12:05");
  assert.equal(overdueMessages().length, 2);
});

test("a slot missed while the server was down is skipped, and the next slot is unaffected", async () => {
  await armTodo();

  await dispatchAt(TODAY, "12:40"); // 40 minutes after the 12:00 slot
  assert.equal(overdueMessages().length, 0);
  assert.equal((await overdueRows()).find((r) => r.run_at === runAtVn(TODAY, "12:00"))?.status, "missed");

  await dispatchAt(TODAY, "14:00");
  assert.equal(overdueMessages().length, 2, "the 14:00 nudge still goes out");
});

const invalidations: Array<[string, () => Promise<unknown>]> = [
  ["the todo is done", () => turso.execute("UPDATE todos SET status = 'done' WHERE id = 't1'")],
  ["the todo is archived", () => turso.execute("UPDATE todos SET status = 'archived' WHERE id = 't1'")],
  ["the todo was deleted", () => turso.execute("UPDATE todos SET deleted_at = '2026-06-20T01:00:00.000Z' WHERE id = 't1'")],
  ["the estimate grew beyond 2 hours", () => turso.execute("UPDATE todos SET estimated_minutes = 180 WHERE id = 't1'")],
  ["it became not important and not urgent", () => turso.execute("UPDATE todos SET is_important = 0, is_urgent = 0 WHERE id = 't1'")],
  ["the time was edited", () => turso.execute("UPDATE todos SET time = '09:00' WHERE id = 't1'")],
  ["the todo was moved to another day", () => turso.execute({ sql: "UPDATE todos SET scheduled_date = ? WHERE id = 't1'", args: ["2026-06-21"] })],
  ["the todo lost its time", () => turso.execute("UPDATE todos SET time = NULL WHERE id = 't1'")],
  ["the user was disabled", () => turso.execute({ sql: "UPDATE users SET deleted_at = ? WHERE id = ?", args: ["2026-06-20T01:00:00.000Z", USER_ID] })],
  [
    "the countdown timer is running",
    () =>
      timersRepo.upsertTimer({
        todo_id: "t1",
        user_id: USER_ID,
        status: "running",
        estimated_seconds: 1500,
        remaining_seconds: 1500,
        ends_at: "2026-06-20T06:00:00.000Z",
        device_id: "device-A",
        last_client_event_at: "2026-06-20T05:30:00.000Z",
      }),
  ],
];

for (const [label, mutate] of invalidations) {
  test(`re-validation right before sending: nothing is sent when ${label}`, async () => {
    await armTodo();
    await mutate();

    await dispatchAt(TODAY, "12:00");

    assert.equal(overdueMessages().length, 0);
    assert.equal((await overdueRows()).find((r) => r.run_at === runAtVn(TODAY, "12:00"))?.status, "cancelled");
  });
}

test("a paused countdown does not suppress the nudge", async () => {
  await armTodo();
  await timersRepo.upsertTimer({
    todo_id: "t1",
    user_id: USER_ID,
    status: "paused",
    estimated_seconds: 1500,
    remaining_seconds: 900,
    ends_at: null,
    device_id: "device-A",
    last_client_event_at: "2026-06-20T05:30:00.000Z",
  });
  await dispatchAt(TODAY, "12:00");
  assert.equal(overdueMessages().length, 2);
});

test("a running timer only skips the slot it overlaps; a later slot is judged on its own", async () => {
  await armTodo();
  await timersRepo.upsertTimer({
    todo_id: "t1",
    user_id: USER_ID,
    status: "running",
    estimated_seconds: 1500,
    remaining_seconds: 1500,
    ends_at: "2026-06-20T06:00:00.000Z",
    device_id: "device-A",
    last_client_event_at: "2026-06-20T05:00:00.000Z",
  });
  await dispatchAt(TODAY, "12:00");
  assert.equal(overdueMessages().length, 0);

  await timersRepo.resetTimerIdle("t1");
  await dispatchAt(TODAY, "14:00");
  assert.equal(overdueMessages().length, 2);
});

test("an unclassified todo still gets the same short message", async () => {
  await armTodo({ isImportant: null, isUrgent: null });
  await dispatchAt(TODAY, "12:00");
  assert.equal(overdueMessages()[0].notification?.body, "⏰ Quá giờ 10:00 · Làm ngay hoặc dời lịch!");
});

test("a long multi-line title is normalised like the other pushes", async () => {
  await armTodo({ title: `Dòng một\n\n  dòng   hai ${"x".repeat(100)}` });
  await dispatchAt(TODAY, "12:00");
  const title = overdueMessages()[0].notification?.title ?? "";
  assert.ok(Array.from(title).length <= 60);
  assert.ok(title.endsWith("…"));
  assert.doesNotMatch(title, /\n/);
  assert.ok(title.startsWith("Dòng một dòng hai"));
});

test("nothing is sent when push is turned off by the tick (dry run still records the slot)", async () => {
  await armTodo();
  const summary = await runDispatch({ now: at(TODAY, "12:00", 10), dryRun: true, logger: fx.silentLogger });
  assert.equal(summary.sent, 1);
  assert.equal(fake.messages.length, 0, "dry run never talks to FCM");
});

// ── checklists ───────────────────────────────────────────────────────────────

type ScheduleFields = Parameters<typeof schedulesRepo.upsertSchedule>[2];
const scheduleAt = (hhmm: string, overrides: Partial<ScheduleFields> = {}): ScheduleFields => ({
  start_date: TODAY,
  time: hhmm,
  recurrence_type: "daily",
  recurrence_interval: 1,
  recurrence_days_of_week: null,
  recurrence_end_date: null,
  enabled: true,
  ...overrides,
});
const CHECKLIST_SLOTS = ["09:30", "11:30", "13:30", "15:30", "17:30", "19:30", "21:30", "23:30"];
const checklistRunAts = () => pendingRunAts("checklist_overdue", TPL);
const reconcile = (now: Date) => dueService.reconcileChecklistDue(USER_ID, TPL, now);

test("a checklist scheduled for 07:30 gets nudges at 09:30 ... 23:30, for today only", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, TPL, scheduleAt("07:30"));

  await reconcile(at(TODAY, "07:00"));

  assert.deepEqual(await checklistRunAts(), slotsVn(TODAY, CHECKLIST_SLOTS));
  const rows = await overdueRows("checklist_overdue");
  assert.ok(rows.every((row) => row.local_date === TODAY && row.ref_id === TPL), "tomorrow has none yet");
});

test("the nudges start from the appointment even when its normal reminder is long gone", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, TPL, scheduleAt("07:30"));

  // 12:00: the 11:30 slot is exactly 30 minutes late (kept), 09:30 is not.
  await reconcile(at(TODAY, "12:00"));

  assert.deepEqual(await checklistRunAts(), slotsVn(TODAY, ["11:30", "13:30", "15:30", "17:30", "19:30", "21:30", "23:30"]));
  assert.equal((await fx.jobsFor(turso, USER_ID, "AND kind = 'checklist_due'")).filter((j) => j.local_date === TODAY).length, 0, "the on-time reminder itself is too late to create");
});

test("an override moves the nudges with the day's time; a completed run today removes them", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, TPL, scheduleAt("07:30"));
  await reconcile(at(TODAY, "07:00"));

  await schedulesRepo.upsertOverride(USER_ID, TPL, TODAY, "09:00");
  await reconcile(at(TODAY, "07:00"));
  assert.deepEqual(await checklistRunAts(), slotsVn(TODAY, ["11:00", "13:00", "15:00", "17:00", "19:00", "21:00", "23:00"]));

  await fx.insertRun(turso, { id: "run-1", templateId: TPL, completedAt: iso(at(TODAY, "10:00")) });
  await reconcile(at(TODAY, "10:05"));
  assert.deepEqual(await checklistRunAts(), []);
  assert.ok((await statusesOf("checklist_overdue", TPL)).every((s) => s === "cancelled"));
});

test("abandoned and in-progress runs do not stop the nudges", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, TPL, scheduleAt("07:30"));
  await fx.insertRun(turso, { id: "run-a", templateId: TPL, status: "abandoned", completedAt: iso(at(TODAY, "08:00")) });
  await fx.insertRun(turso, { id: "run-b", templateId: TPL, status: "in_progress", completedAt: null });

  await reconcile(at(TODAY, "08:30"));

  assert.equal((await checklistRunAts()).length, 8, "09:30 ... 23:30");
});

test("no nudges for a disabled or deleted schedule, or a deleted checklist", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, TPL, scheduleAt("07:30"));
  await reconcile(at(TODAY, "07:00"));
  assert.equal((await checklistRunAts()).length, 8);

  await schedulesRepo.upsertSchedule(USER_ID, TPL, scheduleAt("07:30", { enabled: false }));
  await reconcile(at(TODAY, "07:01"));
  assert.deepEqual(await checklistRunAts(), []);

  await schedulesRepo.upsertSchedule(USER_ID, TPL, scheduleAt("07:30"));
  await reconcile(at(TODAY, "07:02"));
  assert.equal((await checklistRunAts()).length, 8, "re-enabling re-arms the same slots");

  await schedulesRepo.softDeleteSchedule(USER_ID, TPL);
  await reconcile(at(TODAY, "07:03"));
  assert.deepEqual(await checklistRunAts(), []);
});

test("a schedule that does not occur today has no nudges (weekday, start date, end date)", async () => {
  // 2026-06-20 is a Saturday (6).
  await schedulesRepo.upsertSchedule(USER_ID, TPL, scheduleAt("07:30", { recurrence_type: "weekly", recurrence_days_of_week: "1,3", start_date: "2026-06-15" }));
  await reconcile(at(TODAY, "07:00"));
  assert.deepEqual(await checklistRunAts(), []);

  await schedulesRepo.upsertSchedule(USER_ID, TPL, scheduleAt("07:30", { start_date: "2026-06-25" }));
  await reconcile(at(TODAY, "07:00"));
  assert.deepEqual(await checklistRunAts(), []);

  await schedulesRepo.upsertSchedule(USER_ID, TPL, scheduleAt("07:30", { start_date: "2026-06-01", recurrence_end_date: "2026-06-19" }));
  await reconcile(at(TODAY, "07:00"));
  assert.deepEqual(await checklistRunAts(), []);
});

test("a late-evening appointment has no nudges because 2 hours later is tomorrow", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, TPL, scheduleAt("22:30"));
  await reconcile(at(TODAY, "07:00"));
  assert.deepEqual(await checklistRunAts(), []);
});

test("the planner creates the checklist nudges too, once, and writes nothing in steady state", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await schedulesRepo.upsertSchedule(USER_ID, TPL, scheduleAt("07:30"));

  const first = await maintenance(at(TODAY, "07:00"));
  assert.deepEqual(await checklistRunAts(), slotsVn(TODAY, CHECKLIST_SLOTS));
  assert.ok(first.planned >= 8);

  const originalExecute = turso.execute.bind(turso);
  const writes: string[] = [];
  (turso as { execute: unknown }).execute = (statement: unknown) => {
    const sql = typeof statement === "object" && statement ? String((statement as { sql?: string }).sql) : String(statement);
    // Housekeeping UPDATEs (stuck jobs, missed sweep) run every beat; the planner must INSERT nothing.
    if (/^\s*INSERT/i.test(sql) && /notification_jobs/.test(sql)) writes.push(sql);
    return originalExecute(statement as never);
  };
  try {
    await maintenance(at(TODAY, "07:01"));
  } finally {
    (turso as { execute: unknown }).execute = originalExecute;
  }
  assert.deepEqual(writes, []);
});

test("the planner does not undo a cancellation: a completed run keeps its nudges cancelled", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await schedulesRepo.upsertSchedule(USER_ID, TPL, scheduleAt("07:30"));
  await maintenance(at(TODAY, "07:00"));
  await fx.insertRun(turso, { id: "run-1", templateId: TPL, completedAt: iso(at(TODAY, "08:00")) });
  await reconcile(at(TODAY, "08:01"));

  await maintenance(at(TODAY, "08:02"));
  await maintenance(at(TODAY, "08:03"));

  assert.deepEqual(await checklistRunAts(), []);
});

const armChecklist = async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await fx.insertDevice(turso, USER_ID, "reg-B", { id: "device-B", kind: "fid" });
  await schedulesRepo.upsertSchedule(USER_ID, TPL, scheduleAt("07:30"));
  await reconcile(at(TODAY, "07:00"));
};

test("the checklist nudge reaches every device with the checklist title and the missed time", async () => {
  await armChecklist();

  await dispatchAt(TODAY, "09:30");

  const messages = overdueMessages();
  assert.deepEqual(fake.targets().sort(), ["reg-A", "reg-B"]);
  const [message] = messages;
  assert.equal(message.notification?.title, "Rời nhà");
  assert.equal(message.notification?.body, "⏰ Quá giờ 07:30 · Làm ngay hoặc dời lịch!");
  assert.deepEqual(message.data, { type: "checklist_due", id: TPL, date: TODAY });
  assert.equal(message.android?.priority, "high");
  assert.equal(message.android?.ttl, 3_600_000);
  assert.equal(message.android?.notification?.channelId, "checklist_reminders");
});

test("the body shows the overridden time of that day", async () => {
  await armChecklist();
  await schedulesRepo.upsertOverride(USER_ID, TPL, TODAY, "09:00");
  await reconcile(at(TODAY, "07:01"));

  await dispatchAt(TODAY, "11:00");

  assert.equal(overdueMessages()[0].notification?.body, "⏰ Quá giờ 09:00 · Làm ngay hoặc dời lịch!");
});

const checklistInvalidations: Array<[string, () => Promise<unknown>]> = [
  ["the schedule was turned off", () => turso.execute("UPDATE checklist_schedules SET enabled = 0")],
  ["the schedule was deleted", () => turso.execute("UPDATE checklist_schedules SET deleted_at = '2026-06-20T01:00:00.000Z'")],
  ["the checklist was deleted", () => turso.execute({ sql: "UPDATE checklist_templates SET deleted_at = '2026-06-20T01:00:00.000Z' WHERE id = ?", args: [TPL] })],
  ["a run was completed today", () => fx.insertRun(turso, { id: "run-1", templateId: TPL, completedAt: iso(at(TODAY, "08:00")) })],
  ["the time of the day was overridden", () => schedulesRepo.upsertOverride(USER_ID, TPL, TODAY, "09:00")],
  ["the schedule time changed", () => turso.execute("UPDATE checklist_schedules SET time = '08:00'")],
  ["the schedule now ended yesterday", () => turso.execute("UPDATE checklist_schedules SET start_date = '2026-06-10', recurrence_end_date = '2026-06-19'")],
  ["the user was disabled", () => turso.execute({ sql: "UPDATE users SET deleted_at = ? WHERE id = ?", args: ["2026-06-20T01:00:00.000Z", USER_ID] })],
];

for (const [label, mutate] of checklistInvalidations) {
  test(`checklist re-validation right before sending: nothing is sent when ${label}`, async () => {
    await armChecklist();
    await mutate();

    await dispatchAt(TODAY, "09:30");

    assert.equal(overdueMessages().length, 0);
    assert.equal((await overdueRows("checklist_overdue")).find((r) => r.run_at === runAtVn(TODAY, "09:30"))?.status, "cancelled");
  });
}

test("a run completed between two slots stops the rest of the day", async () => {
  await armChecklist();
  await dispatchAt(TODAY, "09:30");
  assert.equal(overdueMessages().length, 2);

  await fx.insertRun(turso, { id: "run-1", templateId: TPL, completedAt: iso(at(TODAY, "10:00")) });
  await triggers.onChecklistRunChanged(USER_ID, "run-1");

  for (const hhmm of CHECKLIST_SLOTS.slice(1)) await dispatchAt(TODAY, hhmm);
  assert.equal(overdueMessages().length, 2, "still only the first one");
});

test("the run-completion hook cancels pending checklist nudges", async () => {
  // Real clock on purpose: rows for the real today, then a run completed right now.
  const today = localDateOf(new Date(), VN);
  await schedulesRepo.upsertSchedule(USER_ID, TPL, scheduleAt("00:30", { start_date: today }));
  await turso.execute({
    sql: `INSERT INTO notification_jobs (id, user_id, kind, ref_id, local_date, run_at, status, attempts, created_at)
          VALUES ('n1', ?, 'checklist_overdue', ?, ?, ?, 'pending', 0, ?)`,
    args: [USER_ID, TPL, today, new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString()],
  });
  await fx.insertRun(turso, { id: "run-now", templateId: TPL, completedAt: new Date().toISOString() });

  await triggers.onChecklistRunChanged(USER_ID, "run-now");

  assert.equal(await fx.statusOf(turso, "n1"), "cancelled");
});

// ── isolation ────────────────────────────────────────────────────────────────

test("each user's nudges are independent and follow their own time zone", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-vn");
  await fx.insertDevice(turso, OTHER_USER_ID, "reg-nz");
  await turso.execute({ sql: "UPDATE users SET timezone = 'Pacific/Auckland' WHERE id = ?", args: [OTHER_USER_ID] });
  await fx.insertTodo(turso, { id: "vn", scheduledDate: TODAY, time: "10:00", isImportant: 1 });
  await fx.insertTodo(turso, { id: "nz", userId: OTHER_USER_ID, scheduledDate: TODAY, time: "10:00", isImportant: 1 });

  await maintenance(at(TODAY, "09:00"));

  assert.deepEqual(
    (await overdueRows("todo_overdue", USER_ID)).map((row) => row.run_at).sort(),
    slotsVn(TODAY, EVEN_SLOTS)
  );
  // Auckland is UTC+12: 12:00 local is 00:00Z, long before the 09:00 VN (02:00Z) tick, so the
  // earliest Auckland slots were already too late to create and only the later ones remain.
  const nz = (await overdueRows("todo_overdue", OTHER_USER_ID)).map((row) => row.run_at).sort();
  assert.ok(nz.length > 0 && nz.length < 6);
  for (const runAt of nz) {
    assert.equal(localDateOf(new Date(runAt), "Pacific/Auckland"), TODAY);
  }
});

// ── cadence by quadrant (important / urgent) ─────────────────────────────────

const HOUR_MS = 60 * 60_000;
const HOURLY = ["11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00", "23:00"];

test("the repeat interval follows the quadrant: 1h, none (digest), 2h, none, unknown keeps 2h", () => {
  const interval = (important: number | boolean | null, urgent: number | boolean | null) =>
    nudges.todoOverdueIntervalMs(todoFields({ is_important: important, is_urgent: urgent }));

  assert.equal(interval(1, 1), HOUR_MS, "important and urgent: every hour");
  assert.equal(interval(true, true), HOUR_MS);
  assert.equal(interval(1, 0), null, "important only: the 17:00 / 07:00 digest instead");
  assert.equal(interval(true, false), null);
  assert.equal(interval(0, 1), 2 * HOUR_MS, "urgent only: every 2 hours");
  assert.equal(interval(false, true), 2 * HOUR_MS);
  assert.equal(interval(0, 0), null, "neither: only the on-time reminder");
  assert.equal(interval(false, false), null);
  // Not fully classified: do not guess, keep the default 2 hours.
  for (const [important, urgent] of [[null, null], [1, null], [null, 1], [0, null], [null, 0]] as const) {
    assert.equal(interval(important, urgent), 2 * HOUR_MS, `important=${important} urgent=${urgent}`);
  }
  // The general conditions still apply to every quadrant.
  assert.equal(nudges.todoOverdueIntervalMs(todoFields({ is_important: 1, is_urgent: 1, estimated_minutes: 121 })), null);
  assert.equal(nudges.todoOverdueIntervalMs(todoFields({ is_important: 1, is_urgent: 1, status: "done" })), null);
  assert.equal(nudges.todoOverdueIntervalMs(todoFields({ is_important: 1, is_urgent: 1, time: null })), null);
});

test("hourly slots: appointment + 1h, 2h, ... until the end of the day, and only those are valid", () => {
  const date = "2026-06-20";
  const scheduledAt = at(date, "10:00");

  assert.deepEqual(localTimes(nudges.overdueSlots(scheduledAt, date, VN, HOUR_MS)), HOURLY);
  assert.deepEqual(localTimes(nudges.overdueSlots(at(date, "22:30"), date, VN, HOUR_MS)), ["23:30"]);
  assert.deepEqual(nudges.overdueSlots(at(date, "23:00"), date, VN, HOUR_MS), [], "23:00 + 1h is tomorrow");
  assert.equal(nudges.overdueSlots(at(date, "00:00"), date, VN, HOUR_MS).length, 23);

  assert.equal(nudges.isOverdueSlot(scheduledAt, at(date, "11:00"), date, VN, HOUR_MS), true);
  assert.equal(nudges.isOverdueSlot(scheduledAt, at(date, "11:00"), date, VN), false, "11:00 is not a 2-hour slot");
  assert.equal(nudges.isOverdueSlot(scheduledAt, at(date, "10:30"), date, VN, HOUR_MS), false);
  assert.equal(nudges.isOverdueSlot(scheduledAt, at(date, "10:00"), date, VN, HOUR_MS), false, "the appointment itself");
});

test("an important and urgent todo at 10:00 is nudged every hour until the end of the day", async () => {
  const todo = await makeTodo({ title: "Gấp", scheduled_date: DATE, time: "10:00", is_important: true, is_urgent: true });

  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), slotsVn(DATE, HOURLY));
});

test("important only and neither-important-nor-urgent todos get no repeat nudge at all", async () => {
  const importantOnly = await makeTodo({ title: "Quan trọng", scheduled_date: DATE, time: "10:00", is_important: true, is_urgent: false });
  const neither = await makeTodo({ title: "Nhẹ", scheduled_date: DATE, time: "10:00", is_important: false, is_urgent: false });

  assert.deepEqual(await statusesOf("todo_overdue", importantOnly.id), []);
  assert.deepEqual(await statusesOf("todo_overdue", neither.id), []);
});

test("moving a todo between quadrants re-times its nudges; slots both cadences share are kept", async () => {
  const todo = await makeTodo({ title: "A", scheduled_date: DATE, time: "10:00", is_important: true, is_urgent: true });
  assert.equal((await pendingRunAts("todo_overdue", todo.id)).length, 13);

  await todosService.updateTodo(USER_ID, todo.id, { is_important: false }); // urgent only
  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), slotsVn(DATE, EVEN_SLOTS));

  await todosService.updateTodo(USER_ID, todo.id, { is_urgent: false }); // neither
  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), []);

  await todosService.updateTodo(USER_ID, todo.id, { is_important: true }); // important only
  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), []);

  await todosService.updateTodo(USER_ID, todo.id, { is_urgent: true }); // important and urgent again
  assert.deepEqual(await pendingRunAts("todo_overdue", todo.id), slotsVn(DATE, HOURLY));
});

test("the tick arms hourly nudges for an existing important and urgent todo, including one at 22:30", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await fx.insertTodo(turso, { id: "morning", scheduledDate: TODAY, time: "10:00", isImportant: 1, isUrgent: 1 });
  await fx.insertTodo(turso, { id: "night", scheduledDate: TODAY, time: "22:30", isImportant: 1, isUrgent: 1 });

  await maintenance(at(TODAY, "09:00"));

  assert.deepEqual(await pendingRunAts("todo_overdue", "morning"), slotsVn(TODAY, HOURLY));
  assert.deepEqual(await pendingRunAts("todo_overdue", "night"), [runAtVn(TODAY, "23:30")]);
});

test("an important and urgent todo is pushed every hour, one push per slot", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await fx.insertTodo(turso, { id: "t1", title: "Nộp báo cáo", scheduledDate: TODAY, time: "10:00", isImportant: 1, isUrgent: 1 });
  await maintenance(at(TODAY, "09:00"));

  for (const hhmm of HOURLY) await dispatchAt(TODAY, hhmm);

  assert.equal(overdueMessages().length, 13);
  assert.equal(overdueMessages()[0].notification?.body, "⏰ Quá giờ 10:00 · Làm ngay hoặc dời lịch!");
});

test("a leftover odd-hour slot is dropped when the todo has since become urgent-only (2h)", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await fx.insertTodo(turso, { id: "t1", title: "A", scheduledDate: TODAY, time: "10:00", isImportant: 1, isUrgent: 1 });
  await maintenance(at(TODAY, "09:00"));
  // Edited without going through the hook (e.g. an old write path): 11:00 is no longer a slot.
  await turso.execute("UPDATE todos SET is_important = 0 WHERE id = 't1'");

  await dispatchAt(TODAY, "11:00");
  assert.equal(overdueMessages().length, 0);
  await dispatchAt(TODAY, "12:00");
  assert.equal(overdueMessages().length, 1, "12:00 is still a valid 2-hour slot");
});

test("a leftover nudge is dropped when the todo has since become important-only", async () => {
  await armTodo();
  await turso.execute("UPDATE todos SET is_important = 1, is_urgent = 0 WHERE id = 't1'");

  await dispatchAt(TODAY, "12:00");

  assert.equal(overdueMessages().length, 0);
});

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
const { runDispatch, runMaintenance } = await import("../src/services/notification-tick.js");
const repeat = await import("../src/services/reminder-repeat.js");
const timers = await import("../src/services/todo-timers.js");
const todosService = await import("../src/services/todos.js");
const timersRepo = await import("../src/repositories/todo-timers.js");
const { default: Fastify } = await import("fastify");
const { default: userAuth } = await import("../src/plugins/user-auth.js");
const { default: todosRoutes } = await import("../src/routes/api/v1/todos.js");
const { signUserToken } = await import("../src/services/api-auth.js");
const { localDateTimeToUtc } = await import("../src/utils/time.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID, OTHER_USER_ID } = fx;
const VN = "Asia/Ho_Chi_Minh";
const DAY = "2026-06-20";
const KIND = "todo_reminder_repeat";

/** Giờ địa phương (Việt Nam) của ngày thử, cộng `seconds` giây. */
const at = (hhmm: string, seconds = 0): Date =>
  new Date(localDateTimeToUtc(DAY, hhmm, VN).getTime() + seconds * 1000);

let fake = fx.fakeMessaging();
const app = Fastify();

before(async () => {
  await applyAllMigrations(turso);
  await app.register(userAuth);
  await app.register(todosRoutes, { prefix: "/todos" });
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
    "daily_todo_logs",
    "daily_todo_summaries",
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await turso.execute("UPDATE todos SET parent_id = NULL, trigger_after_todo_id = NULL");
  await turso.execute("DELETE FROM todos");
  await turso.execute(`DELETE FROM users WHERE id IN ('${USER_ID}', '${OTHER_USER_ID}')`);

  await fx.insertUser(turso, USER_ID);
  await fx.insertUser(turso, OTHER_USER_ID);

  fake = fx.fakeMessaging();
  firebase.setMessagingClientForTests(fake.client);
  firebase.setPushLogger(fx.silentLogger);
});

const repeatRows = () => fx.jobsFor(turso, USER_ID, `AND kind = '${KIND}'`);
const repeatStatuses = async () => (await repeatRows()).map((row) => row.status);
const pendingRepeatRunAts = async () =>
  (await repeatRows()).filter((row) => row.status === "pending").map((row) => String(row.run_at));
const dispatchAt = (hhmm: string, seconds = 10) =>
  runDispatch({ now: at(hhmm, seconds), logger: fx.silentLogger });

/** Một thiết bị, một todo "t1" hẹn 10:00 (quan trọng + khẩn cấp); planner (09:00) tạo job nhắc đúng giờ. */
const armTodo = async (overrides: Partial<Parameters<typeof fx.insertTodo>[1]> = {}) => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await fx.insertTodo(turso, {
    id: "t1",
    title: "Nộp báo cáo",
    scheduledDate: DAY,
    time: "10:00",
    isImportant: 1,
    isUrgent: 1,
    ...overrides,
  });
  await runMaintenance({ now: at("09:00"), logger: fx.silentLogger });
};

/** Mọi push tới thiết bị về todo (nhắc đúng giờ và nhắc lại). */
const todoPushes = () => fake.messages.filter((m) => m.data?.type === "todo");

// ── hàm thuần ────────────────────────────────────────────────────────────────

test("there is exactly one repeat slot, 5 minutes after the appointment time", () => {
  const t = at("10:00");
  assert.deepEqual(
    repeat.repeatSlots(t).map((d) => d.toISOString()),
    [at("10:05").toISOString()]
  );
  assert.equal(repeat.repeatIndexOf(t, at("10:05")), 1);
  for (const runAt of [at("10:00"), at("10:02"), at("10:04"), at("10:06"), at("10:10"), at("09:55")]) {
    assert.equal(repeat.repeatIndexOf(t, runAt), null, runAt.toISOString());
  }
});

test("only important AND urgent todos are eligible", () => {
  const eligible = (is_important: number | boolean | null, is_urgent: number | boolean | null) =>
    repeat.isImportantAndUrgent({ is_important, is_urgent });
  assert.equal(eligible(1, 1), true);
  assert.equal(eligible(true, true), true);
  for (const [important, urgent] of [
    [1, 0],
    [0, 1],
    [0, 0],
    [false, false],
    [null, null],
    [1, null],
    [null, 1],
  ] as const) {
    assert.equal(eligible(important, urgent), false, `${important}/${urgent}`);
  }
});

// ── gửi ──────────────────────────────────────────────────────────────────────

test("the on-time reminder is followed by exactly ONE repeat, 5 minutes later, then nothing", async () => {
  await armTodo();
  assert.deepEqual(await pendingRepeatRunAts(), [], "no repeat exists before the reminder went out");

  await dispatchAt("10:00");
  assert.equal(todoPushes().length, 1);
  assert.deepEqual(await pendingRepeatRunAts(), [at("10:05").toISOString()]);

  await dispatchAt("10:02"); // nothing is due between the reminder and its repeat
  assert.equal(todoPushes().length, 1);
  await dispatchAt("10:05");
  await dispatchAt("10:07");
  await dispatchAt("10:10");
  await dispatchAt("10:30");

  const pushes = todoPushes();
  assert.equal(pushes.length, 2, "reminder + one repeat");
  assert.deepEqual(await repeatStatuses(), ["sent"]);
  assert.equal((await repeatRows()).length, 1, "no second repeat is ever created");

  const [first, second] = pushes;
  assert.deepEqual(first.data, { type: "todo", id: "t1", date: DAY, tag: "todo:t1" });
  assert.deepEqual(second.data, { type: "todo", id: "t1", date: DAY, tag: "todo:t1", repeat: "1" });
  assert.equal(second.notification?.title, first.notification?.title);
  assert.equal(second.notification?.body, first.notification?.body, "same text: the card is replaced and rings again");
  assert.equal(second.android?.notification?.tag, "todo:t1");
  assert.equal(second.android?.notification?.channelId, "todo_reminders");
  assert.equal(second.android?.ttl, 120_000);
});

for (const [label, flags] of [
  ["important only", { isImportant: 1, isUrgent: 0 }],
  ["urgent only", { isImportant: 0, isUrgent: 1 }],
  ["neither important nor urgent", { isImportant: 0, isUrgent: 0 }],
  ["not classified", { isImportant: null, isUrgent: null }],
  ["important, urgency unknown", { isImportant: 1, isUrgent: null }],
] as const) {
  test(`a todo that is ${label} gets its on-time reminder but no repeat`, async () => {
    await armTodo(flags);
    await dispatchAt("10:00");
    await dispatchAt("10:05");

    assert.equal(todoPushes().length, 1, "only the on-time reminder");
    assert.deepEqual(await repeatRows(), [], "no repeat job is even created");
  });
}

test("a reminder that went out a little late (4 minutes) still gets its repeat", async () => {
  await armTodo();
  await dispatchAt("10:04", 10); // the +5 minute slot is still ahead
  assert.deepEqual(await pendingRepeatRunAts(), [at("10:05").toISOString()]);
  await dispatchAt("10:05");
  assert.equal(todoPushes().length, 2);
});

test("a reminder that went out more than 5 minutes late gets no repeat: its slot is already past", async () => {
  await armTodo();
  await dispatchAt("10:06", 10);
  assert.equal(todoPushes().length, 1);
  assert.deepEqual(await repeatRows(), []);
});

test("a repeat that is more than 2 minutes late is dropped, never sent", async () => {
  await armTodo();
  await dispatchAt("10:00");

  await dispatchAt("10:08"); // the server was away: the slot is past the 2 minute lateness limit
  assert.equal(todoPushes().length, 1);
  assert.deepEqual(await repeatStatuses(), ["missed"]);
});

test("a todo already started (in_progress) when its reminder goes out gets no repeat", async () => {
  await armTodo({ status: "in_progress" });
  await dispatchAt("10:00");
  assert.equal(todoPushes().length, 1, "the on-time reminder itself is unchanged");
  assert.deepEqual(await repeatRows(), []);
});

// ── dừng: người dùng đã phản ứng ─────────────────────────────────────────────

test("tapping the notification (ack) right after the reminder cancels the repeat", async () => {
  await armTodo();
  await dispatchAt("10:00");

  const result = await repeat.acknowledgeReminder(USER_ID, "t1", at("10:00", 30));
  assert.deepEqual(result, { todo_id: "t1", cancelled: 1 });

  await dispatchAt("10:05");
  assert.equal(todoPushes().length, 1, "only the on-time reminder");
  assert.deepEqual(await repeatStatuses(), ["cancelled"]);
});

test("an ack that arrives before the repeat was even created still wins", async () => {
  await armTodo();

  // The phone confirms before the server finished writing the repeat row after sending the reminder.
  const early = await repeat.acknowledgeReminder(USER_ID, "t1", at("10:00", 0.5));
  assert.equal(early.cancelled, 0);
  assert.deepEqual(await repeatStatuses(), ["cancelled"], "the marker is written");

  await dispatchAt("10:00"); // the reminder goes out and tries to create the repeat
  await dispatchAt("10:05");

  assert.equal(todoPushes().length, 1);
  assert.deepEqual(await repeatStatuses(), ["cancelled"], "not resurrected, no duplicate");
});

test("an ack is idempotent and reaches every device of the user", async () => {
  await armTodo();
  await fx.insertDevice(turso, USER_ID, "reg-B", { id: "device-B", kind: "fid" });
  await dispatchAt("10:00");
  assert.equal(todoPushes().length, 2, "one push per device");

  assert.equal((await repeat.acknowledgeReminder(USER_ID, "t1", at("10:00", 20))).cancelled, 1);
  assert.equal((await repeat.acknowledgeReminder(USER_ID, "t1", at("10:00", 25))).cancelled, 0);

  await dispatchAt("10:05");
  assert.equal(todoPushes().length, 2, "no repeat to either device");
});

test("an ack for an unknown todo or for another user's todo is not_found", async () => {
  await fx.insertTodo(turso, { id: "theirs", userId: OTHER_USER_ID, scheduledDate: DAY, time: "10:00" });
  for (const id of ["nope", "theirs"]) {
    await assert.rejects(() => repeat.acknowledgeReminder(USER_ID, id), repeat.ReminderRepeatError);
  }
});

test("starting the countdown cancels the repeat at once", async () => {
  await armTodo();
  await dispatchAt("10:00");
  assert.equal((await pendingRepeatRunAts()).length, 1);

  await timers.applyTimerEvent(
    USER_ID,
    "t1",
    {
      action: "start",
      clientEventAt: at("10:01").toISOString(),
      remainingSeconds: 1500,
      estimatedSeconds: 1500,
      registrationId: "reg-A",
    },
    at("10:01")
  );
  assert.deepEqual(await pendingRepeatRunAts(), []);

  await dispatchAt("10:05");
  assert.equal(todoPushes().length, 1);
});

const invalidations: Array<[string, () => Promise<unknown>]> = [
  ["the todo became in_progress", () => turso.execute("UPDATE todos SET status = 'in_progress' WHERE id = 't1'")],
  ["the todo is done", () => turso.execute("UPDATE todos SET status = 'done' WHERE id = 't1'")],
  ["the todo is archived", () => turso.execute("UPDATE todos SET status = 'archived' WHERE id = 't1'")],
  ["the todo was deleted", () => turso.execute("UPDATE todos SET deleted_at = '2026-06-20T01:00:00.000Z' WHERE id = 't1'")],
  ["the time was edited", () => turso.execute("UPDATE todos SET time = '09:00' WHERE id = 't1'")],
  ["the todo lost its time", () => turso.execute("UPDATE todos SET time = NULL WHERE id = 't1'")],
  ["the todo moved to another day", () => turso.execute("UPDATE todos SET scheduled_date = '2026-06-21' WHERE id = 't1'")],
  ["it stopped being urgent", () => turso.execute("UPDATE todos SET is_urgent = 0 WHERE id = 't1'")],
  ["it stopped being important", () => turso.execute("UPDATE todos SET is_important = 0 WHERE id = 't1'")],
  [
    "a countdown is paused on it",
    () =>
      timersRepo.upsertTimer({
        todo_id: "t1",
        user_id: USER_ID,
        status: "paused",
        estimated_seconds: 1500,
        remaining_seconds: 900,
        ends_at: null,
        device_id: "device-A",
        last_client_event_at: "2026-06-20T03:01:00.000Z",
      }),
  ],
  [
    "a countdown ran out without the todo being done",
    () =>
      timersRepo.upsertTimer({
        todo_id: "t1",
        user_id: USER_ID,
        status: "finished",
        estimated_seconds: 60,
        remaining_seconds: 0,
        ends_at: null,
        device_id: "device-A",
        last_client_event_at: "2026-06-20T03:01:00.000Z",
      }),
  ],
];

for (const [label, mutate] of invalidations) {
  test(`re-validation right before sending: no repeat is sent when ${label}`, async () => {
    await armTodo();
    await dispatchAt("10:00");
    await mutate(); // written straight to the DB, so no hook cancelled anything

    await dispatchAt("10:05");

    assert.equal(todoPushes().length, 1);
    assert.equal((await repeatRows()).find((r) => r.run_at === at("10:05").toISOString())?.status, "cancelled");
  });
}

test("an idle countdown (stopped) does not suppress the repeat", async () => {
  await armTodo();
  await dispatchAt("10:00");
  await timersRepo.upsertTimer({
    todo_id: "t1",
    user_id: USER_ID,
    status: "idle",
    estimated_seconds: 1500,
    remaining_seconds: null,
    ends_at: null,
    device_id: null,
    last_client_event_at: "2026-06-20T03:01:00.000Z",
  });
  await dispatchAt("10:05");
  assert.equal(todoPushes().length, 2);
});

// ── hook: todo đổi ───────────────────────────────────────────────────────────

test("completing the todo cancels the pending repeat; renaming it keeps it", async () => {
  await armTodo();
  await dispatchAt("10:00");

  await todosService.updateTodo(USER_ID, "t1", { title: "Đổi tên" });
  assert.equal((await pendingRepeatRunAts()).length, 1, "an unrelated edit keeps the repeat");

  await todosService.completeTodo(USER_ID, "t1", {});
  assert.deepEqual(await pendingRepeatRunAts(), []);
  await dispatchAt("10:05");
  assert.equal(todoPushes().length, 1);
});

test("changing the appointment time cancels the repeat of the old time", async () => {
  await armTodo();
  await dispatchAt("10:00");

  await todosService.updateTodo(USER_ID, "t1", { time: "11:00" });

  assert.deepEqual(await pendingRepeatRunAts(), []);
  await dispatchAt("10:05");
  assert.equal(todoPushes().length, 1);
});

test("moving the todo out of 'important and urgent' cancels the pending repeat", async () => {
  await armTodo();
  await dispatchAt("10:00");

  await todosService.updateTodo(USER_ID, "t1", { is_urgent: false });

  assert.deepEqual(await pendingRepeatRunAts(), []);
});

test("starting the todo (in_progress) through the API cancels the pending repeat", async () => {
  await armTodo();
  await dispatchAt("10:00");

  await todosService.updateTodo(USER_ID, "t1", { status: "in_progress" });

  assert.deepEqual(await pendingRepeatRunAts(), []);
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

const auth = (userId = USER_ID) => ({ authorization: `Bearer ${signUserToken(app, userId)}` });
const ack = (id: string, headers: Record<string, string> = auth()) =>
  app.inject({ method: "POST", url: `/todos/${id}/reminder-ack`, headers });

test("POST /todos/:id/reminder-ack needs a user JWT and only sees the caller's todos", async () => {
  await armTodo();
  await fx.insertTodo(turso, { id: "theirs", userId: OTHER_USER_ID, scheduledDate: DAY, time: "10:00" });

  assert.equal((await ack("t1", {})).statusCode, 401);
  assert.equal((await ack("missing")).statusCode, 404);
  const foreign = await ack("theirs");
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.json().error, "not_found");
});

test("POST /todos/:id/reminder-ack answers with how many repeats it stopped, and is safe to repeat", async () => {
  await armTodo();
  await dispatchAt("10:00");

  const first = await ack("t1");
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { todo_id: "t1", cancelled: 1 });

  const again = await ack("t1");
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), { todo_id: "t1", cancelled: 0 });
});

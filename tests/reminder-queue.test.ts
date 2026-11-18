/**
 * Hàng đợi nhắc giờ todo: đang đếm ngược một todo thì nhắc của todo khác chờ đến khi đếm ngược kết thúc + 2
 * phút; nhắc cùng giờ cách nhau 2 phút theo thứ tự ưu tiên. Phần đầu test hàm thuần `planReminderQueue`; phần
 * sau đi qua đường thật (hook, sự kiện đồng hồ, tick gửi).
 */
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
const queue = await import("../src/services/reminder-queue.js");
const triggers = await import("../src/services/notification-triggers.js");
const timers = await import("../src/services/todo-timers.js");
const cards = await import("../src/services/notification-cards.js");
const jobsRepo = await import("../src/repositories/notification-jobs.js");
const { runDispatch, runMaintenance } = await import("../src/services/notification-tick.js");
const { localDateTimeToUtc } = await import("../src/utils/time.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID, OTHER_USER_ID } = fx;
const { planReminderQueue, reminderPriority } = queue;
const MIN = 60_000;
const TODAY = "2026-06-20";
const VN = "Asia/Ho_Chi_Minh";

/** Giờ Việt Nam hôm nay (UTC ms) cộng `seconds`. */
const ms = (hhmm: string, seconds = 0): number =>
  localDateTimeToUtc(TODAY, hhmm, VN).getTime() + seconds * 1000;
const at = (hhmm: string, seconds = 0): Date => new Date(ms(hhmm, seconds));
const iso = (hhmm: string): string => at(hhmm).toISOString();

// ── pure planner ─────────────────────────────────────────────────────────────

type Item = Parameters<typeof planReminderQueue>[0]["items"][number];

const item = (
  todoId: string,
  hhmm: string,
  extra: Partial<Item> & { runAtHhmm?: string } = {}
): Item => ({
  todoId,
  baseMs: ms(hhmm),
  rank: 3,
  createdAt: "2026-06-01T00:00:00.000Z",
  runAtMs: extra.runAtHhmm ? ms(extra.runAtHhmm) : ms(hhmm),
  ...extra,
});

/** Áp kết quả lên danh sách: dời `runAtMs`, bỏ phần tử bị hủy. */
const applyPlan = (items: Item[], actions: ReturnType<typeof planReminderQueue>): Item[] =>
  items.flatMap((entry) => {
    const action = actions.find((a) => a.todoId === entry.todoId);
    if (action?.action === "cancel") return [];
    return [action?.action === "move" ? { ...entry, runAtMs: action.runAtMs } : entry];
  });

const slots = (actions: ReturnType<typeof planReminderQueue>): Record<string, number | "keep" | "cancel"> =>
  Object.fromEntries(
    actions.map((a) => [a.todoId, a.action === "move" ? a.runAtMs : a.action])
  );

test("priority: important+urgent, then urgent only, then important only, then neither; unset counts as no", () => {
  assert.equal(reminderPriority(1, 1), 0);
  assert.equal(reminderPriority(0, 1), 1);
  assert.equal(reminderPriority(1, 0), 2);
  assert.equal(reminderPriority(0, 0), 3);
  assert.equal(reminderPriority(null, null), 3);
  assert.equal(reminderPriority(null, 1), 1);
  assert.equal(reminderPriority(1, null), 2);
  assert.equal(reminderPriority(true, true), 0);
});

test("a 60-minute countdown started at 14:03 holds the 14:30 reminder until 15:05 and leaves 15:30 alone", () => {
  const actions = planReminderQueue({
    items: [item("todo2", "14:30"), item("todo3", "15:30")],
    timers: [{ todoId: "todo1", endsAtMs: ms("14:03") + 60 * MIN }],
    nowMs: ms("14:03"),
  });
  assert.deepEqual(slots(actions), { todo2: ms("15:05"), todo3: "keep" });
});

test("a 90-minute countdown started at 14:06 holds both: 15:38, then 15:40", () => {
  const actions = planReminderQueue({
    items: [item("todo2", "14:30"), item("todo3", "15:30")],
    timers: [{ todoId: "todo1", endsAtMs: ms("14:06") + 90 * MIN }],
    nowMs: ms("14:06"),
  });
  assert.deepEqual(slots(actions), { todo2: ms("15:38"), todo3: ms("15:40") });
});

test("a reminder due exactly when the countdown ends is held too", () => {
  const actions = planReminderQueue({
    items: [item("todo2", "15:03")],
    timers: [{ todoId: "todo1", endsAtMs: ms("15:03") }],
    nowMs: ms("14:03"),
  });
  assert.deepEqual(slots(actions), { todo2: ms("15:05") });
});

test("a countdown does not hold the reminder of the todo it is counting", () => {
  const actions = planReminderQueue({
    items: [item("todo1", "14:30")],
    timers: [{ todoId: "todo1", endsAtMs: ms("15:03") }],
    nowMs: ms("14:03"),
  });
  assert.deepEqual(slots(actions), { todo1: "keep" });
});

test("a countdown that has already run out holds nothing", () => {
  const actions = planReminderQueue({
    items: [item("todo2", "14:30")],
    timers: [{ todoId: "todo1", endsAtMs: ms("14:20") }],
    nowMs: ms("14:21"),
  });
  assert.deepEqual(slots(actions), { todo2: "keep" });
});

test("same reminder time: 2 minutes apart, ordered by priority and then by who was created first", () => {
  const stamp = (n: number) => `2026-06-0${n}T00:00:00.000Z`;
  const items = [
    item("plain", "14:00", { rank: reminderPriority(0, 0), createdAt: stamp(1) }),
    item("both-late", "14:00", { rank: reminderPriority(1, 1), createdAt: stamp(4) }),
    item("urgent", "14:00", { rank: reminderPriority(0, 1), createdAt: stamp(3) }),
    item("important", "14:00", { rank: reminderPriority(1, 0), createdAt: stamp(2) }),
    item("both-early", "14:00", { rank: reminderPriority(1, 1), createdAt: stamp(2) }),
  ];
  const actions = planReminderQueue({ items, timers: [], nowMs: ms("13:50") });

  assert.deepEqual(
    actions.map((a) => a.todoId),
    ["both-early", "both-late", "urgent", "important", "plain"],
    "queue order"
  );
  assert.deepEqual(slots(actions), {
    "both-early": "keep",
    "both-late": ms("14:02"),
    urgent: ms("14:04"),
    important: ms("14:06"),
    plain: ms("14:08"),
  });
});

test("equal priority and creation time fall back to the id, so the order never flips between runs", () => {
  const items = [item("b", "14:00"), item("a", "14:00")];
  const first = planReminderQueue({ items, timers: [], nowMs: ms("13:50") });
  const second = planReminderQueue({ items: [...items].reverse(), timers: [], nowMs: ms("13:50") });
  assert.deepEqual(first, second);
  assert.equal(first[0].todoId, "a");
});

test("an earlier appointment goes before a later one even if the later one is more important", () => {
  const actions = planReminderQueue({
    items: [item("late-vip", "14:30", { rank: 0 }), item("early", "14:00", { rank: 3 })],
    timers: [{ todoId: "other", endsAtMs: ms("15:00") }],
    nowMs: ms("13:50"),
  });
  assert.deepEqual(slots(actions), { early: ms("15:02"), "late-vip": ms("15:04") });
});

test("a reminder behind one that just went out waits 2 minutes after it", () => {
  const actions = planReminderQueue({
    items: [item("b", "14:00")],
    timers: [],
    nowMs: ms("14:00", 30),
    seedMs: ms("14:00"),
  });
  assert.deepEqual(slots(actions), { b: ms("14:02") });
});

test("a countdown stopped early releases the held reminders 2 minutes after the stop, 2 minutes apart", () => {
  const items = [
    item("t2", "14:30", { runAtHhmm: "15:05" }),
    item("t3", "14:30", { runAtHhmm: "15:07", createdAt: "2026-06-02T00:00:00.000Z" }),
  ];
  const nowMs = ms("14:40");
  const actions = planReminderQueue({ items, timers: [], nowMs });
  assert.deepEqual(slots(actions), { t2: ms("14:42"), t3: ms("14:44") });

  // Planning again a minute later changes nothing: the release does not drift.
  const settled = applyPlan(items, actions);
  assert.deepEqual(
    slots(planReminderQueue({ items: settled, timers: [], nowMs: ms("14:41") })),
    { t2: "keep", t3: "keep" }
  );
});

test("resuming the countdown before the release goes out holds the reminder again", () => {
  const actions = planReminderQueue({
    items: [item("t2", "14:30", { runAtHhmm: "14:42" })],
    timers: [{ todoId: "t1", endsAtMs: ms("15:01") }],
    nowMs: ms("14:41"),
  });
  assert.deepEqual(slots(actions), { t2: ms("15:03") });
});

test("planning is a fixed point: running it again on its own output changes nothing", () => {
  const items = [
    item("a", "14:00", { rank: 0 }),
    item("b", "14:00", { rank: 1 }),
    item("c", "14:30"),
    item("d", "15:30"),
  ];
  const timersIn = [{ todoId: "x", endsAtMs: ms("15:36") }];
  const nowMs = ms("14:06");
  const once = planReminderQueue({ items, timers: timersIn, nowMs });
  const next = applyPlan(items, once);
  const twice = planReminderQueue({ items: next, timers: timersIn, nowMs });
  assert.deepEqual(
    twice.map((a) => a.action),
    twice.map(() => "keep")
  );
});

test("the todo that was just edited: past appointment and not held is cancelled; others are only released", () => {
  const items = [item("edited", "14:00", { runAtHhmm: "16:00" })];
  const asEdited = planReminderQueue({ items, timers: [], nowMs: ms("14:30"), changedTodoId: "edited" });
  assert.deepEqual(slots(asEdited), { edited: "cancel" });

  const asOther = planReminderQueue({ items, timers: [], nowMs: ms("14:30"), changedTodoId: "someone-else" });
  assert.deepEqual(slots(asOther), { edited: ms("14:32") });
});

test("the edited todo keeps its reminder when a countdown still holds it", () => {
  const actions = planReminderQueue({
    items: [item("edited", "14:30", { runAtHhmm: "15:05" })],
    timers: [{ todoId: "t1", endsAtMs: ms("15:03") }],
    nowMs: ms("14:45"),
    changedTodoId: "edited",
  });
  assert.deepEqual(slots(actions), { edited: "keep" });
});

// ── through the real paths ───────────────────────────────────────────────────

let fake = fx.fakeMessaging();
/** Tin HIỆN thông báo: bắt đầu đếm ngược còn gửi trong nền một tin gỡ thẻ (`type: "dismiss"`) không tính ở đây. */
const shownPushes = () => fake.messages.filter((m) => m.data?.type !== "dismiss");

before(async () => {
  await applyAllMigrations(turso);
});

beforeEach(async () => {
  // Tin gỡ của test trước có thể còn đang gửi trong nền: chờ xong rồi mới dọn dữ liệu và đổi FCM giả.
  await cards.flushDismissals();
  for (const table of [
    "notification_jobs",
    "todo_timers",
    "notification_settings",
    "user_devices",
    "daily_todo_logs",
    "daily_todo_summaries",
    "todo_tags",
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await turso.execute("UPDATE todos SET parent_id = NULL, trigger_after_todo_id = NULL, recurrence_template_id = NULL");
  await turso.execute("DELETE FROM todos");
  await turso.execute(`DELETE FROM users WHERE id IN ('${USER_ID}', '${OTHER_USER_ID}')`);
  await fx.insertUser(turso, USER_ID);
  await fx.insertUser(turso, OTHER_USER_ID);
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });

  fake = fx.fakeMessaging();
  firebase.setMessagingClientForTests(fake.client);
  firebase.setPushLogger(fx.silentLogger);
});

type TodoSeed = Parameters<typeof fx.insertTodo>[1];

/** Todo cùng ngày hôm nay, rồi chạy hook như lúc người dùng tạo nó lúc 13:50. */
const seedTodo = async (row: TodoSeed & { id: string; time: string }, now: Date = at("13:50")) => {
  await fx.insertTodo(turso, { scheduledDate: TODAY, ...row });
  await triggers.onTodoChanged(USER_ID, row.id, now);
};

const reminderOf = async (todoId: string) => {
  const job = await jobsRepo.getEventJob(USER_ID, "todo_reminder", todoId);
  return job ? { status: job.status, runAt: job.run_at } : null;
};

const startCountdown = (todoId: string, now: Date, minutes: number, userId = USER_ID) =>
  timers.applyTimerEvent(
    userId,
    todoId,
    {
      action: "start",
      clientEventAt: now.toISOString(),
      remainingSeconds: minutes * 60,
      estimatedSeconds: minutes * 60,
      registrationId: "reg-A",
    },
    now
  );

const timerEvent = (
  todoId: string,
  action: "pause" | "resume" | "stop" | "finish",
  now: Date,
  extra: { remainingSeconds?: number; estimatedSeconds?: number; registrationId?: string } = {}
) =>
  timers.applyTimerEvent(
    USER_ID,
    todoId,
    { action, clientEventAt: now.toISOString(), ...extra },
    now
  );

const dispatchAt = (now: Date) => runDispatch({ now, logger: fx.silentLogger });
/** Todo đã được nhắc (bỏ qua tin nhắc lại +5 phút, mang `data.repeat`). */
const sentTodoIds = () =>
  fake.messages
    .filter((m) => m.data?.type === "todo" && m.data?.repeat === undefined)
    .map((m) => m.data?.id)
    .filter((id, index, all) => all.indexOf(id) === index);

/** Ba todo của ví dụ: 14:00, 14:30 và 15:30. */
const seedThree = async () => {
  await seedTodo({ id: "todo1", title: "Todo 1", time: "14:00" });
  await seedTodo({ id: "todo2", title: "Todo 2", time: "14:30" });
  await seedTodo({ id: "todo3", title: "Todo 3", time: "15:30" });
};

test("without a countdown, reminders stay at their own times", async () => {
  await seedThree();
  assert.equal((await reminderOf("todo1"))?.runAt, iso("14:00"));
  assert.equal((await reminderOf("todo2"))?.runAt, iso("14:30"));
  assert.equal((await reminderOf("todo3"))?.runAt, iso("15:30"));
});

test("case 1: a 60-minute countdown started at 14:03 moves Todo 2 to 15:05 and does not touch Todo 3", async () => {
  await seedThree();

  await startCountdown("todo1", at("14:03"), 60);

  assert.deepEqual(await reminderOf("todo2"), { status: "pending", runAt: iso("15:05") });
  assert.deepEqual(await reminderOf("todo3"), { status: "pending", runAt: iso("15:30") });
});

test("case 1 end to end: nothing is sent at 14:30, Todo 2 arrives at 15:05, Todo 3 at 15:30", async () => {
  await seedThree();
  await dispatchAt(at("14:00", 5));
  assert.deepEqual(sentTodoIds(), ["todo1"], "Todo 1's own reminder goes out before it is started");
  fake.messages.length = 0;

  await startCountdown("todo1", at("14:03"), 60);

  await dispatchAt(at("14:30", 10));
  assert.deepEqual(sentTodoIds(), [], "Todo 2 is not reminded at its own time");

  await dispatchAt(at("15:03", 30));
  assert.equal(
    fake.messages.some((m) => m.data?.type === "todo" && m.data?.id === "todo2"),
    false,
    "not at the moment the countdown ends either"
  );
  fake.messages.length = 0;

  await dispatchAt(at("15:05", 10));
  assert.deepEqual(sentTodoIds().filter((id) => id === "todo2"), ["todo2"], "2 minutes after the countdown");
  fake.messages.length = 0;

  await dispatchAt(at("15:30", 10));
  assert.deepEqual(sentTodoIds(), ["todo3"], "Todo 3 keeps its own time");
});

test("case 2: a 90-minute countdown started at 14:06 moves Todo 2 to 15:38 and Todo 3 to 15:40", async () => {
  await seedThree();

  await startCountdown("todo1", at("14:06"), 90);

  assert.equal((await reminderOf("todo2"))?.runAt, iso("15:38"));
  assert.equal((await reminderOf("todo3"))?.runAt, iso("15:40"));
});

test("case 2 end to end: a hold longer than the lateness limit is not dropped and goes out at its slot", async () => {
  await seedThree();
  await startCountdown("todo1", at("14:06"), 90);
  fake.messages.length = 0;

  // The maintenance pass (planner + missed sweep) runs while the reminders are held: it must leave them be.
  await runMaintenance({ now: at("15:20"), logger: fx.silentLogger });
  assert.equal((await reminderOf("todo2"))?.status, "pending");
  assert.equal((await reminderOf("todo3"))?.status, "pending");

  await dispatchAt(at("15:30", 10));
  assert.deepEqual(sentTodoIds().filter((id) => id !== "todo1"), [], "nothing at Todo 3's own time");

  await dispatchAt(at("15:38", 10));
  assert.deepEqual(sentTodoIds().filter((id) => id === "todo2"), ["todo2"]);
  fake.messages.length = 0;

  await dispatchAt(at("15:40", 10));
  assert.deepEqual(sentTodoIds().filter((id) => id === "todo3"), ["todo3"]);
});

test("stopping the countdown early releases the held reminders 2 minutes after the stop", async () => {
  await seedThree();
  await startCountdown("todo1", at("14:06"), 90);

  await timerEvent("todo1", "stop", at("14:40"));

  assert.equal((await reminderOf("todo2"))?.runAt, iso("14:42"));
  assert.equal((await reminderOf("todo3"))?.runAt, iso("15:30"), "Todo 3's own time has not come yet");

  // Running the safety net a minute later does not push it around.
  await runMaintenance({ now: at("14:41"), logger: fx.silentLogger });
  assert.equal((await reminderOf("todo2"))?.runAt, iso("14:42"));
});

test("pausing releases the hold; resuming holds again", async () => {
  await seedThree();
  await startCountdown("todo1", at("14:03"), 60);
  assert.equal((await reminderOf("todo2"))?.runAt, iso("15:05"));

  await timerEvent("todo1", "pause", at("14:40"), { remainingSeconds: 23 * 60 });
  assert.equal((await reminderOf("todo2"))?.runAt, iso("14:42"), "a paused countdown holds nothing");

  await timerEvent("todo1", "resume", at("14:41"), { remainingSeconds: 20 * 60, registrationId: "reg-A" });
  assert.equal((await reminderOf("todo2"))?.runAt, iso("15:03"), "resumed at 14:41 for 20 min -> ends 15:01, +2");
});

test("completing the counted todo releases the held reminders", async () => {
  await seedThree();
  await startCountdown("todo1", at("14:03"), 60);

  await turso.execute("UPDATE todos SET status = 'done' WHERE id = 'todo1'");
  await triggers.onTodoChanged(USER_ID, "todo1", at("14:50"));

  assert.equal((await reminderOf("todo2"))?.runAt, iso("14:52"));
});

test("deleting the counted todo releases the held reminders", async () => {
  await seedThree();
  await startCountdown("todo1", at("14:03"), 60);

  await turso.execute("UPDATE todos SET deleted_at = '2026-06-20T07:50:00.000Z' WHERE id = 'todo1'");
  await triggers.onTodosRemoved(USER_ID, ["todo1"], at("14:50"));

  assert.deepEqual(await reminderOf("todo2"), { status: "pending", runAt: iso("14:52") });
});

test("editing a held todo (a title change) keeps it held and does not cancel or re-arm it", async () => {
  await seedThree();
  await startCountdown("todo1", at("14:03"), 60);

  await turso.execute("UPDATE todos SET title = 'Todo 2 (đổi tên)' WHERE id = 'todo2'");
  await triggers.onTodoChanged(USER_ID, "todo2", at("14:45"));

  assert.deepEqual(await reminderOf("todo2"), { status: "pending", runAt: iso("15:05") });
});

test("re-timing a held todo to a later time re-queues it from the new time", async () => {
  await seedThree();
  await startCountdown("todo1", at("14:03"), 60);

  await turso.execute("UPDATE todos SET time = '16:00' WHERE id = 'todo2'");
  await triggers.onTodoChanged(USER_ID, "todo2", at("14:45"));

  assert.deepEqual(await reminderOf("todo2"), { status: "pending", runAt: iso("16:00") });
});

test("re-timing a held todo into the past (while nothing holds it) cancels the reminder", async () => {
  await seedThree();

  await turso.execute("UPDATE todos SET time = '14:10' WHERE id = 'todo2'");
  await triggers.onTodoChanged(USER_ID, "todo2", at("14:20"));

  assert.equal((await reminderOf("todo2"))?.status, "cancelled");
});

test("a new todo created while a countdown runs is queued behind it", async () => {
  await seedTodo({ id: "todo1", title: "Todo 1", time: "14:00" });
  await startCountdown("todo1", at("14:03"), 60);

  await seedTodo({ id: "late", title: "Việc mới", time: "14:45" }, at("14:10"));

  assert.deepEqual(await reminderOf("late"), { status: "pending", runAt: iso("15:05") });
});

test("a countdown on the todo itself does not delay its own reminder", async () => {
  await seedTodo({ id: "todo1", title: "Todo 1", time: "14:30" });

  await startCountdown("todo1", at("14:03"), 60);

  assert.equal((await reminderOf("todo1"))?.runAt, iso("14:30"));
});

test("another user's countdown holds nothing", async () => {
  await fx.insertDevice(turso, OTHER_USER_ID, "reg-other", { id: "device-other" });
  await fx.insertTodo(turso, { id: "theirs", userId: OTHER_USER_ID, scheduledDate: TODAY, time: "14:00" });
  await seedTodo({ id: "todo2", title: "Todo 2", time: "14:30" });

  await timers.applyTimerEvent(
    OTHER_USER_ID,
    "theirs",
    {
      action: "start",
      clientEventAt: at("14:03").toISOString(),
      remainingSeconds: 3600,
      estimatedSeconds: 3600,
      registrationId: "reg-other",
    },
    at("14:03")
  );

  assert.equal((await reminderOf("todo2"))?.runAt, iso("14:30"));
});

test("same reminder time: reminders go out 2 minutes apart, most important first", async () => {
  await fx.insertTodo(turso, { id: "plain", scheduledDate: TODAY, time: "14:00", isImportant: 0, isUrgent: 0 });
  await fx.insertTodo(turso, { id: "vip", scheduledDate: TODAY, time: "14:00", isImportant: 1, isUrgent: 1 });
  await fx.insertTodo(turso, { id: "urgent", scheduledDate: TODAY, time: "14:00", isImportant: 0, isUrgent: 1 });
  await fx.insertTodo(turso, { id: "important", scheduledDate: TODAY, time: "14:00", isImportant: 1, isUrgent: 0 });
  for (const id of ["plain", "vip", "urgent", "important"]) {
    await triggers.onTodoChanged(USER_ID, id, at("13:50"));
  }

  assert.equal((await reminderOf("vip"))?.runAt, iso("14:00"));
  assert.equal((await reminderOf("urgent"))?.runAt, iso("14:02"));
  assert.equal((await reminderOf("important"))?.runAt, iso("14:04"));
  assert.equal((await reminderOf("plain"))?.runAt, iso("14:06"));

  await dispatchAt(at("14:00", 10));
  assert.deepEqual(sentTodoIds(), ["vip"]);
  fake.messages.length = 0;
  await dispatchAt(at("14:02", 10));
  assert.deepEqual(sentTodoIds(), ["urgent"]);
  fake.messages.length = 0;
  await dispatchAt(at("14:04", 10));
  assert.deepEqual(sentTodoIds(), ["important"]);
  fake.messages.length = 0;
  await dispatchAt(at("14:06", 10));
  assert.deepEqual(sentTodoIds(), ["plain"]);
});

test("same time and same group: the todo created first is reminded first, whatever order the hooks ran in", async () => {
  await fx.insertTodo(turso, { id: "young", scheduledDate: TODAY, time: "14:00", isImportant: 1, isUrgent: 1 });
  await fx.insertTodo(turso, { id: "old", scheduledDate: TODAY, time: "14:00", isImportant: 1, isUrgent: 1 });
  await turso.execute("UPDATE todos SET created_at = '2026-06-10T00:00:00.000Z' WHERE id = 'old'");
  await turso.execute("UPDATE todos SET created_at = '2026-06-11T00:00:00.000Z' WHERE id = 'young'");
  await triggers.onTodoChanged(USER_ID, "young", at("13:50"));
  await triggers.onTodoChanged(USER_ID, "old", at("13:50"));

  assert.equal((await reminderOf("old"))?.runAt, iso("14:00"));
  assert.equal((await reminderOf("young"))?.runAt, iso("14:02"));
});

test("completing the first of two same-time reminders moves the second up to the shared time", async () => {
  await fx.insertTodo(turso, { id: "first", scheduledDate: TODAY, time: "14:00", isImportant: 1, isUrgent: 1 });
  await fx.insertTodo(turso, { id: "second", scheduledDate: TODAY, time: "14:00", isImportant: 0, isUrgent: 0 });
  await triggers.onTodoChanged(USER_ID, "first", at("13:50"));
  await triggers.onTodoChanged(USER_ID, "second", at("13:50"));
  assert.equal((await reminderOf("second"))?.runAt, iso("14:02"));

  await turso.execute("UPDATE todos SET status = 'done' WHERE id = 'first'");
  await triggers.onTodoChanged(USER_ID, "first", at("13:55"));

  assert.equal((await reminderOf("second"))?.runAt, iso("14:00"));
});

test("the once-a-minute safety net queues reminders that were armed before the queue existed", async () => {
  await fx.insertTodo(turso, { id: "todo1", scheduledDate: TODAY, time: "14:00" });
  await fx.insertTodo(turso, { id: "todo2", scheduledDate: TODAY, time: "14:30" });
  await fx.insertTodo(turso, { id: "twin-a", scheduledDate: TODAY, time: "16:00", isImportant: 1, isUrgent: 1 });
  await fx.insertTodo(turso, { id: "twin-b", scheduledDate: TODAY, time: "16:00" });
  for (const [id, hhmm] of [["todo2", "14:30"], ["twin-a", "16:00"], ["twin-b", "16:00"]] as const) {
    await fx.insertRawJob(turso, {
      id: `job-${id}`, kind: "todo_reminder", refId: id, localDate: TODAY, runAt: iso(hhmm),
    });
  }
  // A countdown that was already running when the queue was deployed.
  await fx.insertTodo(turso, { id: "running", scheduledDate: TODAY });
  await turso.execute({
    sql: `INSERT INTO todo_timers (todo_id, user_id, status, estimated_seconds, remaining_seconds, ends_at,
                                   device_id, last_client_event_at, updated_at)
          VALUES ('running', ?, 'running', 3600, 3600, ?, 'device-A', ?, ?)`,
    args: [USER_ID, iso("15:03"), at("14:03").toISOString(), at("14:03").toISOString()],
  });

  await runMaintenance({ now: at("14:05"), logger: fx.silentLogger });

  assert.equal((await reminderOf("todo2"))?.runAt, iso("15:05"));
  assert.equal((await reminderOf("twin-a"))?.runAt, iso("16:00"));
  assert.equal((await reminderOf("twin-b"))?.runAt, iso("16:02"));

  const again = await queue.reconcileReminderQueue(USER_ID, at("14:05"));
  assert.deepEqual(again, { moved: 0, cancelled: 0 }, "a second pass finds nothing to do");
});

test("a job whose todo was re-timed later without the hook is left for the send-time check to cancel", async () => {
  await fx.insertTodo(turso, { id: "todo1", scheduledDate: TODAY, time: "14:00" });
  await fx.insertRawJob(turso, {
    id: "job-1", kind: "todo_reminder", refId: "todo1", localDate: TODAY, runAt: iso("14:00"),
  });
  await turso.execute("UPDATE todos SET time = '15:00' WHERE id = 'todo1'");

  await runMaintenance({ now: at("13:50"), logger: fx.silentLogger });
  assert.equal((await reminderOf("todo1"))?.runAt, iso("14:00"), "the queue does not paper over a stale job");

  await dispatchAt(at("14:00", 10));
  assert.equal(await fx.statusOf(turso, "job-1"), "cancelled");
  assert.equal(shownPushes().length, 0);
});

// ── the other nudges stay quiet during a countdown ───────────────────────────

const seedRunningCountdown = async () => {
  await fx.insertTodo(turso, { id: "focus", title: "Đang làm", scheduledDate: TODAY });
  await startCountdown("focus", at("14:00"), 120);
};

test("the +5 minute repeat of an important+urgent todo is dropped while another todo is being counted", async () => {
  await fx.insertTodo(turso, { id: "vip", scheduledDate: TODAY, time: "14:00", isImportant: 1, isUrgent: 1 });
  await fx.insertRawJob(turso, {
    id: "job-repeat", kind: "todo_reminder_repeat", refId: "vip", localDate: TODAY, runAt: iso("14:05"),
  });
  await seedRunningCountdown();

  await dispatchAt(at("14:05", 10));

  assert.equal(await fx.statusOf(turso, "job-repeat"), "cancelled");
  assert.equal(shownPushes().length, 0);
});

test("the +5 minute repeat still goes out when nothing is being counted", async () => {
  await fx.insertTodo(turso, { id: "vip", scheduledDate: TODAY, time: "14:00", isImportant: 1, isUrgent: 1 });
  await fx.insertRawJob(turso, {
    id: "job-repeat", kind: "todo_reminder_repeat", refId: "vip", localDate: TODAY, runAt: iso("14:05"),
  });

  await dispatchAt(at("14:05", 10));

  assert.equal(await fx.statusOf(turso, "job-repeat"), "sent");
  assert.deepEqual(
    fake.messages.filter((m) => m.data?.repeat === "1").map((m) => m.data?.id),
    ["vip"]
  );
});

test("an overdue nudge is dropped while another todo is being counted, and still sent when nothing is", async () => {
  await fx.insertTodo(turso, { id: "late", scheduledDate: TODAY, time: "14:00" });
  // No importance flags: the nudge repeats every 2 hours, so 16:00 is its first slot.
  await fx.insertRawJob(turso, {
    id: "job-overdue", kind: "todo_overdue", refId: "late", localDate: TODAY, runAt: iso("16:00"),
  });
  await fx.insertTodo(turso, { id: "focus", title: "Đang làm", scheduledDate: TODAY });
  await startCountdown("focus", at("15:30"), 60);

  await dispatchAt(at("16:00", 10));
  assert.equal(await fx.statusOf(turso, "job-overdue"), "cancelled");
  assert.equal(shownPushes().length, 0);

  await timerEvent("focus", "stop", at("16:05"));
  await fx.insertRawJob(turso, {
    id: "job-overdue-2", kind: "todo_overdue", refId: "late", localDate: TODAY, runAt: iso("18:00"),
  });
  await dispatchAt(at("18:00", 10));
  assert.equal(await fx.statusOf(turso, "job-overdue-2"), "sent");
});

test("a paused or finished countdown does not silence the nudges", async () => {
  await fx.insertTodo(turso, { id: "vip", scheduledDate: TODAY, time: "14:00", isImportant: 1, isUrgent: 1 });
  await fx.insertRawJob(turso, {
    id: "job-repeat", kind: "todo_reminder_repeat", refId: "vip", localDate: TODAY, runAt: iso("14:05"),
  });
  await seedRunningCountdown();
  await timerEvent("focus", "pause", at("14:02"), { remainingSeconds: 100 * 60 });

  await dispatchAt(at("14:05", 10));

  assert.equal(await fx.statusOf(turso, "job-repeat"), "sent");
});

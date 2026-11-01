/**
 * Đổi giờ / ngày hẹn của một todo đã có thông báo trên máy -> gỡ thông báo cũ (tin chỉ có data), còn nhắc
 * lặp theo lịch mới vẫn đến. Các test đi qua đường thật: tick gửi, hook `onTodoChanged` gỡ, tick gửi tiếp.
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
const { runDispatch, runMaintenance } = await import("../src/services/notification-tick.js");
const triggers = await import("../src/services/notification-triggers.js");
const cards = await import("../src/services/notification-cards.js");
const todosService = await import("../src/services/todos.js");
const { processPush } = await import("../src/services/sync.service.js");
const { localDateTimeToUtc } = await import("../src/utils/time.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID, OTHER_USER_ID } = fx;
const VN = "Asia/Ho_Chi_Minh";
const TODAY = "2026-06-20";
const NEXT = "2026-06-21";

const at = (date: string, hhmm: string, seconds = 0): Date =>
  new Date(localDateTimeToUtc(date, hhmm, VN).getTime() + seconds * 1000);
const runAtVn = (date: string, hhmm: string): string => at(date, hhmm).toISOString();

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

  fake = fx.fakeMessaging();
  firebase.setMessagingClientForTests(fake.client);
  firebase.setPushLogger(fx.silentLogger);
});

const maintenance = (now: Date) => runMaintenance({ now, logger: fx.silentLogger });
const dispatchAt = (date: string, hhmm: string, seconds = 10) =>
  runDispatch({ now: at(date, hhmm, seconds), logger: fx.silentLogger });

const dismissMessages = () => fake.messages.filter((m) => m.data?.type === "dismiss");
const shownMessages = () => fake.messages.filter((m) => m.notification !== undefined);

/** Hook chạy như sau khi người dùng sửa todo ở thời điểm `now`, rồi chờ tin gỡ gửi trong nền xong. */
const changed = async (id: string, now: Date) => {
  await triggers.onTodoChanged(USER_ID, id, now);
  await cards.flushDismissals();
};

const setTodo = (id: string, fields: string) => turso.execute(`UPDATE todos SET ${fields} WHERE id = '${id}'`);

const cardKeys = async (id: string) =>
  (await fx.jobsFor(turso, USER_ID, `AND ref_id = '${id}' AND card_key IS NOT NULL`)).map((row) => [
    row.kind,
    row.card_key,
  ]);

const pendingNudges = async (id: string) =>
  (await fx.jobsFor(turso, USER_ID, `AND ref_id = '${id}' AND kind = 'todo_overdue' AND status = 'pending'`))
    .map((row) => String(row.run_at))
    .sort();

const hourly = (from: number, to: number, minutes: string): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => runAtVn(TODAY, `${String(from + i).padStart(2, "0")}:${minutes}`));

/** Hai máy, một todo quan trọng & khẩn cấp hẹn 10:00 (nhắc lặp mỗi giờ), đã nhắc đúng giờ lúc 10:00. */
const sentReminder = async (overrides: Partial<Parameters<typeof fx.insertTodo>[1]> = {}) => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await fx.insertDevice(turso, USER_ID, "reg-B", { id: "device-B", kind: "fid" });
  await fx.insertTodo(turso, {
    id: "t1",
    title: "Nộp báo cáo",
    scheduledDate: TODAY,
    time: "10:00",
    isImportant: 1,
    isUrgent: 1,
    ...overrides,
  });
  await maintenance(at(TODAY, "09:00"));
  await dispatchAt(TODAY, "10:00");
  assert.equal(
    shownMessages().filter((m) => m.data?.id === "t1").length,
    2,
    "the 10:00 reminder reached both devices"
  );
  fake.messages.length = 0;
};

// ── what a delivered card remembers ──────────────────────────────────────────

test("a delivered reminder or nudge remembers the schedule it was sent for; a dry run and a countdown do not", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await fx.insertTodo(turso, { id: "t1", scheduledDate: TODAY, time: "10:00", isImportant: 1, isUrgent: 1 });
  await maintenance(at(TODAY, "09:00"));

  await runDispatch({ now: at(TODAY, "10:00", 10), dryRun: true, logger: fx.silentLogger });
  assert.deepEqual(await cardKeys("t1"), [], "dry run: nothing reached a phone");
  await turso.execute("UPDATE notification_jobs SET status = 'pending', sent_at = NULL, attempts = 0, locked_at = NULL WHERE kind = 'todo_reminder'");

  await dispatchAt(TODAY, "10:00");
  await dispatchAt(TODAY, "11:00");

  assert.deepEqual(await cardKeys("t1"), [
    ["todo_overdue", `${TODAY}T10:00`],
    ["todo_reminder", `${TODAY}T10:00`],
  ]);
});

// ── the requested behaviour ──────────────────────────────────────────────────

test("moving an important+urgent todo from 10:00 to 9:10 at 10:00 removes the card; the 10:10 nudge still comes", async () => {
  await sentReminder();

  await setTodo("t1", "time = '09:10'");
  await changed("t1", at(TODAY, "10:00", 30));

  // 1. The old card is removed on both devices, with a silent data-only message.
  const dismiss = dismissMessages();
  assert.equal(dismiss.length, 2);
  assert.deepEqual(fake.targets().sort(), ["reg-A", "reg-B"]);
  for (const message of dismiss) {
    assert.equal(message.notification, undefined, "nothing is shown by the system");
    assert.deepEqual(
      { ...message.data, before: "<time>" },
      { type: "dismiss", id: "t1", tag: "todo:t1", before: "<time>" }
    );
    assert.equal(message.data?.before, at(TODAY, "10:00", 30).toISOString());
    assert.equal(message.android?.priority, "high");
    assert.equal(message.android?.ttl, 180_000, "short-lived so a late delivery cannot hit a newer card");
  }
  assert.deepEqual(await cardKeys("t1"), [], "the card is accounted for");

  // 2. The repeats follow the NEW time: 9:10 + 1h, 2h, ... to the end of the day.
  assert.deepEqual(await pendingNudges("t1"), hourly(10, 23, "10"));

  // 3. And the first of them really goes out at 10:10, under the same tag, saying how late it is.
  fake.messages.length = 0;
  await dispatchAt(TODAY, "10:10");
  const nudges = shownMessages();
  assert.equal(nudges.length, 2);
  assert.equal(nudges[0].notification?.title, "Nộp báo cáo");
  assert.equal(nudges[0].notification?.body, "⏰ Trễ 1 giờ (hẹn 09:10) · Làm ngay hoặc dời lịch!");
  assert.equal(nudges[0].android?.notification?.tag, "todo:t1");
  assert.equal(dismissMessages().length, 0, "no second dismissal on top of the new card");
  assert.deepEqual(await cardKeys("t1"), [["todo_overdue", `${TODAY}T09:10`]]);
});

test("moving the todo to another day removes the card and re-arms the repeats on that day", async () => {
  await sentReminder();

  await setTodo("t1", `scheduled_date = '${NEXT}'`);
  await changed("t1", at(TODAY, "10:00", 30));

  assert.equal(dismissMessages().length, 2);
  assert.deepEqual(await pendingNudges("t1"), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].map((h) => runAtVn(NEXT, `${h}:00`)));
});

test("clearing the reminder time removes the card and ends the repeats", async () => {
  await sentReminder();

  await setTodo("t1", "time = NULL");
  await changed("t1", at(TODAY, "10:00", 30));

  assert.equal(dismissMessages().length, 2);
  assert.deepEqual(await pendingNudges("t1"), []);
});

test("a todo that is not important and urgent has no repeats, but its old card is still removed", async () => {
  await sentReminder({ isImportant: 0, isUrgent: 0 });

  await setTodo("t1", "time = '15:00'");
  await changed("t1", at(TODAY, "10:00", 30));

  assert.equal(dismissMessages().length, 2);
  assert.deepEqual(await pendingNudges("t1"), []);
});

test("a repeated nudge is removed too when the time is moved, even by a whole number of hours", async () => {
  await sentReminder();
  await dispatchAt(TODAY, "11:00"); // "Trễ 1 giờ (hẹn 10:00)"
  fake.messages.length = 0;

  // 09:00 makes 11:00 a valid slot again, but the card on the phone still says "hẹn 10:00".
  await setTodo("t1", "time = '09:00'");
  await changed("t1", at(TODAY, "11:00", 30));

  assert.equal(dismissMessages().length, 2);
  assert.deepEqual((await pendingNudges("t1"))[0], runAtVn(TODAY, "12:00"));
});

// ── what must NOT remove anything ────────────────────────────────────────────

test("edits that do not touch the date or time leave the card alone", async () => {
  await sentReminder();

  await setTodo("t1", "title = 'Tên mới'");
  await changed("t1", at(TODAY, "10:05"));
  await setTodo("t1", "is_important = 0, is_urgent = 1");
  await changed("t1", at(TODAY, "10:06"));
  await setTodo("t1", "estimated_minutes = 30");
  await changed("t1", at(TODAY, "10:07"));

  assert.equal(dismissMessages().length, 0);
  assert.deepEqual(await cardKeys("t1"), [["todo_reminder", `${TODAY}T10:00`]]);
});

test("a card is removed only once, however many times the todo is saved afterwards", async () => {
  await sentReminder();
  await setTodo("t1", "time = '09:10'");

  await changed("t1", at(TODAY, "10:00", 30));
  await changed("t1", at(TODAY, "10:00", 31));
  await changed("t1", at(TODAY, "10:00", 32));

  assert.equal(dismissMessages().length, 2, "one message per device, once");
});

test("nothing is removed when no notification was ever delivered for the todo", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await fx.insertTodo(turso, { id: "t1", scheduledDate: TODAY, time: "10:00", isImportant: 1, isUrgent: 1 });
  await maintenance(at(TODAY, "09:00")); // armed, not yet due

  await setTodo("t1", "time = '09:30'");
  await changed("t1", at(TODAY, "09:05"));

  assert.equal(fake.messages.length, 0);
});

test("completing or deleting the todo is outside this feature: no removal message", async () => {
  await sentReminder();

  await setTodo("t1", "status = 'done'");
  await changed("t1", at(TODAY, "10:05"));
  await setTodo("t1", "deleted_at = '2026-06-20T03:10:00.000Z'");
  await changed("t1", at(TODAY, "10:06"));

  assert.equal(dismissMessages().length, 0);
});

test("only the todo that changed is touched: another todo's card stays", async () => {
  await fx.insertTodo(turso, { id: "t2", title: "Việc khác", scheduledDate: TODAY, time: "10:00", isImportant: 1, isUrgent: 1 });
  await sentReminder(); // arms and sends both t1 and t2 at 10:00
  assert.deepEqual(await cardKeys("t2"), [["todo_reminder", `${TODAY}T10:00`]]);

  await setTodo("t1", "time = '09:10'");
  await changed("t1", at(TODAY, "10:01"));

  assert.deepEqual(dismissMessages().map((m) => m.data?.tag), ["todo:t1", "todo:t1"]);
  assert.deepEqual(await cardKeys("t2"), [["todo_reminder", `${TODAY}T10:00`]]);
});

test("another user's devices never receive the removal", async () => {
  await fx.insertDevice(turso, OTHER_USER_ID, "reg-other");
  await sentReminder();

  await setTodo("t1", "time = '09:10'");
  await changed("t1", at(TODAY, "10:00", 30));

  assert.deepEqual(fake.targets().sort(), ["reg-A", "reg-B"]);
});

// ── the next notification arrives right away ─────────────────────────────────

test("when the next nudge is due within a few minutes it replaces the card itself: no removal message", async () => {
  await sentReminder();

  // 9:03 -> the next repeat is 10:03, three minutes away: it takes the same tag and replaces the card.
  await setTodo("t1", "time = '09:03'");
  await changed("t1", at(TODAY, "10:00", 30));

  assert.equal(dismissMessages().length, 0);
  assert.deepEqual(await cardKeys("t1"), [], "the stale card is accounted for, so a later edit cannot remove the new one");

  await dispatchAt(TODAY, "10:03");
  assert.equal(shownMessages().length, 2);
  assert.equal(shownMessages()[0].android?.notification?.tag, "todo:t1");

  await setTodo("t1", "title = 'Đổi tên sau đó'");
  await changed("t1", at(TODAY, "10:04"));
  assert.equal(dismissMessages().length, 0, "the fresh nudge is not removed by the edit that follows");
});

test("the margin: a nudge due in more than 4 minutes does not stop the removal", async () => {
  await sentReminder();

  await setTodo("t1", "time = '09:04'"); // next repeat 10:04:00, i.e. 3.5 minutes after 10:00:30 -> replaces
  await changed("t1", at(TODAY, "10:00", 30));
  assert.equal(dismissMessages().length, 0);

  fake.messages.length = 0;
  await turso.execute("UPDATE notification_jobs SET card_key = '2026-06-20T10:00' WHERE kind = 'todo_reminder'");
  await setTodo("t1", "time = '09:06'"); // next repeat 10:06:00, 5.5 minutes after 10:00:30 -> removal
  await changed("t1", at(TODAY, "10:00", 30));
  assert.equal(dismissMessages().length, 2);
});

// ── delivery contract ────────────────────────────────────────────────────────

test("the removal is only sent to registrations that exist; dead ones are pruned like for any push", async () => {
  await sentReminder();
  firebase.setMessagingClientForTests(
    fx.fakeMessaging((message) =>
      (message as { token?: string }).token === "reg-A"
        ? { ok: false, code: "messaging/registration-token-not-registered" }
        : { ok: true }
    ).client
  );

  await setTodo("t1", "time = '09:10'");
  await changed("t1", at(TODAY, "10:00", 30));

  const left = await turso.execute("SELECT registration_id FROM user_devices ORDER BY registration_id");
  assert.deepEqual(left.rows.map((row) => row.registration_id), ["reg-B"]);
});

test("a failing FCM never breaks the todo update", async () => {
  await sentReminder();
  firebase.setMessagingClientForTests({
    sendEach: async () => {
      throw new Error("network down");
    },
  });

  await setTodo("t1", "time = '09:10'");
  await assert.doesNotReject(changed("t1", at(TODAY, "10:00", 30)));
  assert.equal((await pendingNudges("t1")).length, 14, "the new schedule is armed regardless");
});

test("NOTIFY_DRY_RUN only logs: no removal reaches FCM, and the stale card is still accounted for", async () => {
  const { env } = await import("../src/config/env.js");
  await sentReminder();
  env.NOTIFY_DRY_RUN = true;
  try {
    await setTodo("t1", "time = '09:10'");
    await changed("t1", at(TODAY, "10:00", 30));
  } finally {
    env.NOTIFY_DRY_RUN = false;
  }

  assert.equal(fake.messages.length, 0);
  assert.deepEqual(await cardKeys("t1"), []);
});

test("without push configured nothing is sent and nothing throws", async () => {
  await sentReminder();
  firebase.setMessagingClientForTests(null);

  await setTodo("t1", "time = '09:10'");
  await assert.doesNotReject(changed("t1", at(TODAY, "10:00", 30)));
});

test("a data-only payload must carry data and respects the reserved FCM keys", async () => {
  assert.throws(() => firebase.validateDataPayload({ data: {} }), /at least one key/);
  assert.throws(() => firebase.validateDataPayload({ data: { from: "x" } }), /reserved/);
  assert.throws(() => firebase.validateDataPayload({ data: { "gcm.n": "x" } }), /reserved/);
  assert.throws(() => firebase.validateDataPayload({ data: { n: 5 as unknown as string } }), /strings/);
  assert.throws(() => firebase.validateDataPayload({ data: { a: "x" }, ttlMs: -1 }), /ttlMs/);
  assert.throws(() => firebase.validateDataPayload({ data: { a: "x".repeat(5000) } }), /exceeds/);
  assert.doesNotThrow(() => firebase.validateDataPayload({ data: { a: "x" }, ttlMs: 180_000 }));
});

// ── the real entry points ────────────────────────────────────────────────────

const DATE = fx.utcDateFromToday(3);
const markDelivered = (id: string, key: string) =>
  turso.execute({
    sql: `UPDATE notification_jobs SET status = 'sent', sent_at = ?, card_key = ?
          WHERE ref_id = ? AND kind = 'todo_reminder'`,
    args: [new Date().toISOString(), key, id],
  });

test("editing the time through the todo service removes the delivered card", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  const { todo } = await todosService.createTodo(USER_ID, { title: "Họp", scheduled_date: DATE, time: "10:00" });
  await markDelivered(todo.id, `${DATE}T10:00`);

  await todosService.updateTodo(USER_ID, todo.id, { time: "11:30" });
  await cards.flushDismissals();

  assert.equal(dismissMessages().length, 1);
  assert.equal(dismissMessages()[0].data?.tag, `todo:${todo.id}`);
  assert.equal(dismissMessages()[0].data?.id, todo.id);

  fake.messages.length = 0;
  await todosService.updateTodo(USER_ID, todo.id, { title: "Họp nhóm" });
  await cards.flushDismissals();
  assert.equal(dismissMessages().length, 0, "renaming afterwards removes nothing more");
});

test("editing the date through the todo service removes the delivered card", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  const { todo } = await todosService.createTodo(USER_ID, { title: "Họp", scheduled_date: DATE, time: "10:00" });
  await markDelivered(todo.id, `${DATE}T10:00`);

  await todosService.updateTodo(USER_ID, todo.id, { scheduled_date: fx.utcDateFromToday(4) });
  await cards.flushDismissals();

  assert.equal(dismissMessages().length, 1);
});

test("a sync push that changes the time removes the delivered card as well", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  const id = "sync-todo-1";
  const stamp = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();
  await processPush(USER_ID, [
    { op: "create", type: "todo", payload: { id, title: "Từ máy khác", status: "open", position: 0, scheduled_date: DATE, time: "10:00", created_at: stamp(), updated_at: stamp() } },
  ]);
  await markDelivered(id, `${DATE}T10:00`);

  await processPush(USER_ID, [{ op: "update", type: "todo", payload: { id, time: "12:00", updated_at: stamp(1000) } }]);
  await cards.flushDismissals();

  assert.equal(dismissMessages().length, 1);
  assert.equal(dismissMessages()[0].data?.tag, `todo:${id}`);
});

test("an occurrence of a recurring todo is removed under the series tag the card was sent with", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await fx.insertTodo(turso, { id: "series-root", scheduledDate: "2026-06-19", time: "08:00", status: "done" });
  await fx.insertTodo(turso, { id: "occ", scheduledDate: TODAY, time: "08:00", recurrenceTemplateId: "series-root" });
  await fx.insertRawJob(turso, { id: "j", kind: "todo_reminder", refId: "occ", runAt: runAtVn(TODAY, "08:00"), localDate: TODAY, status: "sent" });
  await turso.execute(`UPDATE notification_jobs SET card_key = '${TODAY}T08:00' WHERE id = 'j'`);

  await setTodo("occ", "time = '09:00'");
  await changed("occ", at(TODAY, "08:30"));

  assert.equal(dismissMessages().length, 1);
  assert.equal(dismissMessages()[0].data?.tag, "todo:series-root");
  assert.equal(dismissMessages()[0].data?.id, "occ");
});

// ── pure helpers ─────────────────────────────────────────────────────────────

test("the schedule key is date + time, and null when the todo has no timed reminder", () => {
  assert.equal(cards.todoCardKey({ scheduled_date: TODAY, time: "10:00", parent_id: null }), `${TODAY}T10:00`);
  assert.equal(cards.todoCardKey({ scheduled_date: TODAY, time: null, parent_id: null }), null);
  assert.equal(cards.todoCardKey({ scheduled_date: null, time: "10:00", parent_id: null }), null);
  assert.equal(cards.todoCardKey({ scheduled_date: TODAY, time: "10:00", parent_id: "p" }), null);
});

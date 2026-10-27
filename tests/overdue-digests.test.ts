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
const { runDispatch } = await import("../src/services/notification-tick.js");
const planner = await import("../src/services/notification-planner.js");
const content = await import("../src/services/notification-content.js");
const schedule = await import("../src/services/notification-schedule.js");
const { addDays, localDateTimeToUtc } = await import("../src/utils/time.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID, OTHER_USER_ID } = fx;
const VN = "Asia/Ho_Chi_Minh";
const TODAY = "2026-06-20";
const NEXT = addDays(TODAY, 1);
const PREVIOUS = addDays(TODAY, -1);

const at = (date: string, hhmm: string, seconds = 0, tz = VN): Date =>
  new Date(localDateTimeToUtc(date, hhmm, tz).getTime() + seconds * 1000);

let fake = fx.fakeMessaging();

before(async () => {
  await applyAllMigrations(turso);
});

beforeEach(async () => {
  for (const table of ["notification_jobs", "user_devices", "notification_settings", "daily_todo_logs", "daily_todo_summaries", "todo_tags"]) {
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

type TodoOverrides = Partial<Parameters<typeof fx.insertTodo>[1]>;
let counter = 0;
/** Một todo "quan trọng & không khẩn cấp" có giờ hẹn (đối tượng của tổng kết), có thể ghi đè. */
const importantTodo = async (overrides: TodoOverrides = {}): Promise<string> => {
  const id = overrides.id ?? `todo-${++counter}`;
  await fx.insertTodo(turso, { scheduledDate: TODAY, time: "09:00", isImportant: 1, isUrgent: 0, ...overrides, id });
  return id;
};

const digestRows = (kind: string, userId = USER_ID) => fx.jobsFor(turso, userId, `AND kind = '${kind}'`);
const dispatchAt = (when: Date) => runDispatch({ now: when, logger: fx.silentLogger });
const overdueMessages = () => fake.messages.filter((m) => /todo quan trọng/.test(m.notification?.title ?? ""));

// ── content ──────────────────────────────────────────────────────────────────

test("the texts are one short title with the number and one line saying what to do", () => {
  assert.deepEqual(content.buildOverdueEveningDigest(3), {
    title: "⏰ 3 todo quan trọng quá hạn",
    body: "Làm ngay hoặc dời lịch!",
  });
  assert.deepEqual(content.buildOverdueMorningDigest(1), {
    title: "⏰ 1 todo quan trọng hôm qua chưa xong",
    body: "Làm ngay hoặc dời lịch!",
  });
});

test("nothing to say when no todo is overdue", () => {
  for (const build of [content.buildOverdueEveningDigest, content.buildOverdueMorningDigest]) {
    assert.equal(build(0), null);
    assert.equal(build(-2), null);
    assert.equal(build(Number.NaN), null);
  }
  assert.equal(content.buildOverdueEveningDigest(2.9)?.title, "⏰ 2 todo quan trọng quá hạn", "whole numbers only");
});

// ── when they are sent ───────────────────────────────────────────────────────

test("17:00 the same day and 07:00 the next morning, fixed and in the user's own timezone", () => {
  const vn = schedule.resolveSettings({ timezone: VN, morning_time: null, evening_time: null });
  assert.equal(schedule.digestRunAt("digest_overdue_evening", TODAY, vn).toISOString(), at(TODAY, "17:00").toISOString());
  assert.equal(schedule.digestRunAt("digest_overdue_morning", TODAY, vn).toISOString(), at(TODAY, "07:00").toISOString());

  // The user's own morning/evening times move the other digests but not these two.
  const custom = schedule.resolveSettings({ timezone: "America/New_York", morning_time: "06:15", evening_time: "20:00" });
  assert.equal(
    schedule.digestRunAt("digest_overdue_evening", TODAY, custom).toISOString(),
    at(TODAY, "17:00", 0, "America/New_York").toISOString()
  );
  assert.equal(
    schedule.digestRunAt("digest_overdue_morning", TODAY, custom).toISOString(),
    at(TODAY, "07:00", 0, "America/New_York").toISOString()
  );
  assert.equal(schedule.digestRunAt("digest_morning", TODAY, custom).toISOString(), at(TODAY, "06:15", 0, "America/New_York").toISOString());
});

test("the planner arms both for today and tomorrow, once, only for users with a device", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");

  await planner.planAllUsers(at(TODAY, "06:00"));
  await planner.planAllUsers(at(TODAY, "06:01"));

  for (const [kind, hhmm] of [["digest_overdue_evening", "17:00"], ["digest_overdue_morning", "07:00"]] as const) {
    const rows = await digestRows(kind);
    assert.deepEqual(rows.map((row) => [row.local_date, row.run_at]), [
      [TODAY, at(TODAY, hhmm).toISOString()],
      [NEXT, at(NEXT, hhmm).toISOString()],
    ]);
    assert.equal((await digestRows(kind, OTHER_USER_ID)).length, 0, "no device, no jobs");
  }
});

// ── 17:00 the same day ───────────────────────────────────────────────────────

test("17:00 counts only today's important-but-not-urgent todos whose time has already passed", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await fx.insertDevice(turso, USER_ID, "reg-B", { id: "device-B", kind: "fid" });
  // Counted:
  await importantTodo({ time: "09:00" });
  await importantTodo({ time: "16:59", status: "in_progress" });
  // Not counted: wrong quadrant.
  await importantTodo({ isImportant: 1, isUrgent: 1 });
  await importantTodo({ isImportant: 0, isUrgent: 1 });
  await importantTodo({ isImportant: 0, isUrgent: 0 });
  await importantTodo({ isImportant: null, isUrgent: null });
  await importantTodo({ isImportant: 1, isUrgent: null });
  // Not counted: not overdue yet, or not a todo that should count.
  await importantTodo({ time: "17:00" });
  await importantTodo({ time: "18:30" });
  await importantTodo({ time: null });
  await importantTodo({ status: "done" });
  await importantTodo({ status: "archived" });
  await importantTodo({ deletedAt: "2026-06-19T00:00:00.000Z" });
  await importantTodo({ scheduledDate: PREVIOUS });
  await importantTodo({ scheduledDate: NEXT });
  const parent = await importantTodo();
  await importantTodo({ parentId: parent, time: null });
  await importantTodo({ userId: OTHER_USER_ID });
  // (`parent` itself is a counted todo: it is a normal top-level one.)

  await planner.planAllUsers(at(TODAY, "06:00"));
  await dispatchAt(at(TODAY, "17:00", 10));

  const messages = overdueMessages();
  assert.equal(messages.length, 2, "one push per device");
  assert.deepEqual(fake.targets().filter((_, i) => /quá hạn/.test(fake.messages[i].notification?.title ?? "")).sort(), ["reg-A", "reg-B"]);
  const [message] = messages;
  assert.equal(message.notification?.title, "⏰ 3 todo quan trọng quá hạn");
  assert.equal(message.notification?.body, "Làm ngay hoặc dời lịch!");
  assert.deepEqual(message.data, { type: "digest_todos", id: TODAY, date: TODAY });
  assert.equal(message.android?.priority, "high");
  assert.equal(message.android?.ttl, 3_600_000);
  assert.equal(message.android?.notification?.channelId, "todo_reminders");
  assert.equal((await digestRows("digest_overdue_evening"))[0].status, "sent");
});

test("17:00: nothing overdue means no push, and the job is closed", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await importantTodo({ time: "18:00" });
  await importantTodo({ status: "done" });
  await importantTodo({ isUrgent: 1 });

  await planner.planAllUsers(at(TODAY, "06:00"));
  await dispatchAt(at(TODAY, "17:00", 10));

  assert.equal(overdueMessages().length, 0);
  assert.equal((await digestRows("digest_overdue_evening")).find((r) => r.local_date === TODAY)?.status, "cancelled");
});

test("the count is taken when the push is sent, not when the job was planned", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  const first = await importantTodo({ time: "09:00" });
  await importantTodo({ time: "10:00" });
  await planner.planAllUsers(at(TODAY, "06:00"));

  // At 16:00 the user finishes one, and reclassifies another as urgent.
  await turso.execute({ sql: "UPDATE todos SET status = 'done' WHERE id = ?", args: [first] });
  await importantTodo({ time: "11:00", isUrgent: 1 });
  await importantTodo({ time: "12:00" });
  await dispatchAt(at(TODAY, "17:00", 10));

  assert.equal(overdueMessages()[0].notification?.title, "⏰ 2 todo quan trọng quá hạn");
});

test("a push that would be more than an hour late is dropped, not sent", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await importantTodo({ time: "09:00" });
  await planner.planAllUsers(at(TODAY, "06:00"));

  await dispatchAt(at(TODAY, "18:30"));

  assert.equal(overdueMessages().length, 0);
  assert.equal((await digestRows("digest_overdue_evening")).find((r) => r.local_date === TODAY)?.status, "missed");
});

// ── 07:00 the next morning ───────────────────────────────────────────────────

test("07:00 counts yesterday's important-but-not-urgent todos that are still not done, at any time of day", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await importantTodo({ time: "09:00" });
  await importantTodo({ time: "20:00" });
  await importantTodo({ time: "23:30", status: "in_progress" });
  // Not counted:
  await importantTodo({ time: "09:00", status: "done" });
  await importantTodo({ time: "09:00", isUrgent: 1 });
  await importantTodo({ time: null });
  await importantTodo({ scheduledDate: PREVIOUS }); // two days ago: it was already reported yesterday
  await importantTodo({ scheduledDate: NEXT }); // today's own list is not "yesterday"

  await planner.planAllUsers(at(NEXT, "06:00"));
  await dispatchAt(at(NEXT, "07:00", 10));

  const [message] = overdueMessages();
  assert.equal(message.notification?.title, "⏰ 3 todo quan trọng hôm qua chưa xong");
  assert.equal(message.notification?.body, "Làm ngay hoặc dời lịch!");
  assert.deepEqual(message.data, { type: "digest_todos", id: NEXT, date: NEXT });
  assert.equal((await digestRows("digest_overdue_morning")).find((r) => r.local_date === NEXT)?.status, "sent");
});

test("07:00: yesterday's list fully done means no push", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await importantTodo({ status: "done" });
  await importantTodo({ time: "20:00", status: "done" });

  await planner.planAllUsers(at(NEXT, "06:00"));
  await dispatchAt(at(NEXT, "07:00", 10));

  assert.equal(overdueMessages().length, 0);
});

test("a todo is reported twice at most: at 17:00 that day and at 07:00 the next morning", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await importantTodo({ time: "09:00" });
  const day = (offset: number) => addDays(TODAY, offset);

  for (let offset = 0; offset < 4; offset++) {
    await planner.planAllUsers(at(day(offset), "06:00"));
    await dispatchAt(at(day(offset), "07:00", 10));
    await dispatchAt(at(day(offset), "17:00", 10));
  }

  const titles = overdueMessages().map((m) => m.notification?.title);
  assert.deepEqual(titles, [
    "⏰ 1 todo quan trọng quá hạn", // 17:00 on the day
    "⏰ 1 todo quan trọng hôm qua chưa xong", // 07:00 the next morning
  ]);
});

// ── people and zones ─────────────────────────────────────────────────────────

test("each person gets their own count and only their own todos are counted", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await fx.insertDevice(turso, OTHER_USER_ID, "reg-B");
  await importantTodo({ time: "09:00" });
  await importantTodo({ userId: OTHER_USER_ID, time: "09:00" });
  await importantTodo({ userId: OTHER_USER_ID, time: "10:00" });
  await importantTodo({ userId: OTHER_USER_ID, time: "11:00" });

  await planner.planAllUsers(at(TODAY, "06:00"));
  await dispatchAt(at(TODAY, "17:00", 10));

  // (The regular 17:00 "Tổng kết todo hôm nay" is sent to the same devices: look at ours only.)
  const targets = fake.targets();
  const byTarget = new Map(
    fake.messages.flatMap((m, i) =>
      /todo quan trọng/.test(m.notification?.title ?? "") ? [[targets[i], m.notification?.title] as const] : []
    )
  );
  assert.equal(byTarget.get("reg-A"), "⏰ 1 todo quan trọng quá hạn");
  assert.equal(byTarget.get("reg-B"), "⏰ 3 todo quan trọng quá hạn");
});

test("17:00 is the user's own 17:00: a New York user is notified at 17:00 New York time", async () => {
  const NY = "America/New_York";
  await turso.execute({ sql: "UPDATE users SET timezone = ? WHERE id = ?", args: [NY, USER_ID] });
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await importantTodo({ time: "09:00" });

  await planner.planAllUsers(at(TODAY, "06:00", 0, NY));
  const row = (await digestRows("digest_overdue_evening")).find((r) => r.local_date === TODAY);
  assert.equal(row?.run_at, at(TODAY, "17:00", 0, NY).toISOString());

  await dispatchAt(at(TODAY, "17:00", 10, VN)); // 17:00 in Vietnam is the middle of the night there
  assert.equal(overdueMessages().length, 0);
  await dispatchAt(at(TODAY, "17:00", 10, NY));
  assert.equal(overdueMessages().length, 1);
});

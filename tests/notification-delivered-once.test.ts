/**
 * Một tin ĐÃ gửi thì không bao giờ được gửi lại, dù việc ghi kết quả của nó lỗi.
 *
 * Sự cố thật: cơ sở dữ liệu chưa áp migration 0026 (thiếu cột `notification_jobs.card_key`). Việc ghi
 * `sent` kèm khóa lịch ném lỗi SAU khi tin đã tới FCM, tick coi đó là "gửi lỗi tạm" và gửi lại sau 2 phút,
 * tối đa 3 lần: người dùng nhận cùng một thông báo ở giờ hẹn, +2 phút và +4 phút.
 */
import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";
process.env.GOOGLE_APPLICATION_CREDENTIALS = "./does-not-exist-service-account.json";

const { turso } = await import("../src/config/db.js");
const firebase = await import("../src/services/firebase.js");
const { runDispatch, runMaintenance } = await import("../src/services/notification-tick.js");
const repeat = await import("../src/services/reminder-repeat.js");
const { localDateTimeToUtc } = await import("../src/utils/time.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID } = fx;
const DAY = "2026-06-20";
const at = (hhmm: string, seconds = 0): Date =>
  new Date(localDateTimeToUtc(DAY, hhmm, "Asia/Ho_Chi_Minh").getTime() + seconds * 1000);

const SLOT_INDEX_SQL = `CREATE UNIQUE INDEX uq_notification_jobs_slot
  ON notification_jobs(user_id, kind, ref_id, run_at)
  WHERE kind IN ('todo_overdue', 'checklist_overdue', 'checklist_running', 'todo_reminder_repeat')`;

let fake = fx.fakeMessaging();
let errors: string[] = [];
const logger = {
  info() {},
  warn() {},
  error: (obj: object, message: string) => {
    errors.push(`${message} ${JSON.stringify(obj)}`);
  },
};

before(async () => {
  await applyAllMigrations(turso);
});

beforeEach(async () => {
  for (const table of ["notification_jobs", "todo_timers", "notification_settings", "user_devices"]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await turso.execute("DELETE FROM todos");
  await turso.execute(`DELETE FROM users WHERE id = '${USER_ID}'`);
  await fx.insertUser(turso, USER_ID);
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });

  fake = fx.fakeMessaging();
  errors = [];
  firebase.setMessagingClientForTests(fake.client);
  firebase.setPushLogger(logger);
});

const armTodo = async (flags: { isImportant: number; isUrgent: number } = { isImportant: 1, isUrgent: 1 }) => {
  await fx.insertTodo(turso, { id: "t1", scheduledDate: DAY, time: "10:00", ...flags });
  await runMaintenance({ now: at("09:00"), logger });
};

const dispatchAt = (hhmm: string) => runDispatch({ now: at(hhmm, 10), logger });
const todoPushes = () => fake.messages.filter((m) => m.data?.type === "todo");
const reminderJob = async () => (await fx.jobsFor(turso, USER_ID, "AND kind = 'todo_reminder'"))[0];

test("a failing bookkeeping write after delivery never resends the notification", async () => {
  await armTodo({ isImportant: 0, isUrgent: 0 });
  await turso.execute(
    `CREATE TRIGGER block_sent BEFORE UPDATE ON notification_jobs WHEN NEW.status = 'sent'
     BEGIN SELECT RAISE(ABORT, 'boom'); END`
  );
  try {
    for (const hhmm of ["10:00", "10:02", "10:04", "10:06"]) await dispatchAt(hhmm);
  } finally {
    await turso.execute("DROP TRIGGER block_sent");
  }

  assert.equal(todoPushes().length, 1, "delivered once, not at +2 and +4 minutes");
  assert.equal((await reminderJob()).attempts, 1);
  assert.notEqual((await reminderJob()).status, "pending", "never released for a retry");
  assert.ok(errors.some((e) => e.startsWith("could not mark a delivered notification as sent")), errors.join("\n"));
});

test("a failing after-send step is only logged: the job is still recorded as sent", async () => {
  // An important+urgent reminder schedules its repeat after sending; make that insert fail.
  await armTodo();
  await turso.execute("DROP INDEX uq_notification_jobs_slot");
  try {
    for (const hhmm of ["10:00", "10:02", "10:04"]) await dispatchAt(hhmm);
  } finally {
    await turso.execute(SLOT_INDEX_SQL);
  }

  assert.equal(todoPushes().length, 1);
  assert.equal((await reminderJob()).status, "sent");
  assert.ok(errors.some((e) => e.startsWith("reminder repeat scheduling failed")), errors.join("\n"));
});

test("one failing maintenance step does not block the others, and does not throw", async () => {
  // Needs slots for the hourly nudge of an important+urgent todo; without the slot index that insert fails.
  await fx.insertTodo(turso, { id: "t1", scheduledDate: DAY, time: "10:00", isImportant: 1, isUrgent: 1 });
  await fx.insertRawJob(turso, {
    id: "old-digest",
    kind: "digest_morning",
    localDate: "2026-06-19",
    runAt: new Date(at("10:30").getTime() - 24 * 3_600_000).toISOString(),
  });
  await turso.execute("DROP INDEX uq_notification_jobs_slot");
  try {
    await assert.doesNotReject(() => runMaintenance({ now: at("10:30"), logger }));
  } finally {
    await turso.execute(SLOT_INDEX_SQL);
  }

  assert.ok(
    errors.some((e) => e.startsWith("notification maintenance step failed") && e.includes("backfill_todo_overdue")),
    errors.join("\n")
  );
  const [old] = await fx.jobsFor(turso, USER_ID, "AND id = 'old-digest'");
  assert.equal(old.status, "missed", "the later mark_missed step still ran");
});

test("reminder-ack does not fail with a 500 when its marker cannot be written", async () => {
  await armTodo();
  await turso.execute("DROP INDEX uq_notification_jobs_slot");
  try {
    const result = await repeat.acknowledgeReminder(USER_ID, "t1", at("10:00", 0.5));
    assert.deepEqual(result, { todo_id: "t1", cancelled: 0 });
  } finally {
    await turso.execute(SLOT_INDEX_SQL);
  }
  assert.ok(errors.some((e) => e.startsWith("reminder ack marker failed")), errors.join("\n"));
});

test("a database without the card_key column (migration 0026 missing) still delivers exactly once", async () => {
  await armTodo({ isImportant: 0, isUrgent: 0 });
  await turso.execute("ALTER TABLE notification_jobs DROP COLUMN card_key");
  try {
    for (const hhmm of ["10:00", "10:02", "10:04", "10:06"]) await dispatchAt(hhmm);
  } finally {
    await turso.execute("ALTER TABLE notification_jobs ADD COLUMN card_key TEXT");
  }

  assert.equal(todoPushes().length, 1, "one push, not three");
  const job = await reminderJob();
  assert.equal(job.status, "sent");
  assert.equal(job.attempts, 1);
  assert.ok(errors.some((e) => e.includes("no such column: card_key")), "the log names the real cause");
});

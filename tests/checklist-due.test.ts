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
const { runTick, runDispatch } = await import("../src/services/notification-tick.js");
const planner = await import("../src/services/notification-planner.js");
const jobsRepo = await import("../src/repositories/notification-jobs.js");
const schedulesRepo = await import("../src/repositories/checklist-schedules.js");
const schedulesService = await import("../src/services/checklist-schedules.js");
const checklistsService = await import("../src/services/checklists.js");
const usersService = await import("../src/services/users.js");
const triggers = await import("../src/services/notification-triggers.js");
const { reconcileChecklistDue } = await import("../src/services/checklist-due.js");
const { addDays, localDateOf, localDateTimeToUtc } = await import("../src/utils/time.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID, OTHER_USER_ID } = fx;
const VN = "Asia/Ho_Chi_Minh";
const TPL = "tst-rời-nhà";
const MINUTE = 60_000;

// 2026-06-20 (a Saturday) 07:00 in Vietnam.
const NOW = new Date("2026-06-20T00:00:00.000Z");
// The slot at 07:30 in Vietnam, and a moment just after it.
const SLOT = "2026-06-20T00:30:00.000Z";
const SEND_AT = new Date("2026-06-20T00:30:20.000Z");

const iso = (d: Date): string => d.toISOString();
const plus = (d: Date, minutes: number): Date => new Date(d.getTime() + minutes * MINUTE);

type Fields = Parameters<typeof schedulesRepo.upsertSchedule>[2];
const dailyFrom = (startDate: string, overrides: Partial<Fields> = {}): Fields => ({
  start_date: startDate,
  time: "07:30",
  recurrence_type: "daily",
  recurrence_interval: 1,
  recurrence_days_of_week: null,
  recurrence_end_date: null,
  enabled: true,
  ...overrides,
});

const dueJobs = (userId = USER_ID) =>
  fx.jobsFor(turso, userId, "AND kind = 'checklist_due'");

const job = (date: string, templateId = TPL, userId = USER_ID) =>
  jobsRepo.getOccurrenceJob(userId, "checklist_due", templateId, date);

const dueMessages = () => fake.messages.filter((m) => m.data?.type === "checklist_due");

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
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await turso.execute("DELETE FROM checklist_template_items WHERE template_id LIKE 'tst-%'");
  await turso.execute("DELETE FROM checklist_templates WHERE id LIKE 'tst-%'");
  await turso.execute("UPDATE todos SET parent_id = NULL, trigger_after_todo_id = NULL");
  await turso.execute("DELETE FROM todos");
  await turso.execute(`DELETE FROM users WHERE id IN ('${USER_ID}', '${OTHER_USER_ID}')`);

  await fx.insertUser(turso, USER_ID);
  await fx.insertUser(turso, OTHER_USER_ID, { timezone: "Pacific/Auckland" });
  await fx.insertTemplateWithItems(turso, { id: TPL, title: "Rời nhà", itemCount: 3 });

  fake = fx.fakeMessaging();
  firebase.setMessagingClientForTests(fake.client);
  firebase.setPushLogger(fx.silentLogger);
});

const setup = async (fields: Fields = dailyFrom("2026-06-20")) => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await fx.insertDevice(turso, USER_ID, "reg-B", { id: "device-B", kind: "fid" });
  await schedulesRepo.upsertSchedule(USER_ID, TPL, fields);
};

// ── planner ──────────────────────────────────────────────────────────────────

test("the planner creates one job for today and one for tomorrow, at the schedule time in the user's zone", async () => {
  await setup();

  await planner.planAllUsers(NOW);

  const jobs = await dueJobs();
  assert.deepEqual(
    jobs.map((j) => [j.ref_id, j.local_date, j.run_at, j.status, j.target_device_id]),
    [
      [TPL, "2026-06-20", SLOT, "pending", null],
      [TPL, "2026-06-21", "2026-06-21T00:30:00.000Z", "pending", null],
    ]
  );
});

test("the planner is idempotent: running again or later creates nothing new", async () => {
  await setup();

  await planner.planAllUsers(NOW);
  assert.equal((await planner.planAllUsers(NOW)) >= 0, true);
  const first = await dueJobs();
  await planner.planAllUsers(plus(NOW, 5));
  await planner.planAllUsers(plus(NOW, 10));

  const after = await dueJobs();
  assert.equal(after.length, 2);
  assert.deepEqual(after.map((j) => j.id), first.map((j) => j.id), "the very same rows");
});

test("in steady state the planner reads but does not write the checklist jobs", async () => {
  await setup();
  await planner.planAllUsers(NOW);

  const originalExecute = turso.execute.bind(turso);
  const writes: string[] = [];
  (turso as { execute: unknown }).execute = (statement: unknown) => {
    const sql = typeof statement === "object" && statement ? String((statement as { sql?: string }).sql) : String(statement);
    if (/checklist_due|INSERT INTO notification_jobs/.test(sql) && /^\s*(INSERT|UPDATE)/i.test(sql)) writes.push(sql);
    return originalExecute(statement as never);
  };
  try {
    await planner.planAllUsers(plus(NOW, 1));
  } finally {
    (turso as { execute: unknown }).execute = originalExecute;
  }
  assert.deepEqual(writes, []);
});

test("a slot already past the 30 minute lateness window is skipped; one exactly at the limit is created", async () => {
  await setup();

  await planner.planAllUsers(plus(new Date(SLOT), 31));
  assert.deepEqual((await dueJobs()).map((j) => j.local_date), ["2026-06-21"], "today's slot skipped");

  await turso.execute("DELETE FROM notification_jobs");
  await planner.planAllUsers(plus(new Date(SLOT), 30));
  assert.deepEqual((await dueJobs()).map((j) => j.local_date), ["2026-06-20", "2026-06-21"]);
});

test("a day that already has a completed run gets no job; abandoned, deleted, other-day and other-checklist runs do not count", async () => {
  await setup();
  await fx.insertTemplateWithItems(turso, { id: "tst-other", itemCount: 1 });
  await fx.insertRun(turso, { id: "r-abandoned", templateId: TPL, status: "abandoned", completedAt: "2026-06-20T00:05:00.000Z" });
  await fx.insertRun(turso, { id: "r-deleted", templateId: TPL, completedAt: "2026-06-20T00:06:00.000Z", deletedAt: "2026-06-20T00:07:00.000Z" });
  await fx.insertRun(turso, { id: "r-yesterday", templateId: TPL, completedAt: "2026-06-19T16:30:00.000Z" }); // 23:30 on the 19th in VN
  await fx.insertRun(turso, { id: "r-other-checklist", templateId: "tst-other", completedAt: "2026-06-20T00:08:00.000Z" });

  await planner.planAllUsers(NOW);
  assert.deepEqual((await dueJobs()).map((j) => j.local_date), ["2026-06-20", "2026-06-21"], "none of those count as done");

  await turso.execute("DELETE FROM notification_jobs");
  await fx.insertRun(turso, { id: "r-done", templateId: TPL, completedAt: "2026-06-20T00:10:00.000Z" });
  await planner.planAllUsers(NOW);
  assert.deepEqual((await dueJobs()).map((j) => j.local_date), ["2026-06-21"], "today is done");
});

test("nothing is planned for a disabled schedule, a deleted schedule, a deleted checklist, a disabled user or a user without devices", async () => {
  await setup();
  await schedulesRepo.upsertSchedule(USER_ID, TPL, dailyFrom("2026-06-20", { enabled: false }));
  await planner.planAllUsers(NOW);
  assert.equal((await dueJobs()).length, 0, "disabled schedule");

  await schedulesRepo.upsertSchedule(USER_ID, TPL, dailyFrom("2026-06-20"));
  await schedulesRepo.softDeleteSchedule(USER_ID, TPL);
  await planner.planAllUsers(NOW);
  assert.equal((await dueJobs()).length, 0, "deleted schedule");

  await schedulesRepo.upsertSchedule(USER_ID, TPL, dailyFrom("2026-06-20"));
  await turso.execute({ sql: "UPDATE checklist_templates SET deleted_at = ? WHERE id = ?", args: ["2026-06-19T00:00:00.000Z", TPL] });
  await planner.planAllUsers(NOW);
  assert.equal((await dueJobs()).length, 0, "deleted checklist");
  await turso.execute({ sql: "UPDATE checklist_templates SET deleted_at = NULL WHERE id = ?", args: [TPL] });

  await turso.execute({ sql: "UPDATE users SET deleted_at = ? WHERE id = ?", args: ["2026-06-19T00:00:00.000Z", USER_ID] });
  await planner.planAllUsers(NOW);
  assert.equal((await dueJobs()).length, 0, "disabled user");
  await turso.execute({ sql: "UPDATE users SET deleted_at = NULL WHERE id = ?", args: [USER_ID] });

  await turso.execute("DELETE FROM user_devices");
  await planner.planAllUsers(NOW);
  assert.equal((await dueJobs()).length, 0, "no devices");
});

test("each user gets their own jobs on the same shared checklist, in their own time zone", async () => {
  await fx.insertSystemTemplate(turso, { id: "tst-sys", title: "Mẫu chung", itemCount: 2 });
  await fx.insertDevice(turso, USER_ID, "reg-vn");
  await fx.insertDevice(turso, OTHER_USER_ID, "reg-nz");
  await schedulesRepo.upsertSchedule(USER_ID, "tst-sys", dailyFrom("2026-06-20"));
  await schedulesRepo.upsertSchedule(OTHER_USER_ID, "tst-sys", dailyFrom("2026-06-20"));

  await planner.planAllUsers(NOW);

  const vn = await dueJobs(USER_ID);
  const nz = await dueJobs(OTHER_USER_ID);
  assert.deepEqual(vn.map((j) => j.run_at), [SLOT, "2026-06-21T00:30:00.000Z"]);
  // Auckland is UTC+12 in June: at 00:00Z it is already 12:00 on the 20th, so 07:30 local on the
  // 20th (2026-06-19T19:30Z) is more than 30 minutes ago and is skipped; the 21st is created.
  assert.deepEqual(nz.map((j) => [j.local_date, j.run_at]), [["2026-06-21", "2026-06-20T19:30:00.000Z"]]);
});

test("the planner repairs a job whose time drifted and re-arms a cancelled one that is valid again, but leaves sent ones alone", async () => {
  await setup();
  await planner.planAllUsers(NOW);
  await turso.execute({ sql: "UPDATE notification_jobs SET run_at = ? WHERE kind = 'checklist_due' AND local_date = '2026-06-20'", args: ["2026-06-20T05:00:00.000Z"] });
  await turso.execute("UPDATE notification_jobs SET status = 'cancelled' WHERE kind = 'checklist_due' AND local_date = '2026-06-21'");

  await planner.planAllUsers(NOW);

  assert.equal((await job("2026-06-20"))?.run_at, SLOT, "drifted time repaired");
  assert.equal((await job("2026-06-21"))?.status, "pending", "valid again -> armed");

  await turso.execute("UPDATE notification_jobs SET status = 'sent' WHERE kind = 'checklist_due' AND local_date = '2026-06-20'");
  await planner.planAllUsers(NOW);
  assert.equal((await job("2026-06-20"))?.status, "sent", "a sent job is never re-armed");
});

// ── hooks ────────────────────────────────────────────────────────────────────

const tomorrow = (): string => addDays(localDateOf(new Date(), VN), 1);
const runAtOf = (date: string, hhmm: string): string => iso(localDateTimeToUtc(date, hhmm, VN));

test("creating a schedule through the service creates the job; changing the time moves the SAME row", async () => {
  const date = tomorrow();
  await schedulesService.putSchedule(USER_ID, TPL, dailyFrom(date));

  assert.equal((await job(date))?.status, "pending");
  assert.equal((await job(date))?.run_at, runAtOf(date, "07:30"));
  const firstId = (await job(date))?.id;

  await schedulesService.putSchedule(USER_ID, TPL, dailyFrom(date, { time: "08:45" }));
  assert.equal((await job(date))?.run_at, runAtOf(date, "08:45"));
  assert.equal((await job(date))?.id, firstId, "re-timed in place, not duplicated");
  assert.equal((await dueJobs()).length, 1);
});

test("disabling cancels the pending job, enabling brings it back, deleting cancels again", async () => {
  const date = tomorrow();
  await schedulesService.putSchedule(USER_ID, TPL, dailyFrom(date));

  await schedulesService.putSchedule(USER_ID, TPL, dailyFrom(date, { enabled: false }));
  assert.equal((await job(date))?.status, "cancelled");

  await schedulesService.putSchedule(USER_ID, TPL, dailyFrom(date, { enabled: true }));
  assert.equal((await job(date))?.status, "pending");

  await schedulesService.deleteSchedule(USER_ID, TPL);
  assert.equal((await job(date))?.status, "cancelled");

  await schedulesService.putSchedule(USER_ID, TPL, dailyFrom(date));
  assert.equal((await job(date))?.status, "pending", "recreating the schedule re-arms the same slot");
});

test("a per-day override re-times that day's job; removing it restores the schedule time", async () => {
  const date = tomorrow();
  await schedulesService.putSchedule(USER_ID, TPL, dailyFrom(date));

  await schedulesService.putOccurrence(USER_ID, TPL, date, "21:15");
  assert.equal((await job(date))?.run_at, runAtOf(date, "21:15"));
  assert.equal((await dueJobs()).length, 1);

  await schedulesService.deleteOccurrence(USER_ID, TPL, date);
  assert.equal((await job(date))?.run_at, runAtOf(date, "07:30"));
});

test("changing the rule so a day no longer occurs cancels that day's job", async () => {
  const date = tomorrow();
  await schedulesService.putSchedule(USER_ID, TPL, dailyFrom(date));
  assert.equal((await job(date))?.status, "pending");

  await schedulesService.putSchedule(USER_ID, TPL, dailyFrom(addDays(date, 3)));
  assert.equal((await job(date))?.status, "cancelled");
});

test("deleting the checklist cancels its pending job and soft-deletes its schedule", async () => {
  const date = tomorrow();
  await schedulesService.putSchedule(USER_ID, TPL, dailyFrom(date));
  await turso.execute({ sql: "UPDATE checklist_templates SET user_id = ?, is_system = 0 WHERE id = ?", args: [USER_ID, TPL] });

  await checklistsService.deleteTemplate(USER_ID, TPL);

  assert.equal((await job(date))?.status, "cancelled");
  assert.equal(await schedulesRepo.getLiveSchedule(USER_ID, TPL), null, "the schedule goes with it");
});

test("a run completing on a scheduled day cancels that day's job; deleting that run brings it back", async () => {
  const date = tomorrow();
  await schedulesService.putSchedule(USER_ID, TPL, dailyFrom(date));
  assert.equal((await job(date))?.status, "pending");

  await fx.insertRun(turso, { id: "r1", templateId: TPL, completedAt: runAtOf(date, "12:00") });
  await triggers.onChecklistRunChanged(USER_ID, "r1");
  assert.equal((await job(date))?.status, "cancelled", "done early -> no reminder");

  await turso.execute({ sql: "UPDATE checklist_runs SET deleted_at = ? WHERE id = 'r1'", args: [iso(new Date())] });
  await triggers.onChecklistRunChanged(USER_ID, "r1");
  assert.equal((await job(date))?.status, "pending", "the run is gone -> the day is not done any more");
});

test("changing the user's time zone moves the pending jobs to the new zone", async () => {
  const date = tomorrow();
  await schedulesService.putSchedule(USER_ID, TPL, dailyFrom(date));

  await usersService.updateUserProfile(USER_ID, { timezone: "America/New_York" });

  const pending = (await dueJobs()).filter((j) => j.status === "pending");
  assert.ok(pending.length > 0);
  for (const j of pending) {
    assert.equal(
      j.run_at,
      iso(localDateTimeToUtc(String(j.local_date), "07:30", "America/New_York")),
      `job for ${j.local_date}`
    );
  }
  assert.ok(
    pending.every((j) => j.run_at !== runAtOf(String(j.local_date), "07:30")),
    "none still carries the Vietnam time"
  );
});

// ── sending ──────────────────────────────────────────────────────────────────

const armed = async (fields: Fields = dailyFrom("2026-06-20")) => {
  await setup(fields);
  await reconcileChecklistDue(USER_ID, TPL, NOW);
  assert.equal((await job("2026-06-20"))?.status, "pending");
  assert.equal((await job("2026-06-20"))?.run_at, SLOT);
};

test("the push goes to EVERY device with the checklist's own title and the step count", async () => {
  await armed();

  await runTick({ now: SEND_AT, logger: fx.silentLogger });

  assert.equal((await job("2026-06-20"))?.status, "sent");
  const messages = dueMessages();
  assert.deepEqual(messages.map((m) => (m as { token?: string; fid?: string }).token ?? (m as { fid?: string }).fid).sort(), ["reg-A", "reg-B"]);
  const [message] = messages;
  assert.equal(message.notification?.title, "Rời nhà");
  assert.equal(message.notification?.body, "Đến giờ thực hiện · 3 bước");
  assert.deepEqual(message.data, { type: "checklist_due", id: TPL, date: "2026-06-20" });
  assert.equal(message.android?.priority, "high");
  assert.equal(message.android?.ttl, 3_600_000);
  assert.equal(message.android?.notification?.channelId, "checklist_reminders");
  for (const value of Object.values(message.data ?? {})) assert.equal(typeof value, "string");
});

test("it is sent once: a later tick does not repeat it, and tomorrow's job is untouched", async () => {
  await armed();
  await runTick({ now: SEND_AT, logger: fx.silentLogger });
  await runTick({ now: plus(SEND_AT, 1), logger: fx.silentLogger });
  await runDispatch({ now: plus(SEND_AT, 2), logger: fx.silentLogger });

  assert.equal(dueMessages().filter((m) => m.data?.date === "2026-06-20").length, 2, "one per device, once");
  assert.equal((await job("2026-06-21"))?.status, "pending");
});

test("a checklist without steps says only the base text; deleted steps are not counted", async () => {
  await armed();
  await turso.execute({ sql: "UPDATE checklist_template_items SET deleted_at = ? WHERE id = ?", args: ["2026-06-19T00:00:00.000Z", `${TPL}-item-1`] });
  await runDispatch({ now: SEND_AT, logger: fx.silentLogger });
  assert.equal(dueMessages()[0].notification?.body, "Đến giờ thực hiện · 2 bước");

  fake.messages.length = 0;
  await turso.execute("UPDATE checklist_template_items SET deleted_at = '2026-06-19T00:00:00.000Z' WHERE template_id = '" + TPL + "'");
  await turso.execute("UPDATE notification_jobs SET status = 'pending', attempts = 0, locked_at = NULL, sent_at = NULL WHERE kind = 'checklist_due' AND local_date = '2026-06-20'");
  await runDispatch({ now: plus(SEND_AT, 1), logger: fx.silentLogger });
  assert.equal(dueMessages()[0].notification?.body, "Đến giờ thực hiện");
});

test("a job later than 30 minutes is dropped as missed, never sent", async () => {
  await armed();

  await runDispatch({ now: plus(new Date(SLOT), 31), logger: fx.silentLogger });

  assert.equal((await job("2026-06-20"))?.status, "missed");
  assert.equal(dueMessages().length, 0);
});

const invalidations: Array<[string, () => Promise<void>]> = [
  ["the schedule was turned off", () => turso.execute("UPDATE checklist_schedules SET enabled = 0").then(() => undefined)],
  ["the schedule was deleted", () => turso.execute("UPDATE checklist_schedules SET deleted_at = '2026-06-20T00:10:00.000Z'").then(() => undefined)],
  ["the checklist was deleted", () => turso.execute({ sql: "UPDATE checklist_templates SET deleted_at = '2026-06-20T00:10:00.000Z' WHERE id = ?", args: [TPL] }).then(() => undefined)],
  ["a run was completed that day", () => fx.insertRun(turso, { id: "r-today", templateId: TPL, completedAt: "2026-06-20T00:10:00.000Z" })],
  ["the day's time was overridden", () => schedulesRepo.upsertOverride(USER_ID, TPL, "2026-06-20", "09:00").then(() => undefined)],
  ["that day was paused", () => turso.execute("UPDATE checklist_schedules SET paused_from = '2026-06-19', paused_until = '2026-06-21'").then(() => undefined)],
  ["the schedule time changed", () => turso.execute("UPDATE checklist_schedules SET time = '08:00'").then(() => undefined)],
  ["the schedule now ends before that day", () => turso.execute("UPDATE checklist_schedules SET recurrence_end_date = '2026-06-19', start_date = '2026-06-10'").then(() => undefined)],
  ["the schedule now starts after that day", () => turso.execute("UPDATE checklist_schedules SET start_date = '2026-06-25'").then(() => undefined)],
  ["the weekday no longer matches", () => turso.execute("UPDATE checklist_schedules SET recurrence_type = 'weekly', recurrence_days_of_week = '1', start_date = '2026-06-15'").then(() => undefined)],
  ["the user was disabled", () => turso.execute({ sql: "UPDATE users SET deleted_at = '2026-06-20T00:10:00.000Z' WHERE id = ?", args: [USER_ID] }).then(() => undefined)],
];

for (const [label, mutate] of invalidations) {
  test(`re-validation right before sending: not sent when ${label}`, async () => {
    await armed();
    await mutate();

    // Fast path only (no planner), so nothing can quietly repair the job first.
    await runDispatch({ now: SEND_AT, logger: fx.silentLogger });

    assert.equal(dueMessages().length, 0, "nothing was sent");
    assert.equal((await job("2026-06-20"))?.status, "cancelled");
  });
}

test("the same re-validation also protects the external tick path", async () => {
  await armed();
  await turso.execute("UPDATE checklist_schedules SET enabled = 0");
  await runTick({ now: SEND_AT, logger: fx.silentLogger });
  assert.equal(dueMessages().length, 0);
});

test("a one-time schedule (no repeat) fires exactly once", async () => {
  await armed(dailyFrom("2026-06-20", { recurrence_type: null, recurrence_interval: null }));
  assert.equal((await job("2026-06-21")), null, "tomorrow is not an occurrence");
  await runDispatch({ now: SEND_AT, logger: fx.silentLogger });
  assert.equal(dueMessages().length, 2);
});

test("an override that moves the day's time later re-times the pending job instead of firing early", async () => {
  await armed();
  // The service hook uses the real clock, so drive the reconcile with the test clock instead.
  await schedulesRepo.upsertOverride(USER_ID, TPL, "2026-06-20", "09:00");
  await reconcileChecklistDue(USER_ID, TPL, NOW);
  assert.equal((await job("2026-06-20"))?.run_at, "2026-06-20T02:00:00.000Z");

  await runDispatch({ now: SEND_AT, logger: fx.silentLogger });
  assert.equal(dueMessages().length, 0, "not due yet");

  await runDispatch({ now: new Date("2026-06-20T02:00:10.000Z"), logger: fx.silentLogger });
  assert.equal(dueMessages().length, 2, "fires at the overridden time");
});

// ── pause ────────────────────────────────────────────────────────────────────

test("pause: the planner skips the paused days and the reminder returns the day after the pause", async () => {
  // Paused through the end of today (the 20th): no job today, tomorrow's is back.
  await setup(dailyFrom("2026-06-01", { paused_from: "2026-06-18", paused_until: "2026-06-20" }));

  await planner.planAllUsers(NOW);

  assert.deepEqual((await dueJobs()).map((j) => j.local_date), ["2026-06-21"]);
});

test("pause: pausing cancels today's reminder and its overdue nudges, lifting it brings them back", async () => {
  await setup(dailyFrom("2026-06-20"));
  const lateMorning = plus(NOW, 180); // 10:00 in Vietnam, 2.5h after the 07:30 slot
  await reconcileChecklistDue(USER_ID, TPL, lateMorning);
  const pendingNudges = () =>
    fx.jobsFor(turso, USER_ID, "AND kind = 'checklist_overdue' AND status = 'pending'");
  assert.ok((await pendingNudges()).length > 0, "unpaused: overdue nudges are planned");

  await schedulesRepo.upsertSchedule(USER_ID, TPL, dailyFrom("2026-06-20", { paused_from: "2026-06-20", paused_until: "2026-06-22" }));
  await reconcileChecklistDue(USER_ID, TPL, lateMorning);
  assert.equal((await pendingNudges()).length, 0, "paused: no overdue nudge is left pending");
  assert.notEqual((await job("2026-06-20"))?.status, "pending");

  await schedulesRepo.upsertSchedule(USER_ID, TPL, dailyFrom("2026-06-20", { paused_from: null, paused_until: null }));
  await reconcileChecklistDue(USER_ID, TPL, lateMorning);
  assert.ok((await pendingNudges()).length > 0, "resumed: nudges are planned again");
});

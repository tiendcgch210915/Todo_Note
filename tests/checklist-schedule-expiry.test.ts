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
const { runMaintenance } = await import("../src/services/notification-tick.js");
const pure = await import("../src/services/checklist-schedule.js");
const expiry = await import("../src/services/checklist-schedule-expiry.js");
const dueService = await import("../src/services/checklist-due.js");
const triggers = await import("../src/services/notification-triggers.js");
const schedulesRepo = await import("../src/repositories/checklist-schedules.js");
const jobsRepo = await import("../src/repositories/notification-jobs.js");
const { getChangesSince } = await import("../src/repositories/sync.repo.js");
const { processPush } = await import("../src/services/sync.service.js");
const { PutChecklistScheduleSchema } = await import("../src/schemas/api/checklist-schedules.js");
const { default: Fastify } = await import("fastify");
const { default: userAuth } = await import("../src/plugins/user-auth.js");
const { default: checklistsRoutes } = await import("../src/routes/api/v1/checklists.js");
const { signUserToken } = await import("../src/services/api-auth.js");
const { addDays, localDateOf, localDateTimeToUtc } = await import("../src/utils/time.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID, OTHER_USER_ID } = fx;
const VN = "Asia/Ho_Chi_Minh";
const A = "tst-rời-nhà";
const B = "tst-đi-ngủ";

const at = (date: string, hhmm: string, seconds = 0, tz = VN): Date =>
  new Date(localDateTimeToUtc(date, hhmm, tz).getTime() + seconds * 1000);
const iso = (d: Date): string => d.toISOString();

const app = Fastify();

before(async () => {
  await applyAllMigrations(turso);
  await app.register(userAuth);
  await app.register(checklistsRoutes, { prefix: "/checklists" });
  await app.ready();
});

after(async () => {
  await app.close();
});

beforeEach(async () => {
  for (const table of [
    "notification_jobs",
    "notification_settings",
    "user_devices",
    "checklist_schedule_overrides",
    "checklist_schedules",
    "checklist_run_items",
    "checklist_runs",
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await turso.execute("DELETE FROM checklist_template_items WHERE template_id LIKE 'tst-%'");
  await turso.execute("DELETE FROM checklist_templates WHERE id LIKE 'tst-%'");
  await turso.execute(`DELETE FROM users WHERE id IN ('${USER_ID}', '${OTHER_USER_ID}')`);

  await fx.insertUser(turso, USER_ID);
  await fx.insertUser(turso, OTHER_USER_ID);
  await fx.insertTemplateWithItems(turso, { id: A, title: "Rời nhà", itemCount: 3 });
  await fx.insertTemplateWithItems(turso, { id: B, title: "Đi ngủ", itemCount: 2 });

  firebase.setMessagingClientForTests(fx.fakeMessaging().client);
  firebase.setPushLogger(fx.silentLogger);
});

type Fields = Parameters<typeof schedulesRepo.upsertSchedule>[2];
const oneOff = (startDate: string, overrides: Partial<Fields> = {}): Fields => ({
  start_date: startDate,
  time: "07:30",
  recurrence_type: null,
  recurrence_interval: null,
  recurrence_days_of_week: null,
  recurrence_end_date: null,
  enabled: true,
  ...overrides,
});
const repeating = (startDate: string, overrides: Partial<Fields> = {}): Fields =>
  oneOff(startDate, { recurrence_type: "daily", recurrence_interval: 1, ...overrides });

const live = async (templateId = A, userId = USER_ID) =>
  schedulesRepo.getLiveSchedule(userId, templateId);
const liveOverrides = async () =>
  (await turso.execute("SELECT * FROM checklist_schedule_overrides WHERE deleted_at IS NULL")).rows;

// ── pure rules ───────────────────────────────────────────────────────────────

const rule = (overrides: Partial<Parameters<typeof pure.toScheduleRule>[0]> = {}) =>
  pure.toScheduleRule({
    template_id: A,
    start_date: "2026-06-10",
    time: "07:30",
    recurrence_type: null,
    recurrence_interval: null,
    recurrence_days_of_week: null,
    recurrence_end_date: null,
    enabled: 1,
    ...overrides,
  });

test("the effective end date: the chosen one, else the day itself for a one-off, else never", () => {
  assert.equal(pure.effectiveEndDate(rule()), "2026-06-10", "one-off without an end date ends on its own day");
  assert.equal(pure.effectiveEndDate(rule({ recurrence_end_date: "2026-06-15" })), "2026-06-15", "a one-off may end later");
  assert.equal(pure.effectiveEndDate(rule({ recurrence_type: "daily", recurrence_interval: 1 })), null, "repeating without end never expires");
  assert.equal(
    pure.effectiveEndDate(rule({ recurrence_type: "weekly", recurrence_end_date: "2026-07-01" })),
    "2026-07-01"
  );
});

test("a schedule is finished after its end date, or when a one-off was completed on its day", () => {
  const reason = pure.scheduleFinishReason;

  // one-off on the 10th, no end date
  assert.equal(reason(rule(), "2026-06-09", false), null);
  assert.equal(reason(rule(), "2026-06-10", false), null, "its own day, not completed yet");
  assert.equal(reason(rule(), "2026-06-10", true), "completed");
  assert.equal(reason(rule(), "2026-06-11", false), "expired", "00:00 of the 11th");
  assert.equal(reason(rule(), "2026-06-11", true), "expired", "expiry wins when both apply");
  assert.equal(reason(rule(), "2026-06-09", true), "completed", "the caller decides what 'completed on its day' means");

  // one-off with an explicit end date on the 15th
  const longer = rule({ recurrence_end_date: "2026-06-15" });
  assert.equal(reason(longer, "2026-06-12", false), null);
  assert.equal(reason(longer, "2026-06-15", false), null);
  assert.equal(reason(longer, "2026-06-16", false), "expired");
  assert.equal(reason(longer, "2026-06-10", true), "completed");

  // repeating: only the end date matters, completing a day never finishes it
  const daily = rule({ recurrence_type: "daily", recurrence_interval: 1, recurrence_end_date: "2026-06-10" });
  assert.equal(reason(daily, "2026-06-10", true), null);
  assert.equal(reason(daily, "2026-06-11", false), "expired");
  const endless = rule({ recurrence_type: "daily", recurrence_interval: 1 });
  assert.equal(reason(endless, "2099-01-01", true), null);
});

test("a one-off now keeps its end date; repeat fields are still dropped", () => {
  const parsed = PutChecklistScheduleSchema.parse({
    start_date: "2026-06-10",
    time: "07:30",
    recurrence_interval: 3,
    recurrence_days_of_week: "1,2",
    recurrence_end_date: "2026-06-15",
  });
  assert.equal(parsed.recurrence_type, null);
  assert.equal(parsed.recurrence_interval, null);
  assert.equal(parsed.recurrence_days_of_week, null);
  assert.equal(parsed.recurrence_end_date, "2026-06-15");
  assert.equal(
    PutChecklistScheduleSchema.safeParse({ start_date: "2026-06-10", time: "07:30", recurrence_end_date: "2026-06-09" }).success,
    false,
    "the end date still cannot precede the start date"
  );
});

// ── completed on its day ─────────────────────────────────────────────────────

const TODAY_REAL = (): string => localDateOf(new Date(), VN);
const auth = () => ({ authorization: `Bearer ${signUserToken(app, USER_ID)}` });
const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url, headers: auth() });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
};

test("a one-off completed on its day is reset: no schedule on the detail page, nothing in the timeline", async () => {
  const today = TODAY_REAL();
  await schedulesRepo.upsertSchedule(USER_ID, A, oneOff(today));
  await schedulesRepo.upsertOverride(USER_ID, A, today, "21:00");
  assert.equal((await get(`/checklists/templates/${A}`)).body.schedule?.start_date, today);

  await fx.insertRun(turso, { id: "run-1", templateId: A, completedAt: new Date().toISOString() });
  await triggers.onChecklistRunChanged(USER_ID, "run-1");

  assert.equal(await live(), null);
  assert.equal((await liveOverrides()).length, 0, "the day's time override goes with it");
  const detail = await get(`/checklists/templates/${A}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.schedule, null, "the toggle is off again");
  assert.equal((await get(`/checklists/templates/${A}/schedule`)).status, 404);
  assert.deepEqual((await get(`/checklists/occurrences?from=${today}&to=${today}`)).body.items, []);
});

test("the pending reminder and nudges of a finished one-off are cancelled", async () => {
  const today = TODAY_REAL();
  await schedulesRepo.upsertSchedule(USER_ID, A, oneOff(today));
  const future = new Date(Date.now() + 3_600_000).toISOString();
  await fx.insertRawJob(turso, { id: "due", kind: "checklist_due", refId: A, localDate: today, runAt: future });
  await fx.insertRawJob(turso, { id: "nudge", kind: "checklist_overdue", refId: A, localDate: today, runAt: future });

  await fx.insertRun(turso, { id: "run-1", templateId: A, completedAt: new Date().toISOString() });
  await triggers.onChecklistRunChanged(USER_ID, "run-1");

  assert.equal(await fx.statusOf(turso, "due"), "cancelled");
  assert.equal(await fx.statusOf(turso, "nudge"), "cancelled");
});

test("completing on the scheduled day works for any time of that day, in the user's own zone", async () => {
  const date = "2026-06-10";
  await schedulesRepo.upsertSchedule(USER_ID, A, oneOff(date));

  // 17:30 UTC on the 10th is 00:30 on the 11th in Vietnam: not the scheduled day.
  await fx.insertRun(turso, { id: "r-late", templateId: A, completedAt: "2026-06-10T17:30:00.000Z" });
  assert.equal(await expiry.finishSchedulesForUser(USER_ID, at(date, "23:59")), 0);
  assert.ok(await live(), "completed after midnight local time does not count for the 10th");

  // 16:59 UTC on the 10th is 23:59 on the 10th in Vietnam.
  await fx.insertRun(turso, { id: "r-ok", templateId: A, completedAt: "2026-06-10T16:59:00.000Z" });
  assert.equal(await expiry.finishSchedulesForUser(USER_ID, at(date, "23:59")), 1);
  assert.equal(await live(), null);
});

test("what does NOT count as completing a one-off: other days, abandoned, deleted, another checklist, another user", async () => {
  const date = "2026-06-10";
  await schedulesRepo.upsertSchedule(USER_ID, A, oneOff(date));
  await fx.insertRun(turso, { id: "r-yesterday", templateId: A, completedAt: iso(at("2026-06-09", "12:00")) });
  await fx.insertRun(turso, { id: "r-abandoned", templateId: A, status: "abandoned", completedAt: iso(at(date, "08:00")) });
  await fx.insertRun(turso, { id: "r-deleted", templateId: A, completedAt: iso(at(date, "09:00")), deletedAt: iso(at(date, "09:30")) });
  await fx.insertRun(turso, { id: "r-other-checklist", templateId: B, completedAt: iso(at(date, "10:00")) });
  await fx.insertRun(turso, { id: "r-other-user", templateId: A, userId: OTHER_USER_ID, completedAt: iso(at(date, "11:00")) });
  await fx.insertRun(turso, { id: "r-running", templateId: A, status: "in_progress", completedAt: null });

  assert.equal(await expiry.finishSchedulesForUser(USER_ID, at(date, "20:00")), 0);
  assert.ok(await live());
});

test("a one-off scheduled for a later day is not finished by completing the checklist today", async () => {
  const today = TODAY_REAL();
  await schedulesRepo.upsertSchedule(USER_ID, A, oneOff(addDays(today, 3)));
  await fx.insertRun(turso, { id: "run-1", templateId: A, completedAt: new Date().toISOString() });
  await triggers.onChecklistRunChanged(USER_ID, "run-1");
  assert.ok(await live());
});

test("completing a repeating checklist never removes its schedule", async () => {
  const today = TODAY_REAL();
  await schedulesRepo.upsertSchedule(USER_ID, A, repeating(today));
  await fx.insertRun(turso, { id: "run-1", templateId: A, completedAt: new Date().toISOString() });
  await triggers.onChecklistRunChanged(USER_ID, "run-1");

  assert.ok(await live());
  const item = (await get(`/checklists/occurrences?from=${today}&to=${today}`)).body.items[0];
  assert.equal(item.done, true, "still shown in the timeline, marked done");
});

test("only the finished checklist is reset; the others keep their schedules", async () => {
  const today = TODAY_REAL();
  await schedulesRepo.upsertSchedule(USER_ID, A, oneOff(today));
  await schedulesRepo.upsertSchedule(USER_ID, B, oneOff(today));
  await fx.insertRun(turso, { id: "run-a", templateId: A, completedAt: new Date().toISOString() });
  await triggers.onChecklistRunChanged(USER_ID, "run-a");

  assert.equal(await live(A), null);
  assert.ok(await live(B));
});

test("an offline run completed on the scheduled day and synced later still resets the one-off when its end date is later", async () => {
  // Completed yesterday on the device, pushed today. The schedule is a one-off for yesterday with
  // an end date of tomorrow, so it has not expired yet.
  const today = TODAY_REAL();
  const yesterday = addDays(today, -1);
  await schedulesRepo.upsertSchedule(USER_ID, A, oneOff(yesterday, { recurrence_end_date: addDays(today, 1) }));
  const completedAt = iso(at(yesterday, "20:00"));

  await processPush(USER_ID, [
    {
      op: "create",
      type: "checklist_run",
      payload: { id: "run-offline", template_id: A, name: null, status: "completed", started_at: iso(at(yesterday, "19:50")), completed_at: completedAt, created_at: completedAt, updated_at: completedAt },
    } as never,
  ]);

  assert.equal(await live(), null);
});

// ── end date ─────────────────────────────────────────────────────────────────

test("a one-off that was not completed disappears at 00:00 of the next day, not before", async () => {
  const date = "2026-06-10";
  await schedulesRepo.upsertSchedule(USER_ID, A, oneOff(date));

  assert.equal(await expiry.expireChecklistSchedules(at(date, "00:00")), 0);
  assert.equal(await expiry.expireChecklistSchedules(at(date, "23:59", 59)), 0, "still its day");
  assert.ok(await live());

  assert.equal(await expiry.expireChecklistSchedules(at("2026-06-11", "00:00")), 1);
  assert.equal(await live(), null);
  assert.equal(await expiry.expireChecklistSchedules(at("2026-06-11", "00:01")), 0, "idempotent");
});

test("a repeating schedule with an end date is removed at 00:00 after it, with all its day overrides", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, A, repeating("2026-06-01", { recurrence_end_date: "2026-06-10" }));
  await schedulesRepo.upsertOverride(USER_ID, A, "2026-06-05", "21:00");
  await schedulesRepo.upsertOverride(USER_ID, A, "2026-06-09", "22:00");

  assert.equal(await expiry.expireChecklistSchedules(at("2026-06-10", "23:59", 59)), 0);
  assert.equal((await liveOverrides()).length, 2);

  assert.equal(await expiry.expireChecklistSchedules(at("2026-06-11", "00:00")), 1);
  assert.equal(await live(), null);
  assert.equal((await liveOverrides()).length, 0);
});

test("a one-off with an explicit later end date stays until that date, and a completion on its day still resets it", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, A, oneOff("2026-06-10", { recurrence_end_date: "2026-06-15" }));

  assert.equal(await expiry.expireChecklistSchedules(at("2026-06-15", "23:59")), 0);
  assert.ok(await live());
  assert.equal(await expiry.expireChecklistSchedules(at("2026-06-16", "00:00")), 1);

  await schedulesRepo.upsertSchedule(USER_ID, A, oneOff("2026-06-10", { recurrence_end_date: "2026-06-15" }));
  await fx.insertRun(turso, { id: "run-1", templateId: A, completedAt: iso(at("2026-06-10", "18:00")) });
  assert.equal(await expiry.finishSchedulesForUser(USER_ID, at("2026-06-12", "09:00")), 1);
  assert.equal(await live(), null);
});

test("a repeating schedule without an end date never expires", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, A, repeating("2026-06-01"));
  assert.equal(await expiry.expireChecklistSchedules(new Date("2099-01-01T00:00:00.000Z")), 0);
  assert.equal(await expiry.finishSchedulesForUser(USER_ID, new Date("2099-01-01T00:00:00.000Z")), 0);
  assert.ok(await live());
});

test("expiry follows the user's own time zone", async () => {
  await turso.execute({ sql: "UPDATE users SET timezone = 'Pacific/Auckland' WHERE id = ?", args: [USER_ID] });
  await schedulesRepo.upsertSchedule(USER_ID, A, repeating("2026-06-01", { recurrence_end_date: "2026-06-10" }));

  // Auckland is UTC+12: 00:00 on the 11th is 12:00 UTC on the 10th.
  assert.equal(await expiry.expireChecklistSchedules(new Date("2026-06-10T11:59:59.000Z")), 0);
  assert.equal(await expiry.expireChecklistSchedules(new Date("2026-06-10T12:00:00.000Z")), 1);

  await fx.insertTemplateWithItems(turso, { id: "tst-ny", title: "NY", itemCount: 1 });
  await turso.execute({ sql: "UPDATE users SET timezone = 'America/New_York' WHERE id = ?", args: [OTHER_USER_ID] });
  await schedulesRepo.upsertSchedule(OTHER_USER_ID, "tst-ny", oneOff("2026-06-10"));
  // New York is UTC-4: 00:00 on the 11th is 04:00 UTC on the 11th. Still the 10th over there at 03:59 UTC.
  assert.equal(await expiry.expireChecklistSchedules(new Date("2026-06-11T03:59:59.000Z")), 0);
  assert.equal(await expiry.expireChecklistSchedules(new Date("2026-06-11T04:00:00.000Z")), 1);
});

test("the sweep only removes what has expired and leaves the other users' schedules alone", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, A, oneOff("2026-06-10"));
  await schedulesRepo.upsertSchedule(USER_ID, B, repeating("2026-06-01", { recurrence_end_date: "2026-06-30" }));
  await schedulesRepo.upsertSchedule(OTHER_USER_ID, A, repeating("2026-06-01"));
  await schedulesRepo.upsertSchedule(OTHER_USER_ID, B, oneOff("2026-06-12"));

  assert.equal(await expiry.expireChecklistSchedules(at("2026-06-11", "08:00")), 1);

  assert.equal(await live(A), null);
  assert.ok(await live(B));
  assert.ok(await live(A, OTHER_USER_ID));
  assert.ok(await live(B, OTHER_USER_ID));
});

test("a disabled schedule expires too, and so does one of a user without any device", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, A, oneOff("2026-06-10", { enabled: false }));
  assert.equal(await expiry.expireChecklistSchedules(at("2026-06-11", "00:00")), 1);
});

test("the pending reminder and nudges of an expired schedule are cancelled", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, A, repeating("2026-06-01", { recurrence_end_date: "2026-06-10" }));
  const future = iso(at("2026-06-11", "09:00"));
  await fx.insertRawJob(turso, { id: "due", kind: "checklist_due", refId: A, localDate: "2026-06-11", runAt: future });
  await fx.insertRawJob(turso, { id: "nudge", kind: "checklist_overdue", refId: A, localDate: "2026-06-11", runAt: future });

  await expiry.expireChecklistSchedules(at("2026-06-11", "00:00"));

  assert.equal(await fx.statusOf(turso, "due"), "cancelled");
  assert.equal(await fx.statusOf(turso, "nudge"), "cancelled");
});

test("the maintenance tick runs the sweep (and reports how many it removed), even without devices", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, A, oneOff("2026-06-10"));
  await schedulesRepo.upsertSchedule(USER_ID, B, repeating("2026-06-01"));

  const first = await runMaintenance({ now: at("2026-06-11", "00:00", 5), logger: fx.silentLogger });
  assert.equal(first.schedules_expired, 1);
  assert.equal(await live(A), null);
  assert.ok(await live(B));

  const second = await runMaintenance({ now: at("2026-06-11", "00:01", 5), logger: fx.silentLogger });
  assert.equal(second.schedules_expired, 0);
});

test("the sweep does not write anything while nothing is expired", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, B, repeating("2026-06-01", { recurrence_end_date: "2026-06-30" }));
  await schedulesRepo.upsertSchedule(USER_ID, A, oneOff("2026-06-12"));

  const originalExecute = turso.execute.bind(turso);
  const originalBatch = turso.batch.bind(turso);
  let writes = 0;
  (turso as { execute: unknown }).execute = (statement: unknown) => {
    const sql = typeof statement === "object" && statement ? String((statement as { sql?: string }).sql) : String(statement);
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes++;
    return originalExecute(statement as never);
  };
  (turso as { batch: unknown }).batch = (...args: Parameters<typeof turso.batch>) => {
    writes++;
    return originalBatch(...args);
  };
  try {
    assert.equal(await expiry.expireChecklistSchedules(at("2026-06-11", "10:00")), 0);
  } finally {
    (turso as { execute: unknown }).execute = originalExecute;
    (turso as { batch: unknown }).batch = originalBatch;
  }
  assert.equal(writes, 0);
});

// ── what the app sees ────────────────────────────────────────────────────────

test("reading never shows a finished schedule even if no sweep has run yet", async () => {
  // Real clock: June 2026 is long over.
  await schedulesRepo.upsertSchedule(USER_ID, A, repeating("2026-06-01", { recurrence_end_date: "2026-06-10" }));
  await schedulesRepo.upsertSchedule(USER_ID, B, oneOff("2026-06-10"));

  assert.equal((await get(`/checklists/templates/${A}`)).body.schedule, null);
  assert.equal((await get(`/checklists/templates/${B}/schedule`)).status, 404);
  assert.deepEqual((await get("/checklists/occurrences?from=2026-06-01&to=2026-06-30")).body.items, []);
});

test("after the reset the checklist can be scheduled again from scratch, without the old overrides", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, A, repeating("2026-06-01", { recurrence_end_date: "2026-06-10" }));
  await schedulesRepo.upsertOverride(USER_ID, A, "2099-06-02", "21:00");
  await expiry.expireChecklistSchedules(at("2026-06-11", "00:00"));

  const put = await app.inject({
    method: "PUT",
    url: `/checklists/templates/${A}/schedule`,
    headers: auth(),
    payload: { start_date: "2099-06-01", time: "08:00", recurrence_type: "daily" },
  });
  assert.equal(put.statusCode, 200);

  const items = (await get("/checklists/occurrences?from=2099-06-01&to=2099-06-03")).body.items as Array<Record<string, any>>;
  assert.deepEqual(items.map((i) => [i.date, i.time, i.overridden]), [
    ["2099-06-01", "08:00", false],
    ["2099-06-02", "08:00", false],
    ["2099-06-03", "08:00", false],
  ]);
});

test("a one-off set for a day that is already done is reset the next time it is read", async () => {
  const today = TODAY_REAL();
  await fx.insertRun(turso, { id: "run-1", templateId: A, completedAt: new Date().toISOString() });

  const put = await app.inject({
    method: "PUT",
    url: `/checklists/templates/${A}/schedule`,
    headers: auth(),
    payload: { start_date: today, time: "23:00" },
  });
  assert.equal(put.statusCode, 200);

  assert.equal((await get(`/checklists/templates/${A}`)).body.schedule, null);
});

test("a one-off with an end date can be saved through the API and is returned as saved", async () => {
  const start = addDays(TODAY_REAL(), 2);
  const end = addDays(start, 3);
  const put = await app.inject({
    method: "PUT",
    url: `/checklists/templates/${A}/schedule`,
    headers: auth(),
    payload: { start_date: start, time: "08:00", recurrence_end_date: end },
  });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().schedule.recurrence_type, null);
  assert.equal(put.json().schedule.recurrence_end_date, end);
  assert.equal((await get(`/checklists/templates/${A}`)).body.schedule.recurrence_end_date, end);

  const before = await app.inject({
    method: "PUT",
    url: `/checklists/templates/${A}/schedule`,
    headers: auth(),
    payload: { start_date: start, time: "08:00", recurrence_end_date: addDays(start, -1) },
  });
  assert.equal(before.statusCode, 400);
});

// ── sync ─────────────────────────────────────────────────────────────────────

test("the removal reaches the app as a tombstone of the schedule and of its overrides", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, A, repeating("2026-06-01", { recurrence_end_date: "2026-06-10" }));
  await schedulesRepo.upsertOverride(USER_ID, A, "2026-06-05", "21:00");
  const since = "2026-01-01T00:00:00.000Z";

  await expiry.expireChecklistSchedules(at("2026-06-11", "00:00"));

  const delta = await getChangesSince(USER_ID, since);
  const schedule = delta.checklist_schedules.find((s) => s.template_id === A) as Record<string, any>;
  const override = delta.checklist_schedule_overrides.find((o) => o.template_id === A) as Record<string, any>;
  assert.ok(schedule.deleted_at, "schedule tombstone");
  assert.ok(override.deleted_at, "override tombstone");
  assert.equal((await getChangesSince(USER_ID, null)).checklist_schedules.length, 0, "a full pull has nothing left");
});

test("an older offline edit of the removed schedule cannot bring it back", async () => {
  await schedulesRepo.upsertSchedule(USER_ID, A, repeating("2026-06-01", { recurrence_end_date: "2026-06-10" }));
  const id = (await live())!.id;
  await expiry.expireChecklistSchedules(at("2026-06-11", "00:00"));

  const [result] = await processPush(USER_ID, [
    {
      op: "update",
      type: "checklist_schedule",
      payload: { id, template_id: A, start_date: "2026-06-01", time: "08:00", recurrence_type: "daily", recurrence_interval: 1, recurrence_end_date: "2026-12-31", enabled: true, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-05T00:00:00.000Z" },
    } as never,
  ]);

  assert.equal(result.status, "conflict", "Last-Write-Wins: the server answers with its (deleted) version");
  assert.ok(result.server_version?.deleted_at, "so the app learns the schedule is gone");
  assert.equal(await live(), null, "the tombstone is newer, the stale edit is ignored");
});

test("a sync push of a one-off keeps its end date", async () => {
  const start = addDays(TODAY_REAL(), 2);
  const end = addDays(start, 2);
  await processPush(USER_ID, [
    {
      op: "create",
      type: "checklist_schedule",
      payload: { id: "sched-1", template_id: A, start_date: start, time: "08:00", recurrence_type: null, recurrence_interval: null, recurrence_days_of_week: null, recurrence_end_date: end, enabled: true, created_at: iso(new Date()), updated_at: iso(new Date()) },
    } as never,
  ]);
  assert.equal((await live())?.recurrence_end_date, end);
});

// ── the per-day time change is untouched ─────────────────────────────────────

test("changing one day's time still moves only that day's reminder", async () => {
  const day1 = "2026-06-20";
  const day2 = "2026-06-21";
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await schedulesRepo.upsertSchedule(USER_ID, A, repeating(day1));
  await dueService.reconcileChecklistDue(USER_ID, A, at(day1, "07:00"));
  const runAt = async (date: string) => (await jobsRepo.getOccurrenceJob(USER_ID, "checklist_due", A, date))?.run_at;
  assert.equal(await runAt(day1), iso(at(day1, "07:30")));
  assert.equal(await runAt(day2), iso(at(day2, "07:30")));

  await schedulesRepo.upsertOverride(USER_ID, A, day2, "21:15");
  await dueService.reconcileChecklistDue(USER_ID, A, at(day1, "07:01"));

  assert.equal(await runAt(day1), iso(at(day1, "07:30")), "today is unchanged");
  assert.equal(await runAt(day2), iso(at(day2, "21:15")), "only the overridden day moved");
  assert.ok(await live(), "and the schedule itself is untouched");
});

test("changing the time of a one-off's day works, and the override goes with the schedule when it finishes", async () => {
  const date = "2026-06-20";
  await schedulesRepo.upsertSchedule(USER_ID, A, oneOff(date));
  await dueService.reconcileChecklistDue(USER_ID, A, at(date, "07:00"));
  await schedulesRepo.upsertOverride(USER_ID, A, date, "20:00");
  await dueService.reconcileChecklistDue(USER_ID, A, at(date, "07:01"));
  assert.equal((await jobsRepo.getOccurrenceJob(USER_ID, "checklist_due", A, date))?.run_at, iso(at(date, "20:00")));
  assert.ok(await live(), "overriding the time does not finish the schedule");

  await fx.insertRun(turso, { id: "run-1", templateId: A, completedAt: iso(at(date, "20:30")) });
  assert.equal(await expiry.finishSchedulesForUser(USER_ID, at(date, "20:31")), 1);
  assert.equal((await liveOverrides()).length, 0);
  assert.equal((await jobsRepo.getOccurrenceJob(USER_ID, "checklist_due", A, date))?.status, "cancelled");
});

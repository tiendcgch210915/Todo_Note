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
const nudges = await import("../src/services/checklist-run-nudges.js");
const triggers = await import("../src/services/notification-triggers.js");
const { addDays, localDateTimeToUtc } = await import("../src/utils/time.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID, OTHER_USER_ID } = fx;
const VN = "Asia/Ho_Chi_Minh";
const NY = "America/New_York";
const TPL = "tst-rời-nhà";
const DATE = "2026-06-20";
const NEXT = addDays(DATE, 1);

const at = (date: string, hhmm: string, seconds = 0, tz = VN): Date =>
  new Date(localDateTimeToUtc(date, hhmm, tz).getTime() + seconds * 1000);
const iso = (d: Date): string => d.toISOString();

let fake = fx.fakeMessaging();

before(async () => {
  await applyAllMigrations(turso);
});

beforeEach(async () => {
  for (const table of [
    "notification_jobs",
    "user_devices",
    "notification_settings",
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
  await turso.execute(`DELETE FROM users WHERE id IN ('${USER_ID}', '${OTHER_USER_ID}')`);

  await fx.insertUser(turso, USER_ID);
  await fx.insertUser(turso, OTHER_USER_ID);
  await fx.insertTemplateWithItems(turso, { id: TPL, title: "Rời nhà", itemCount: 3 });

  fake = fx.fakeMessaging();
  firebase.setMessagingClientForTests(fake.client);
  firebase.setPushLogger(fx.silentLogger);
});

/** Run đang chạy bắt đầu lúc `startedAt`, với `done` trên 3 bước đã tick. */
const startRun = async (
  id: string,
  startedAt: Date,
  options: { done?: number; userId?: string } = {}
): Promise<void> => {
  const userId = options.userId ?? USER_ID;
  await fx.insertRun(turso, { id, templateId: TPL, userId, status: "in_progress", startedAt: iso(startedAt) });
  for (let i = 0; i < 3; i++) {
    await turso.execute({
      sql: `INSERT INTO checklist_run_items (id, run_id, template_item_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [`${id}-ri-${i}`, id, `${TPL}-item-${i + 1}`, i < (options.done ?? 0) ? "done" : "pending", iso(startedAt), iso(startedAt)],
    });
  }
};

const rows = (runId?: string) =>
  fx.jobsFor(turso, USER_ID, `AND kind = 'checklist_running'${runId ? ` AND ref_id = '${runId}'` : ""}`);
const runAtsWith = async (status: string, runId?: string): Promise<string[]> =>
  (await rows(runId))
    .filter((row) => row.status === status)
    .map((row) => String(row.run_at))
    .sort();

const dispatchAt = (when: Date) => runDispatch({ now: when, logger: fx.silentLogger });
const runningMessages = () => fake.messages.filter((m) => m.data?.type === "checklist");

// ── pure rules ───────────────────────────────────────────────────────────────

test("started at 12:15: hourly nudges until the end of that day, then one at 06:00 the next morning", () => {
  const slots = nudges.runNudgeSlots(at(DATE, "12:15"), VN);

  const hourly = slots.filter((slot) => slot.kind === "hourly");
  assert.deepEqual(
    hourly.map((slot) => iso(slot.at)),
    ["13:15", "14:15", "15:15", "16:15", "17:15", "18:15", "19:15", "20:15", "21:15", "22:15", "23:15"].map((h) =>
      iso(at(DATE, h))
    )
  );
  assert.deepEqual(
    hourly.map((slot) => (slot.kind === "hourly" ? slot.hours : 0)),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  );
  assert.equal(slots.length, 12);
  assert.deepEqual(slots[11], { kind: "carryover", at: at(NEXT, "06:00") });
});

test("started late in the evening: no hourly nudge crosses midnight, only the 06:00 one remains", () => {
  assert.deepEqual(nudges.runNudgeSlots(at(DATE, "23:30"), VN), [{ kind: "carryover", at: at(NEXT, "06:00") }]);
  assert.deepEqual(nudges.runNudgeSlots(at(DATE, "23:00"), VN), [{ kind: "carryover", at: at(NEXT, "06:00") }]);
  // 22:59 -> 23:59 is still the same day.
  const justInside = nudges.runNudgeSlots(at(DATE, "22:59"), VN);
  assert.equal(justInside.length, 2);
  assert.equal(justInside[0].kind, "hourly");
});

test("started just after midnight: a full day of hourly nudges (01:10 .. 23:10)", () => {
  const slots = nudges.runNudgeSlots(at(DATE, "00:10"), VN);

  assert.equal(slots.filter((slot) => slot.kind === "hourly").length, 23);
  assert.equal(iso(slots[0].at), iso(at(DATE, "01:10")));
  assert.equal(iso(slots[22].at), iso(at(DATE, "23:10")));
  assert.equal(iso(slots[23].at), iso(at(NEXT, "06:00")));
});

test("the 06:00 nudge is local to the user's timezone and follows the clock change (DST)", () => {
  // New York springs forward on 2026-03-08 (02:00 -> 03:00): that day has 23 hours.
  const startedAt = at("2026-03-08", "00:30", 0, NY);
  const slots = nudges.runNudgeSlots(startedAt, NY);

  const hourly = slots.filter((slot) => slot.kind === "hourly");
  assert.equal(hourly.length, 22, "00:30 + 22h = 23:30 local, 23 hours in the day");
  assert.equal(iso(slots[slots.length - 1].at), iso(at("2026-03-09", "06:00", 0, NY)));
  // Every slot is exactly one hour after the previous, in real time.
  for (let i = 1; i < hourly.length; i++) {
    assert.equal(hourly[i].at.getTime() - hourly[i - 1].at.getTime(), 3_600_000);
  }
});

test("findRunNudge recognises exactly the real slots of the run", () => {
  const startedAt = at(DATE, "12:15");

  assert.deepEqual(nudges.findRunNudge(startedAt, at(DATE, "14:15"), VN), { kind: "hourly", at: at(DATE, "14:15"), hours: 2 });
  assert.deepEqual(nudges.findRunNudge(startedAt, at(NEXT, "06:00"), VN), { kind: "carryover", at: at(NEXT, "06:00") });
  assert.equal(nudges.findRunNudge(startedAt, at(DATE, "14:16"), VN), null, "off by a minute");
  assert.equal(nudges.findRunNudge(startedAt, at(DATE, "12:15"), VN), null, "the start itself is not a nudge");
  assert.equal(nudges.findRunNudge(startedAt, at(NEXT, "00:15"), VN), null, "no hourly nudge on the new day");
  assert.equal(nudges.findRunNudge(startedAt, at(NEXT, "07:00"), VN), null, "nothing after the morning one");
  // Hourly slots are the same instants everywhere; the day boundary and the morning one are local.
  assert.equal(nudges.findRunNudge(startedAt, at(NEXT, "06:00"), NY), null, "06:00 in Vietnam is not 06:00 in New York");
});

test("creatableRunNudges keeps future slots and drops the ones past the lateness window", () => {
  const slots = nudges.runNudgeSlots(at(DATE, "12:15"), VN);

  const kept = nudges.creatableRunNudges(slots, at(DATE, "15:20")).map((slot) => iso(slot.at));

  assert.ok(!kept.includes(iso(at(DATE, "13:15"))));
  assert.ok(!kept.includes(iso(at(DATE, "14:15"))));
  assert.ok(kept.includes(iso(at(DATE, "15:15"))), "5 minutes late is still fine");
  assert.ok(kept.includes(iso(at(DATE, "16:15"))));
  assert.ok(kept.includes(iso(at(NEXT, "06:00"))));
});

// ── hook: one row per slot ───────────────────────────────────────────────────

test("reconcile creates one pending row per slot, keyed to the run, and is idempotent", async () => {
  await startRun("run-1", at(DATE, "12:15"));
  const now = at(DATE, "12:20");

  await nudges.reconcileChecklistRunNudges(USER_ID, "run-1", now);
  await nudges.reconcileChecklistRunNudges(USER_ID, "run-1", now);

  const expected = nudges.runNudgeSlots(at(DATE, "12:15"), VN).map((slot) => iso(slot.at)).sort();
  assert.deepEqual(await runAtsWith("pending", "run-1"), expected);
  assert.equal((await rows("run-1")).length, expected.length, "no duplicates");
  assert.ok((await rows("run-1")).every((row) => row.local_date === DATE && row.ref_id === "run-1"));
});

test("a nudge that was already sent is not re-armed when the run changes again", async () => {
  await startRun("run-1", at(DATE, "12:15"));
  await nudges.reconcileChecklistRunNudges(USER_ID, "run-1", at(DATE, "12:20"));
  await turso.execute({
    sql: "UPDATE notification_jobs SET status = 'sent', sent_at = ?, attempts = 1 WHERE run_at = ?",
    args: [iso(at(DATE, "13:15", 5)), iso(at(DATE, "13:15"))],
  });

  await nudges.reconcileChecklistRunNudges(USER_ID, "run-1", at(DATE, "13:20"));

  assert.deepEqual(await runAtsWith("sent", "run-1"), [iso(at(DATE, "13:15"))]);
  assert.equal((await runAtsWith("pending", "run-1")).length, 11, "14:15 .. 23:15 and the next morning");
});

test("completing, stopping or deleting the run cancels every pending nudge", async () => {
  for (const [label, sql] of [
    ["completed", "UPDATE checklist_runs SET status = 'completed'"],
    ["abandoned", "UPDATE checklist_runs SET status = 'abandoned'"],
    ["deleted", "UPDATE checklist_runs SET deleted_at = '2026-06-20T06:00:00.000Z'"],
  ] as const) {
    await turso.execute("DELETE FROM notification_jobs");
    await turso.execute("UPDATE checklist_runs SET status = 'in_progress', deleted_at = NULL");
    if ((await turso.execute("SELECT 1 FROM checklist_runs WHERE id = 'run-1'")).rows.length === 0) {
      await startRun("run-1", at(DATE, "12:15"));
    }
    await nudges.reconcileChecklistRunNudges(USER_ID, "run-1", at(DATE, "12:20"));
    assert.ok((await runAtsWith("pending", "run-1")).length > 0, label);

    await turso.execute(sql);
    await nudges.reconcileChecklistRunNudges(USER_ID, "run-1", at(DATE, "12:30"));

    assert.deepEqual(await runAtsWith("pending", "run-1"), [], label);
  }
});

test("a slot that is already too late when the run syncs is not created", async () => {
  await startRun("run-1", at(DATE, "12:15"));

  await nudges.reconcileChecklistRunNudges(USER_ID, "run-1", at(DATE, "15:20"));

  const pending = await runAtsWith("pending", "run-1");
  assert.ok(!pending.includes(iso(at(DATE, "13:15"))));
  assert.ok(!pending.includes(iso(at(DATE, "14:15"))));
  assert.equal(pending[0], iso(at(DATE, "15:15")));
  assert.equal(pending[pending.length - 1], iso(at(NEXT, "06:00")));
});

test("a timezone change moves the nudges to the new local day and morning", async () => {
  await startRun("run-1", at(DATE, "12:15"));
  await nudges.reconcileChecklistRunNudges(USER_ID, "run-1", at(DATE, "12:20"));
  const before = await runAtsWith("pending", "run-1");

  await turso.execute({ sql: "UPDATE users SET timezone = ? WHERE id = ?", args: [NY, USER_ID] });
  await nudges.reconcileAllChecklistRunNudges(USER_ID, at(DATE, "12:20"));

  const expectedNy = nudges
    .runNudgeSlots(at(DATE, "12:15"), NY)
    .map((slot) => iso(slot.at))
    .sort();
  assert.deepEqual(await runAtsWith("pending", "run-1"), expectedNy);
  assert.notDeepEqual(await runAtsWith("pending", "run-1"), before);
  assert.ok((await runAtsWith("cancelled", "run-1")).length > 0, "the old-timezone slots are cancelled");
});

// ── sending ──────────────────────────────────────────────────────────────────

test("every hour after the start, until the checklist is completed", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await startRun("run-1", at(DATE, "12:15"));
  await nudges.reconcileChecklistRunNudges(USER_ID, "run-1", at(DATE, "12:20"));

  // Nothing before the first hour is up.
  await dispatchAt(at(DATE, "13:14"));
  assert.equal(fake.messages.length, 0);

  for (const [hours, hhmm] of [[1, "13:15"], [2, "14:15"], [3, "15:15"]] as const) {
    await dispatchAt(at(DATE, hhmm, 10));
    const last = runningMessages().at(-1);
    assert.equal(runningMessages().length, hours, `${hhmm}`);
    assert.equal(last?.notification?.title, "Rời nhà");
    assert.equal(last?.notification?.body, `⏳ Đã làm ${hours} giờ · còn 3 bước chưa tick`);
    assert.deepEqual({ ...last?.data }, { type: "checklist", id: "run-1", date: DATE });
    assert.equal(last?.android?.notification?.channelId, "checklist_reminders");
  }

  // The user ticks the checklist as completed at 15:30 -> no more nudges.
  await turso.execute("UPDATE checklist_runs SET status = 'completed', completed_at = '2026-06-20T08:30:00.000Z'");
  await triggers.onChecklistRunChanged(USER_ID, "run-1");
  await dispatchAt(at(DATE, "16:15", 10));
  await dispatchAt(at(DATE, "17:15", 10));
  await dispatchAt(at(NEXT, "06:00", 10));

  assert.equal(runningMessages().length, 3, "nothing after completion");
  assert.deepEqual(await runAtsWith("pending", "run-1"), []);
});

test("the next day it only sends one 06:00 reminder about yesterday, then stops", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await startRun("run-1", at(DATE, "12:15"), { done: 1 });
  await nudges.reconcileChecklistRunNudges(USER_ID, "run-1", at(DATE, "12:20"));

  for (const slot of nudges.runNudgeSlots(at(DATE, "12:15"), VN)) {
    await dispatchAt(new Date(slot.at.getTime() + 10_000));
  }

  const bodies = runningMessages().map((m) => m.notification?.body);
  assert.equal(bodies.length, 12, "11 hourly nudges that day + the morning one");
  assert.equal(bodies[0], "⏳ Đã làm 1 giờ · còn 2 bước chưa tick");
  assert.equal(bodies[10], "⏳ Đã làm 11 giờ · còn 2 bước chưa tick");
  assert.equal(bodies[11], "🌅 Hôm qua chưa xong · còn 2 bước chưa tick");
  assert.deepEqual({ ...runningMessages()[11].data }, { type: "checklist", id: "run-1", date: DATE });

  // Nothing is armed after the morning reminder: no hourly nudges on the new day, no repeat.
  assert.deepEqual(await runAtsWith("pending", "run-1"), []);
  const before = fake.messages.length;
  await dispatchAt(at(NEXT, "07:15", 10));
  await dispatchAt(at(addDays(NEXT, 1), "06:00", 10));
  assert.equal(fake.messages.length, before);
});

test("a run started late in the evening is only reminded the next morning", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await startRun("run-late", at(DATE, "23:30"));
  await nudges.reconcileChecklistRunNudges(USER_ID, "run-late", at(DATE, "23:31"));
  assert.deepEqual(await runAtsWith("pending", "run-late"), [iso(at(NEXT, "06:00"))]);

  await dispatchAt(at(NEXT, "00:30", 10));
  assert.equal(fake.messages.length, 0);
  await dispatchAt(at(NEXT, "06:00", 10));

  assert.equal(fake.messages.length, 1);
  assert.equal(fake.messages[0].notification?.body, "🌅 Hôm qua chưa xong · còn 3 bước chưa tick");
});

test("no push when every step is already ticked, even though the run is still open", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await startRun("run-1", at(DATE, "12:15"), { done: 3 });
  await nudges.reconcileChecklistRunNudges(USER_ID, "run-1", at(DATE, "12:20"));

  await dispatchAt(at(DATE, "13:15", 10));

  assert.equal(fake.messages.length, 0);
  assert.equal(await fx.statusOf(turso, String((await rows("run-1"))[0].id)), "cancelled");
});

test("a start time that changed after the jobs were made turns the old jobs into no-ops", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await startRun("run-1", at(DATE, "12:15"));
  await nudges.reconcileChecklistRunNudges(USER_ID, "run-1", at(DATE, "12:20"));
  // The run is edited (e.g. synced from another device) without going through the hook.
  await turso.execute({ sql: "UPDATE checklist_runs SET started_at = ?", args: [iso(at(DATE, "12:22"))] });

  await dispatchAt(at(DATE, "13:15", 10));

  assert.equal(fake.messages.length, 0, "13:15 is no longer one hour after the start");
});

test("a nudge never reveals or uses another user's run", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await startRun("their-run", at(DATE, "12:15"), { userId: OTHER_USER_ID });
  await fx.insertRawJob(turso, {
    id: "job-x",
    kind: "checklist_running",
    refId: "their-run",
    localDate: DATE,
    runAt: iso(at(DATE, "13:15")),
  });

  await dispatchAt(at(DATE, "13:15", 10));

  assert.equal(fake.messages.length, 0);
  assert.equal(await fx.statusOf(turso, "job-x"), "cancelled");
});

test("an old 30-minute job that is still pending is cancelled and sends nothing", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await startRun("run-1", at(DATE, "12:15"));
  await fx.insertRawJob(turso, { id: "job-old", kind: "checklist_30m", refId: "run-1", runAt: iso(at(DATE, "12:45")) });

  await dispatchAt(at(DATE, "12:45", 10));

  assert.equal(fake.messages.length, 0);
  assert.equal(await fx.statusOf(turso, "job-old"), "cancelled");
});

// ── safety net ───────────────────────────────────────────────────────────────

test("maintenance arms the nudges for a running checklist that has none, once", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await startRun("run-1", at(DATE, "12:15"));
  const now = at(DATE, "12:20");

  const first = await runMaintenance({ now, logger: fx.silentLogger });

  const expected = nudges.runNudgeSlots(at(DATE, "12:15"), VN).map((slot) => iso(slot.at)).sort();
  assert.deepEqual(await runAtsWith("pending", "run-1"), expected);
  assert.ok(first.overdue_backfilled >= expected.length);

  const second = await runMaintenance({ now, logger: fx.silentLogger });
  assert.equal((await rows("run-1")).length, expected.length, "idempotent");
  assert.equal(second.overdue_backfilled, 0);
});

test("maintenance skips users without a device and runs that are long over", async () => {
  await startRun("no-device", at(DATE, "12:15"));
  await fx.insertDevice(turso, OTHER_USER_ID, "reg-B");
  await startRun("theirs", at(DATE, "12:15"), { userId: OTHER_USER_ID });

  await runMaintenance({ now: at(DATE, "12:20"), logger: fx.silentLogger });
  assert.deepEqual(await rows("no-device"), []);
  assert.ok((await fx.jobsFor(turso, OTHER_USER_ID, "AND kind = 'checklist_running'")).length > 0);

  // A run left open for days: every slot is long gone, so it is not even considered.
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await startRun("ancient", at(addDays(DATE, -10), "12:15"));
  await runMaintenance({ now: at(DATE, "12:20"), logger: fx.silentLogger });
  assert.deepEqual(await rows("ancient"), []);
});

test("a run whose slots are all past gets a single 'missed' marker, so it is not re-scanned", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  const startedAt = at(addDays(DATE, -2), "12:15");
  await startRun("stale", startedAt);
  const now = at(DATE, "12:20");

  await runMaintenance({ now, logger: fx.silentLogger });
  await runMaintenance({ now, logger: fx.silentLogger });

  const stale = await rows("stale");
  assert.equal(stale.length, 1);
  assert.equal(stale[0].status, "missed");
  assert.equal(fake.messages.length, 0);
});

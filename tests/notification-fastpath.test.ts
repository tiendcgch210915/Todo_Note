import assert from "node:assert/strict";
import { afterEach, before, beforeEach, mock, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";
process.env.JWT_SECRET = "test-jwt-secret-123";
process.env.JWT_ADMIN_SECRET = "test-admin-secret-123";
process.env.COOKIE_SECRET = "test-cookie-secret-123456789012345";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD_HASH = `$2b$12$${"a".repeat(53)}`;
// Hermetic: initFirebase() can never load real credentials.
process.env.GOOGLE_APPLICATION_CREDENTIALS = "./does-not-exist-service-account.json";

const { turso } = await import("../src/config/db.js");
const firebase = await import("../src/services/firebase.js");
const tickService = await import("../src/services/notification-tick.js");
const { createNotificationLoops } = await import("../src/services/notification-loops.js");
const jobsRepo = await import("../src/repositories/notification-jobs.js");
const { LATENESS_MS, NOTIFICATION_KINDS } = await import("../src/config/notification-policy.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID, OTHER_USER_ID } = fx;
const { runDispatch, runMaintenance, runTick } = tickService;
const MINUTE = 60_000;

const T0 = new Date("2026-06-20T00:30:00.000Z"); // 07:30 in Vietnam
const QUIET = new Date("2026-06-20T04:00:00.000Z"); // nothing planned is due at this time
const iso = (date: Date): string => date.toISOString();
const ago = (ms: number): string => iso(new Date(Date.now() - ms));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type LogRecord = { level: "info" | "warn" | "error"; obj: Record<string, unknown>; msg: string };
const capture = () => {
  const records: LogRecord[] = [];
  const make = (level: LogRecord["level"]) => (obj: object, msg: string) => {
    records.push({ level, obj: obj as Record<string, unknown>, msg });
  };
  return { records, logger: { info: make("info"), warn: make("warn"), error: make("error") } };
};
const sentLogs = (records: LogRecord[]) => records.filter((r) => r.msg === "notification sent");

let fake = fx.fakeMessaging();

before(async () => {
  await applyAllMigrations(turso);
});

afterEach(() => {
  mock.timers.reset();
});

beforeEach(async () => {
  for (const table of [
    "notification_jobs",
    "todo_timers",
    "notification_settings",
    "user_devices",
    "habit_logs",
    "habits",
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

// ── the two paths ────────────────────────────────────────────────────────────

test("the fast path only sends: no planning, backfill, purge or bulk updates", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await fx.insertTodo(turso, { id: "future", scheduledDate: fx.utcDateFromToday(2), time: "10:00" });
  await fx.insertRawJob(turso, {
    id: "ancient",
    kind: "digest_morning",
    localDate: "2026-04-01",
    runAt: iso(new Date(T0.getTime() - 40 * 24 * 60 * MINUTE)),
    status: "sent",
  });

  const dispatch = await runDispatch({ now: T0, logger: fx.silentLogger });

  assert.deepEqual(
    [dispatch.planned, dispatch.backfilled, dispatch.purged, dispatch.recovered, dispatch.stuck_failed],
    [0, 0, 0, 0, 0]
  );
  assert.equal((await fx.jobsFor(turso, USER_ID)).length, 1, "only the pre-existing row: nothing was planned");
  assert.equal(await jobsRepo.getEventJob(USER_ID, "todo_reminder", "future"), null, "no backfill");
  assert.equal(await fx.statusOf(turso, "ancient"), "sent", "no purge");
  assert.equal(fake.messages.length, 0);
});

test("maintenance plans, backfills and purges but never sends; the next fast beat then sends", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await fx.insertTodo(turso, { id: "future", scheduledDate: fx.utcDateFromToday(2), time: "10:00" });
  await fx.insertRawJob(turso, {
    id: "ancient",
    kind: "digest_morning",
    localDate: "2026-04-01",
    runAt: iso(new Date(T0.getTime() - 40 * 24 * 60 * MINUTE)),
    status: "sent",
  });

  const maintenance = await runMaintenance({ now: T0, logger: fx.silentLogger });

  assert.equal(maintenance.planned, 6);
  assert.equal(maintenance.backfilled, 1);
  assert.equal(maintenance.purged, 1);
  assert.equal(maintenance.claimed, 0);
  assert.equal(maintenance.sent, 0);
  assert.equal(fake.messages.length, 0, "maintenance never talks to FCM");
  assert.equal(await fx.statusOf(turso, "ancient"), null);

  const dispatch = await runDispatch({ now: T0, logger: fx.silentLogger });
  assert.equal(dispatch.sent, 1, "today's morning digest is due and is sent by the fast path");
  assert.equal(fake.messages.length, 1);
});

test("the endpoint path (runTick) still does both, with the unchanged summary shape", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");

  const summary = await runTick({ now: T0, logger: fx.silentLogger });

  assert.deepEqual(Object.keys(summary).sort(), [
    "backfilled",
    "cancelled",
    "claimed",
    "dry_run",
    "failed",
    "lost_claims",
    "missed",
    "planned",
    "purged",
    "push_disabled",
    "recovered",
    "retried",
    "sent",
    "stuck_failed",
  ]);
  assert.equal(summary.planned, 6, "planner ran");
  assert.equal(summary.sent, 1, "dispatch ran in the same call");
});

// ── safety guarantees on the fast path ───────────────────────────────────────

test("concurrent fast-path runs send a due job exactly once", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await fx.insertRawJob(turso, {
    id: "job-1",
    kind: "digest_morning",
    localDate: "2026-06-20",
    runAt: iso(new Date(QUIET.getTime() - MINUTE)),
  });

  const results = await Promise.all(
    Array.from({ length: 6 }, () => runDispatch({ now: QUIET, logger: fx.silentLogger }))
  );

  assert.equal(fake.messages.length, 1, "one push, however many runs raced");
  assert.equal(results.reduce((sum, r) => sum + r.claimed, 0), 1);
  assert.equal(results.reduce((sum, r) => sum + r.sent, 0), 1);
  assert.equal(await fx.statusOf(turso, "job-1"), "sent");
});

test("the lateness policy holds on the fast path alone: too-late jobs are missed, never sent", async () => {
  for (const kind of NOTIFICATION_KINDS) {
    const threshold = LATENESS_MS[kind];
    const common = {
      kind,
      refId: kind.startsWith("digest") ? null : `ref-${kind}`,
      localDate: kind.startsWith("digest") ? "2026-06-20" : null,
    };
    await fx.insertRawJob(turso, { id: `late-${kind}`, ...common, runAt: iso(new Date(QUIET.getTime() - threshold - 1000)) });
    await fx.insertRawJob(turso, { id: `ok-${kind}`, userId: OTHER_USER_ID, ...common, runAt: iso(new Date(QUIET.getTime() - threshold + 5000)) });
  }
  await fx.insertDevice(turso, USER_ID, "reg-1");

  const summary = await runDispatch({ now: QUIET, logger: fx.silentLogger });

  for (const kind of NOTIFICATION_KINDS) {
    assert.equal(await fx.statusOf(turso, `late-${kind}`), "missed", `${kind} late`);
    assert.notEqual(await fx.statusOf(turso, `ok-${kind}`), "missed", `${kind} within window`);
  }
  assert.equal(summary.missed, NOTIFICATION_KINDS.length);
  assert.equal(fake.messages.length, 0, "nothing was sent for the late jobs");
});

test("a job aimed at a device still goes only there, and is re-validated, on the fast path", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await fx.insertDevice(turso, USER_ID, "reg-B", { id: "device-B" });
  await fx.insertTodo(turso, { id: "todo-1", scheduledDate: "2026-06-20" });
  const endsAt = iso(new Date(QUIET.getTime() - 20_000));
  await turso.execute({
    sql: `INSERT INTO todo_timers (todo_id, user_id, status, estimated_seconds, ends_at, device_id, updated_at)
          VALUES ('todo-1', ?, 'running', 600, ?, 'device-A', ?)`,
    args: [USER_ID, endsAt, endsAt],
  });
  await fx.insertRawJob(turso, { id: "timer-job", kind: "todo_timer_end", refId: "todo-1", targetDeviceId: "device-A", runAt: endsAt });

  await runDispatch({ now: QUIET, logger: fx.silentLogger });

  assert.deepEqual(fake.targets(), ["reg-A"]);
  assert.equal(fake.messages[0].android?.ttl, 900_000);

  // same job again but the timer was paused meanwhile -> cancelled, nothing sent
  fake.messages.length = 0;
  await turso.execute("UPDATE todo_timers SET status = 'paused', ends_at = NULL");
  await turso.execute("UPDATE notification_jobs SET status = 'pending', attempts = 0, locked_at = NULL, sent_at = NULL WHERE id = 'timer-job'");
  await runDispatch({ now: QUIET, logger: fx.silentLogger });
  assert.equal(fake.messages.length, 0);
  assert.equal(await fx.statusOf(turso, "timer-job"), "cancelled");
});

test("without Firebase credentials the fast path leaves due jobs untouched", async () => {
  firebase.setMessagingClientForTests(null);
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await fx.insertRawJob(turso, { id: "job-1", kind: "digest_morning", localDate: "2026-06-20", runAt: iso(new Date(QUIET.getTime() - MINUTE)) });

  const summary = await runDispatch({ now: QUIET, logger: fx.silentLogger });

  assert.equal(summary.push_disabled, true);
  assert.equal(await fx.statusOf(turso, "job-1"), "pending");
});

// ── measurement log ──────────────────────────────────────────────────────────

test("each sent job logs kind, run_at, locked_at, sent_at, fcm_ms and lag_ms, and nothing personal", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-secret-registration-id", { id: "device-A" });
  await fx.insertTodo(turso, { id: "todo-1", title: "Việc bí mật riêng tư", scheduledDate: "2026-06-20" });
  const runAt = ago(2000);
  await turso.execute({
    sql: `INSERT INTO todo_timers (todo_id, user_id, status, estimated_seconds, ends_at, device_id, updated_at)
          VALUES ('todo-1', ?, 'running', 600, ?, 'device-A', ?)`,
    args: [USER_ID, runAt, runAt],
  });
  await fx.insertRawJob(turso, { id: "timer-job", kind: "todo_timer_end", refId: "todo-1", targetDeviceId: "device-A", runAt });
  const { records, logger } = capture();
  const before = Date.now();

  await runDispatch({ logger });

  assert.equal(fake.messages.length, 1);
  assert.match(fake.messages[0].notification?.body ?? "", /Việc bí mật riêng tư/, "the push itself does carry the title");
  const logs = sentLogs(records);
  assert.equal(logs.length, 1);
  const log = logs[0].obj;
  assert.equal(logs[0].level, "info");
  assert.equal(log.job_id, "timer-job");
  assert.equal(log.kind, "todo_timer_end");
  assert.equal(log.run_at, runAt);
  assert.ok(Date.parse(String(log.locked_at)) >= before, "locked_at is stamped when the job is claimed");
  assert.ok(Date.parse(String(log.sent_at)) >= Date.parse(String(log.locked_at)));
  assert.equal(typeof log.fcm_ms, "number");
  assert.ok((log.fcm_ms as number) >= 0);
  assert.equal(log.lag_ms, Date.parse(String(log.sent_at)) - Date.parse(runAt));
  assert.equal(log.claim_delay_ms, Date.parse(String(log.locked_at)) - Date.parse(runAt));
  assert.ok((log.claim_delay_ms as number) >= 2000, "the job was already 2 s overdue when claimed");
  assert.equal(log.attempts, 1);

  const stored = await jobsRepo.getJobById("timer-job");
  assert.equal(stored?.sent_at, log.sent_at, "the logged sent_at is the one stored on the job");
  assert.equal(stored?.locked_at, log.locked_at);

  // nothing personal anywhere in the log output
  const everything = JSON.stringify(records);
  assert.doesNotMatch(everything, /bí mật|reg-secret|@test\.local/);
  assert.equal(log.user_id, undefined);
});

test("dry run logs the same record with fcm_ms null and calls no FCM", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await fx.insertRawJob(turso, { id: "job-1", kind: "digest_morning", localDate: "2026-06-20", runAt: ago(1500) });
  const { records, logger } = capture();

  await runDispatch({ dryRun: true, logger });

  assert.equal(fake.messages.length, 0);
  const [entry] = sentLogs(records);
  assert.equal(entry.obj.fcm_ms, null);
  assert.equal(entry.obj.dry_run, true);
  assert.equal(entry.obj.kind, "digest_morning");
});

test("jobs that are cancelled, retried or missed produce no 'notification sent' line", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  // cancelled: digest_todos with no todos; retried: FCM keeps failing
  await fx.insertRawJob(turso, { id: "cancelled", kind: "digest_todos", localDate: "2026-06-20", runAt: ago(2000) });
  await fx.insertRawJob(turso, { id: "missed", kind: "digest_habits", localDate: "2026-06-20", runAt: ago(2 * 60 * MINUTE) });
  fake = fx.fakeMessaging(() => ({ ok: false, code: "messaging/internal-error" }));
  firebase.setMessagingClientForTests(fake.client);
  await fx.insertRawJob(turso, { id: "retried", kind: "digest_morning", localDate: "2026-06-20", runAt: ago(2000) });
  const { records, logger } = capture();

  const summary = await runDispatch({ logger });

  assert.deepEqual(
    [summary.cancelled, summary.missed, summary.retried, summary.sent],
    [1, 1, 1, 0]
  );
  assert.equal(sentLogs(records).length, 0);
});

// ── latency: due jobs are handled within one fast cycle ──────────────────────

test("a job that becomes due is sent within about one fast cycle (real timers, 1 s loop)", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  const { records, logger } = capture();
  const loops = createNotificationLoops({
    dispatch: () => runDispatch({ logger }),
    maintain: async () => undefined,
    fastSeconds: 1,
    logger: fx.silentLogger,
  });
  loops.start();
  await loops.idle(); // the immediate beat finds nothing

  const runAt = new Date(Date.now() + 1300);
  await fx.insertRawJob(turso, { id: "job-1", kind: "digest_morning", localDate: "2026-06-20", runAt: iso(runAt) });

  const deadline = Date.now() + 6000;
  while ((await fx.statusOf(turso, "job-1")) !== "sent" && Date.now() < deadline) await sleep(25);
  await loops.stop();

  assert.equal(await fx.statusOf(turso, "job-1"), "sent");
  const [entry] = sentLogs(records);
  const lag = entry.obj.lag_ms as number;
  assert.ok(lag >= 0, `sent before it was due? lag=${lag}`);
  assert.ok(lag < 2000, `expected < 1 cycle + processing, got ${lag} ms`);
  assert.ok((entry.obj.claim_delay_ms as number) <= 1500, `claim waited ${entry.obj.claim_delay_ms} ms`);
});

// ── restart and external tick ────────────────────────────────────────────────

test("after a restart the first beat catches up on jobs that came due while the process was down", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await fx.insertRawJob(turso, { id: "recent", kind: "digest_morning", localDate: "2026-06-20", runAt: ago(20_000) });
  await fx.insertRawJob(turso, { id: "too-late", kind: "digest_habits", localDate: "2026-06-20", runAt: ago(LATENESS_MS.digest_habits + MINUTE) });

  const loops = createNotificationLoops({
    dispatch: () => runDispatch({ logger: fx.silentLogger }),
    maintain: async () => undefined,
    fastSeconds: 3,
    logger: fx.silentLogger,
  });
  loops.start();
  await loops.idle();
  await loops.stop();

  assert.equal(await fx.statusOf(turso, "recent"), "sent", "within the lateness window: sent right away");
  assert.equal(await fx.statusOf(turso, "too-late"), "missed", "beyond the window: dropped, not sent late");
  assert.equal(fake.messages.length, 1);
});

test("the external tick still sends a job the fast loop never saw (loop down or never started)", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  const loops = createNotificationLoops({
    dispatch: () => runDispatch({ logger: fx.silentLogger }),
    maintain: async () => undefined,
    fastSeconds: 3,
    logger: fx.silentLogger,
  });
  loops.start();
  await loops.idle();
  await loops.stop(); // the process "restarts": the loop is gone

  await fx.insertRawJob(turso, { id: "missed-by-loop", kind: "digest_morning", localDate: "2026-06-19", runAt: ago(30_000) });
  assert.equal(await fx.statusOf(turso, "missed-by-loop"), "pending");

  const summary = await runTick({ logger: fx.silentLogger }); // what POST /internal/notifications/tick runs

  assert.equal(await fx.statusOf(turso, "missed-by-loop"), "sent");
  assert.ok(summary.sent >= 1);
});

test("fast loop and external tick racing on the same job send it once", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await fx.insertRawJob(turso, { id: "job-1", kind: "digest_morning", localDate: "2026-06-19", runAt: ago(10_000) });
  const loops = createNotificationLoops({
    dispatch: () => runDispatch({ logger: fx.silentLogger }),
    maintain: async () => undefined,
    fastSeconds: 3,
    logger: fx.silentLogger,
  });

  loops.start();
  await runTick({ logger: fx.silentLogger });
  await loops.stop();

  assert.equal(await fx.statusOf(turso, "job-1"), "sent");
  const forJob = fake.messages.filter((m) => m.data?.date === "2026-06-19");
  assert.equal(forJob.length, 1);
});

// ── transient failures ───────────────────────────────────────────────────────

test("a transient database failure is logged, the loop survives and the next beat sends the job", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await fx.insertRawJob(turso, { id: "job-1", kind: "digest_morning", localDate: "2026-06-20", runAt: ago(5000) });

  const original = turso.execute.bind(turso);
  let failed = false;
  (turso as { execute: unknown }).execute = (statement: unknown) => {
    const sql = typeof statement === "object" && statement !== null ? String((statement as { sql?: string }).sql) : "";
    if (!failed && sql.includes("FROM notification_jobs") && sql.includes("ORDER BY run_at")) {
      failed = true;
      throw new Error("simulated database outage");
    }
    return original(statement as never);
  };
  const { records, logger } = capture();
  const loops = createNotificationLoops({
    dispatch: () => runDispatch({ logger: fx.silentLogger }),
    maintain: async () => undefined,
    fastSeconds: 3,
    logger,
  });

  try {
    loops.start();
    await loops.idle();
    assert.equal(failed, true);
    assert.equal(await fx.statusOf(turso, "job-1"), "pending", "nothing was lost or half-done");
    assert.equal(records.filter((r) => r.level === "error").length, 1);

    mock.timers.tick(3000); // next fast beat
    await loops.idle();
    assert.equal(await fx.statusOf(turso, "job-1"), "sent");
    assert.equal(fake.messages.length, 1);
    assert.deepEqual([loops.stats().fast.runs, loops.stats().fast.failures], [2, 1]);
  } finally {
    (turso as { execute: unknown }).execute = original;
    await loops.stop();
  }
});

test("an FCM failure inside a beat does not stop the loop either", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  await fx.insertDevice(turso, USER_ID, "reg-1");
  fake = fx.fakeMessaging(() => ({ ok: false, code: "messaging/internal-error" }));
  firebase.setMessagingClientForTests(fake.client);
  await fx.insertRawJob(turso, { id: "job-1", kind: "digest_morning", localDate: "2026-06-20", runAt: ago(5000) });
  const loops = createNotificationLoops({
    dispatch: () => runDispatch({ logger: fx.silentLogger }),
    maintain: async () => undefined,
    fastSeconds: 3,
    logger: fx.silentLogger,
  });

  loops.start();
  await loops.idle();
  assert.equal(await fx.statusOf(turso, "job-1"), "pending", "kept for retry");

  // FCM recovers; the retry spacing (2 min) must pass before the same job is tried again
  fake = fx.fakeMessaging();
  firebase.setMessagingClientForTests(fake.client);
  await turso.execute({
    sql: "UPDATE notification_jobs SET locked_at = ? WHERE id = 'job-1'",
    args: [ago(3 * MINUTE)],
  });
  mock.timers.tick(3000);
  await loops.idle();
  await loops.stop();

  assert.equal(await fx.statusOf(turso, "job-1"), "sent");
});

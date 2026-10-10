import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

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
const { runTick } = await import("../src/services/notification-tick.js");
const planner = await import("../src/services/notification-planner.js");
const jobsRepo = await import("../src/repositories/notification-jobs.js");
const { LATENESS_MS, NOTIFICATION_KINDS } = await import(
  "../src/config/notification-policy.js"
);
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID, OTHER_USER_ID } = fx;
const MINUTE = 60_000;

// 2026-06-20 07:30 in Vietnam.
const T0 = new Date("2026-06-20T00:30:00.000Z");
// 11:00 in Vietnam: the planner creates nothing that is already due, so tests that seed
// their own jobs are not disturbed by planner-created digests.
const QUIET = new Date("2026-06-20T04:00:00.000Z");

const tick = (now: Date, options: { dryRun?: boolean } = {}) =>
  runTick({ now, dryRun: options.dryRun, logger: fx.silentLogger });

const plusMinutes = (date: Date, minutes: number): Date =>
  new Date(date.getTime() + minutes * MINUTE);

const iso = (date: Date): string => date.toISOString();

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
    "habit_logs",
    "habits",
    "checklist_run_items",
    "checklist_runs",
    "checklist_template_items",
    "daily_todo_logs",
    "daily_todo_summaries",
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await turso.execute("DELETE FROM checklist_templates WHERE user_id <> '00000000-0000-0000-0000-000000000001'");
  await turso.execute("UPDATE todos SET parent_id = NULL, trigger_after_todo_id = NULL");
  await turso.execute("DELETE FROM todos");
  await turso.execute(`DELETE FROM users WHERE id IN ('${USER_ID}', '${OTHER_USER_ID}', 'user-disabled')`);

  await fx.insertUser(turso, USER_ID);
  await fx.insertUser(turso, OTHER_USER_ID);

  fake = fx.fakeMessaging();
  firebase.setMessagingClientForTests(fake.client);
  firebase.setPushLogger(fx.silentLogger);
});

// ── planner ──────────────────────────────────────────────────────────────────

test("planner creates the three digests for today and tomorrow in the user's zone, once", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");

  assert.equal(await planner.planAllUsers(T0), 6);
  assert.equal(await planner.planAllUsers(T0), 0, "second run must not create duplicates");
  assert.equal(await planner.planAllUsers(plusMinutes(T0, 5)), 0);

  const rows = await fx.jobsFor(turso, USER_ID);
  assert.equal(rows.length, 6);
  const key = (row: Record<string, unknown>) => `${row.kind} ${row.local_date} ${row.run_at}`;
  assert.deepEqual(rows.map(key).sort(), [
    "digest_habits 2026-06-20 2026-06-20T10:30:00.000Z",
    "digest_habits 2026-06-21 2026-06-21T10:30:00.000Z",
    "digest_morning 2026-06-20 2026-06-20T00:00:00.000Z",
    "digest_morning 2026-06-21 2026-06-21T00:00:00.000Z",
    "digest_todos 2026-06-20 2026-06-20T10:00:00.000Z",
    "digest_todos 2026-06-21 2026-06-21T10:00:00.000Z",
  ]);
});

test("planner skips digests already past their lateness window and ignores users without devices", async () => {
  await fx.insertUser(turso, "user-disabled", { deletedAt: "2026-06-10T00:00:00.000Z" });
  await fx.insertDevice(turso, "user-disabled", "reg-disabled");
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await turso.execute({
    sql: "UPDATE users SET timezone = 'Pacific/Auckland' WHERE id = ?",
    args: [USER_ID],
  });

  await planner.planAllUsers(T0);

  // Auckland is UTC+12: at T0 it is 12:30, so today's 07:00 digest is 5.5 h late (> 2 h).
  const rows = await fx.jobsFor(turso, USER_ID);
  const morning = rows.filter((row) => row.kind === "digest_morning");
  assert.deepEqual(morning.map((row) => row.local_date), ["2026-06-21"]);
  assert.equal(rows.length, 5);
  assert.equal((await fx.jobsFor(turso, OTHER_USER_ID)).length, 0, "no device -> no jobs");
  assert.equal((await fx.jobsFor(turso, "user-disabled")).length, 0, "disabled user -> no jobs");
});

// ── atomic claim ─────────────────────────────────────────────────────────────

test("two concurrent claims of one job: exactly one wins", async () => {
  await fx.insertRawJob(turso, { id: "job-1", kind: "digest_morning", localDate: "2026-06-20", runAt: iso(T0) });
  const results = await Promise.all([
    jobsRepo.claimJob("job-1", iso(T0)),
    jobsRepo.claimJob("job-1", iso(T0)),
    jobsRepo.claimJob("job-1", iso(T0)),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await fx.statusOf(turso, "job-1"), "processing");
  assert.equal((await jobsRepo.getJobById("job-1"))?.attempts, 1);
});

test("two concurrent ticks send a due job only once", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");

  const [a, b] = await Promise.all([tick(T0), tick(T0)]);

  assert.equal(fake.messages.length, 1, "exactly one push for the one due digest");
  assert.equal(a.claimed + b.claimed, 1);
  assert.equal(a.sent + b.sent, 1);
});

// ── re-validation right before sending ──────────────────────────────────────

const REMINDER_RUN_AT = "2026-06-20T01:00:00.000Z"; // 2026-06-20 08:00 in Vietnam
const AFTER_REMINDER = new Date("2026-06-20T01:00:30.000Z");

const seedReminder = async (todo: Parameters<typeof fx.insertTodo>[1] = { id: "todo-1" }) => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await fx.insertTodo(turso, { scheduledDate: "2026-06-20", time: "08:00", title: "Uống nước", ...todo });
  await fx.insertRawJob(turso, {
    id: "job-reminder",
    kind: "todo_reminder",
    refId: todo.id,
    runAt: REMINDER_RUN_AT,
  });
};

test("todo reminder is sent when the todo is still open and the time still matches", async () => {
  await seedReminder();
  const summary = await tick(AFTER_REMINDER);

  assert.equal(summary.sent >= 1, true);
  assert.equal(await fx.statusOf(turso, "job-reminder"), "sent");
  const message = fake.messages.find((m) => m.notification?.title === "Đến giờ thực hiện");
  assert.ok(message);
  assert.equal(message.notification?.body, "Uống nước");
  assert.deepEqual(message.data, { type: "todo", id: "todo-1", date: "2026-06-20" });
  assert.equal(message.android?.priority, "high");
  assert.equal(message.android?.ttl, 3_600_000);
  assert.equal(message.android?.notification?.channelId, "todo_reminders");
});

test("todo reminder is cancelled, not sent, if the todo was completed, deleted or re-timed", async () => {
  const cases: Array<[string, string]> = [
    ["completed", "UPDATE todos SET status = 'done' WHERE id = 'todo-1'"],
    ["archived", "UPDATE todos SET status = 'archived' WHERE id = 'todo-1'"],
    ["deleted", "UPDATE todos SET deleted_at = '2026-06-20T00:10:00.000Z' WHERE id = 'todo-1'"],
    ["re-timed", "UPDATE todos SET time = '09:30' WHERE id = 'todo-1'"],
    ["time removed", "UPDATE todos SET time = NULL WHERE id = 'todo-1'"],
    ["moved to another day", "UPDATE todos SET scheduled_date = '2026-06-25' WHERE id = 'todo-1'"],
  ];
  for (const [label, sql] of cases) {
    await turso.execute("DELETE FROM notification_jobs");
    await turso.execute("DELETE FROM todos");
    await turso.execute("DELETE FROM user_devices");
    fake.messages.length = 0;
    await seedReminder();
    await turso.execute(sql);

    await tick(AFTER_REMINDER);

    assert.equal(await fx.statusOf(turso, "job-reminder"), "cancelled", label);
    assert.equal(
      fake.messages.some((m) => m.notification?.title === "Đến giờ thực hiện"),
      false,
      label
    );
  }
});

test("checklist reminder reports unticked steps and is cancelled when all are ticked or the run stopped", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  const items = await fx.insertTemplateWithItems(turso, { id: "tpl-1", title: "Rời nhà", itemCount: 3 });
  const startedAt = "2026-06-20T03:00:00.000Z";
  await turso.execute({
    sql: `INSERT INTO checklist_runs (id, template_id, user_id, name, status, started_at, created_at, updated_at)
          VALUES ('run-1', 'tpl-1', ?, NULL, 'in_progress', ?, ?, ?)`,
    args: [USER_ID, startedAt, startedAt, startedAt],
  });
  for (const [index, itemId] of items.entries()) {
    await turso.execute({
      sql: `INSERT INTO checklist_run_items (id, run_id, template_item_id, status, created_at, updated_at)
            VALUES (?, 'run-1', ?, ?, ?, ?)`,
      args: [`ri-${index}`, itemId, index === 0 ? "done" : "pending", startedAt, startedAt],
    });
  }
  const runAt = "2026-06-20T03:30:00.000Z";
  const now = new Date("2026-06-20T03:31:00.000Z");
  await fx.insertRawJob(turso, { id: "job-cl", kind: "checklist_30m", refId: "run-1", runAt });

  await tick(now);

  assert.equal(await fx.statusOf(turso, "job-cl"), "sent");
  const message = fake.messages.find((m) => m.data?.type === "checklist");
  assert.ok(message);
  assert.equal(
    message.notification?.body,
    "Checklist “Rời nhà” đã chạy 30 phút. Còn 2 bước chưa tick, hãy kiểm tra lại cho đầy đủ nhé."
  );
  assert.equal(message.android?.notification?.channelId, "checklist_reminders");
  assert.equal(message.android?.ttl, 1_800_000);

  for (const [label, sql] of [
    ["all ticked", "UPDATE checklist_run_items SET status = 'done'"],
    ["run completed", "UPDATE checklist_runs SET status = 'completed'"],
    ["run abandoned", "UPDATE checklist_runs SET status = 'abandoned'"],
    ["run deleted", "UPDATE checklist_runs SET deleted_at = '2026-06-20T03:10:00.000Z'"],
  ] as const) {
    await turso.execute("UPDATE checklist_runs SET status = 'in_progress', deleted_at = NULL");
    await turso.execute("UPDATE checklist_run_items SET status = 'pending'");
    await turso.execute({ sql: "UPDATE notification_jobs SET status = 'pending', attempts = 0, locked_at = NULL WHERE id = 'job-cl'" });
    fake.messages.length = 0;
    await turso.execute(sql);

    await tick(now);

    assert.equal(await fx.statusOf(turso, "job-cl"), "cancelled", label);
    assert.equal(fake.messages.some((m) => m.data?.type === "checklist"), false, label);
  }
});

test("digests: morning always sends, todos/habits are skipped when there is nothing to report", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  const date = "2026-06-20";
  for (const kind of ["digest_morning", "digest_todos", "digest_habits"]) {
    await fx.insertRawJob(turso, { id: `job-${kind}`, kind, localDate: date, runAt: iso(plusMinutes(QUIET, -1)) });
  }

  await tick(QUIET);

  assert.equal(await fx.statusOf(turso, "job-digest_morning"), "sent");
  assert.equal(await fx.statusOf(turso, "job-digest_todos"), "cancelled", "T = 0");
  assert.equal(await fx.statusOf(turso, "job-digest_habits"), "cancelled", "H = 0");
  const types = fake.messages.map((m) => m.data?.type);
  assert.deepEqual(types, ["digest_morning"]);
  assert.equal(fake.messages[0].android?.notification?.channelId, "daily_digest");
  assert.equal(fake.messages[0].android?.ttl, 7_200_000);
  assert.deepEqual(fake.messages[0].data, { type: "digest_morning", id: date, date });
});

test("digests use live data: todo counts and habit progress for the job's local date", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  const date = "2026-06-20";
  await fx.insertTodo(turso, { id: "t-1", scheduledDate: date, status: "done" });
  await fx.insertTodo(turso, { id: "t-2", scheduledDate: date });
  await fx.insertTodo(turso, { id: "t-3", scheduledDate: date });
  await fx.insertTodo(turso, { id: "t-parked", scheduledDate: date, status: "archived" });
  await fx.insertTodo(turso, { id: "t-sub", scheduledDate: date, parentId: "t-2" });
  await fx.insertTodo(turso, { id: "t-other-day", scheduledDate: "2026-06-21" });
  await fx.insertHabit(turso, { id: "h-1" });
  await fx.insertHabit(turso, { id: "h-2" });
  await fx.insertHabitLog(turso, { id: "l-1", habitId: "h-1", logDate: date, completed: 1 });
  const runAt = iso(plusMinutes(QUIET, -1));
  await fx.insertRawJob(turso, { id: "j-todos", kind: "digest_todos", localDate: date, runAt });
  await fx.insertRawJob(turso, { id: "j-habits", kind: "digest_habits", localDate: date, runAt });

  await tick(QUIET);

  const bodies = Object.fromEntries(fake.messages.map((m) => [m.data?.type, m.notification?.body]));
  assert.equal(bodies.digest_todos, "Bạn đã hoàn thành 1 todo rồi, còn lại 2 todo nữa vẫn đang chờ bạn.");
  assert.equal(bodies.digest_habits, "Hôm nay bạn đã duy trì được 1/2 thói quen.");
});

test("a job of a disabled user is cancelled, not sent", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await fx.insertRawJob(turso, { id: "job-1", kind: "digest_morning", localDate: "2026-06-20", runAt: iso(plusMinutes(QUIET, -1)) });
  await turso.execute({
    sql: "UPDATE users SET deleted_at = ? WHERE id = ?",
    args: ["2026-06-20T00:00:00.000Z", USER_ID],
  });

  await tick(QUIET);

  assert.equal(await fx.statusOf(turso, "job-1"), "cancelled");
  assert.equal(fake.messages.length, 0);
});

// ── lateness policy ──────────────────────────────────────────────────────────

test("each kind is marked missed (and never sent) once it is later than its own threshold", async () => {
  // No device on purpose: nothing is sent for a job that merely survives the lateness check.
  for (const kind of NOTIFICATION_KINDS) {
    const threshold = LATENESS_MS[kind];
    await fx.insertRawJob(turso, {
      id: `late-${kind}`,
      kind,
      refId: kind.startsWith("digest") ? null : `ref-${kind}`,
      localDate: kind.startsWith("digest") ? "2026-06-20" : null,
      runAt: iso(new Date(QUIET.getTime() - threshold - 1000)),
    });
    await fx.insertRawJob(turso, {
      id: `ok-${kind}`,
      userId: OTHER_USER_ID,
      kind,
      refId: kind.startsWith("digest") ? null : `ref-${kind}`,
      localDate: kind.startsWith("digest") ? "2026-06-20" : null,
      runAt: iso(new Date(QUIET.getTime() - threshold + 5000)),
    });
  }

  const summary = await tick(QUIET);

  for (const kind of NOTIFICATION_KINDS) {
    assert.equal(await fx.statusOf(turso, `late-${kind}`), "missed", `${kind} late`);
    assert.notEqual(await fx.statusOf(turso, `ok-${kind}`), "missed", `${kind} within window`);
  }
  assert.equal(summary.missed, NOTIFICATION_KINDS.length);
  assert.equal(fake.messages.length, 0);
});

test("the documented lateness thresholds are the configured ones", () => {
  const MIN = 60 * MINUTE;
  assert.deepEqual(LATENESS_MS, {
    todo_reminder: 30 * MINUTE,
    todo_timer_end: 5 * MINUTE,
    checklist_30m: 15 * MINUTE,
    digest_morning: 2 * MIN,
    digest_todos: 2 * MIN,
    digest_habits: 1 * MIN,
  });
});

// ── retries ──────────────────────────────────────────────────────────────────

test("transient FCM failures are retried with spacing, then marked failed after 3 attempts", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  fake = fx.fakeMessaging(() => ({ ok: false, code: "messaging/internal-error" }));
  firebase.setMessagingClientForTests(fake.client);
  await fx.insertRawJob(turso, {
    id: "job-1",
    kind: "digest_morning",
    localDate: "2026-06-19",
    runAt: iso(plusMinutes(QUIET, -10)),
  });
  const attempts = async () => (await jobsRepo.getJobById("job-1"))?.attempts;

  await tick(QUIET);
  assert.equal(await fx.statusOf(turso, "job-1"), "pending");
  assert.equal(await attempts(), 1);

  await tick(plusMinutes(QUIET, 1));
  assert.equal(await attempts(), 1, "retry spacing (2 min) not elapsed yet");

  await tick(plusMinutes(QUIET, 2));
  assert.equal(await fx.statusOf(turso, "job-1"), "pending");
  assert.equal(await attempts(), 2);

  await tick(plusMinutes(QUIET, 4));
  assert.equal(await fx.statusOf(turso, "job-1"), "failed");
  assert.equal(await attempts(), 3);
  assert.equal(fake.messages.length, 3);

  await tick(plusMinutes(QUIET, 10));
  assert.equal(fake.messages.length, 3, "a failed job is never retried again");
  // the registration survived: transient errors never delete a device
  assert.equal((await turso.execute("SELECT id FROM user_devices")).rows.length, 1);
});

// ── devices ──────────────────────────────────────────────────────────────────

test("a registration FCM reports as dead is deleted; the job is still sent to the others", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-good");
  await fx.insertDevice(turso, USER_ID, "reg-dead");
  fake = fx.fakeMessaging((message) => {
    const m = message as { token?: string };
    return m.token === "reg-dead"
      ? { ok: false, code: "messaging/registration-token-not-registered" }
      : { ok: true };
  });
  firebase.setMessagingClientForTests(fake.client);
  await fx.insertRawJob(turso, { id: "job-1", kind: "digest_morning", localDate: "2026-06-20", runAt: iso(plusMinutes(QUIET, -1)) });

  await tick(QUIET);

  assert.equal(await fx.statusOf(turso, "job-1"), "sent");
  const left = await turso.execute("SELECT registration_id FROM user_devices");
  assert.deepEqual(left.rows.map((r) => r.registration_id), ["reg-good"]);
});

test("when every device is dead the job is cancelled, not retried forever", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-dead");
  fake = fx.fakeMessaging(() => ({ ok: false, code: "messaging/registration-token-not-registered" }));
  firebase.setMessagingClientForTests(fake.client);
  await fx.insertRawJob(turso, { id: "job-1", kind: "digest_morning", localDate: "2026-06-20", runAt: iso(plusMinutes(QUIET, -1)) });

  await tick(QUIET);

  assert.equal(await fx.statusOf(turso, "job-1"), "cancelled");
  assert.equal((await turso.execute("SELECT id FROM user_devices")).rows.length, 0);
  assert.equal(fake.messages.length, 1);
});

test("an all-devices job reaches every device of the user", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-a");
  await fx.insertDevice(turso, USER_ID, "reg-b", { kind: "fid" });
  await fx.insertRawJob(turso, { id: "job-1", kind: "digest_morning", localDate: "2026-06-20", runAt: iso(plusMinutes(QUIET, -1)) });

  await tick(QUIET);

  assert.deepEqual(fake.targets().sort(), ["reg-a", "reg-b"]);
});

// ── dry run / push disabled / stuck jobs ─────────────────────────────────────

test("NOTIFY_DRY_RUN marks jobs sent without calling FCM", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await fx.insertRawJob(turso, { id: "job-1", kind: "digest_morning", localDate: "2026-06-20", runAt: iso(plusMinutes(QUIET, -1)) });

  const summary = await tick(QUIET, { dryRun: true });

  assert.equal(summary.dry_run, true);
  assert.equal(fake.messages.length, 0);
  assert.equal(await fx.statusOf(turso, "job-1"), "sent");
});

test("without Firebase credentials the tick leaves due jobs untouched", async () => {
  firebase.setMessagingClientForTests(null);
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await fx.insertRawJob(turso, { id: "job-1", kind: "digest_morning", localDate: "2026-06-20", runAt: iso(plusMinutes(QUIET, -1)) });

  const summary = await tick(QUIET);

  assert.equal(summary.push_disabled, true);
  assert.equal(summary.claimed, 0);
  const job = await jobsRepo.getJobById("job-1");
  assert.equal(job?.status, "pending");
  assert.equal(job?.attempts, 0);
});

test("a job stuck in processing for over 5 minutes is picked up again", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await fx.insertRawJob(turso, {
    id: "job-1",
    kind: "digest_morning",
    localDate: "2026-06-20",
    runAt: iso(plusMinutes(QUIET, -20)),
    status: "processing",
    attempts: 1,
    lockedAt: iso(plusMinutes(QUIET, -6)),
  });
  await fx.insertRawJob(turso, {
    id: "job-fresh",
    kind: "digest_todos",
    localDate: "2026-06-20",
    runAt: iso(plusMinutes(QUIET, -20)),
    status: "processing",
    attempts: 1,
    lockedAt: iso(plusMinutes(QUIET, -1)),
  });

  const summary = await tick(QUIET);

  assert.equal(summary.recovered, 1);
  assert.equal(await fx.statusOf(turso, "job-1"), "sent");
  assert.equal(await fx.statusOf(turso, "job-fresh"), "processing", "a recent lock is left alone");
});

test("a stuck job that already used all its attempts is failed instead of looping", async () => {
  await fx.insertRawJob(turso, {
    id: "job-1",
    kind: "digest_morning",
    localDate: "2026-06-20",
    runAt: iso(plusMinutes(QUIET, -20)),
    status: "processing",
    attempts: 3,
    lockedAt: iso(plusMinutes(QUIET, -6)),
  });

  const summary = await tick(QUIET);

  assert.equal(summary.stuck_failed, 1);
  assert.equal(await fx.statusOf(turso, "job-1"), "failed");
});

test("the tick summary contains counts only, no personal data", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  await fx.insertTodo(turso, { id: "t-1", title: "Bí mật riêng tư", scheduledDate: "2026-06-20", time: "12:00" });

  const summary = await tick(QUIET);

  for (const value of Object.values(summary)) {
    assert.ok(typeof value === "number" || typeof value === "boolean");
  }
  assert.doesNotMatch(JSON.stringify(summary), /Bí mật|reg-1|@test/);
});

// ── planner efficiency and retention ────────────────────────────────────────

test("in steady state the planner reads but performs no writes, and fills only what is missing", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-1");
  assert.equal(await planner.planAllUsers(T0), 6);

  const originalBatch = turso.batch.bind(turso);
  let batches = 0;
  (turso as { batch: unknown }).batch = (...args: Parameters<typeof turso.batch>) => {
    batches++;
    return originalBatch(...args);
  };
  try {
    assert.equal(await planner.planAllUsers(T0), 0);
    assert.equal(await planner.planAllUsers(plusMinutes(T0, 3)), 0);
    assert.equal(batches, 0, "nothing to write -> no batch is issued");
  } finally {
    (turso as { batch: unknown }).batch = originalBatch;
  }

  await turso.execute("DELETE FROM notification_jobs WHERE kind = 'digest_todos' AND local_date = '2026-06-21'");
  assert.equal(await planner.planAllUsers(T0), 1, "only the missing digest is recreated");
  assert.equal((await fx.jobsFor(turso, USER_ID)).length, 6);
});

test("finished jobs older than 30 days are purged; recent and active ones are kept", async () => {
  const day = 24 * 60 * MINUTE;
  const old = iso(new Date(QUIET.getTime() - 40 * day));
  const recent = iso(new Date(QUIET.getTime() - 2 * day));
  for (const [index, status] of ["sent", "cancelled", "missed", "failed"].entries()) {
    await fx.insertRawJob(turso, { id: `old-${status}`, kind: "digest_morning", localDate: `2026-04-0${index + 1}`, runAt: old, status });
  }
  await fx.insertRawJob(turso, { id: "recent-sent", kind: "digest_todos", localDate: "2026-06-18", runAt: recent, status: "sent" });
  await fx.insertRawJob(turso, { id: "old-processing", kind: "digest_habits", localDate: "2026-04-20", runAt: old, status: "processing", attempts: 1, lockedAt: iso(plusMinutes(QUIET, -1)) });

  const summary = await tick(QUIET);

  assert.equal(summary.purged, 4);
  for (const status of ["sent", "cancelled", "missed", "failed"]) {
    assert.equal(await fx.statusOf(turso, `old-${status}`), null, status);
  }
  assert.equal(await fx.statusOf(turso, "recent-sent"), "sent");
  assert.notEqual(await fx.statusOf(turso, "old-processing"), null, "an active job is never purged");
});

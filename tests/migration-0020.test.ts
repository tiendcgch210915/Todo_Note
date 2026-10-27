import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { before, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";

const { turso } = await import("../src/config/db.js");
const { parseStatements } = await import("./helpers/migrations.js");

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const MIGRATION = "0020_checklist_running_nudges.sql";

const apply = async (file: string): Promise<void> => {
  const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
  // One atomic batch per file, the way `npm run db:migrate` applies it.
  await turso.batch(parseStatements(sql), "write");
};

const insertJob = async (
  id: string,
  kind: string,
  status: string,
  options: { refId?: string | null; runAt?: string; localDate?: string | null } = {}
): Promise<void> => {
  await turso.execute({
    sql: `INSERT INTO notification_jobs
          (id, user_id, kind, ref_id, local_date, run_at, status, attempts, created_at)
          VALUES (?, 'u1', ?, ?, ?, ?, ?, 0, '2026-06-01T00:00:00Z')`,
    args: [id, kind, options.refId ?? null, options.localDate ?? null, options.runAt ?? "2026-06-20T01:00:00.000Z", status],
  });
};

const statusOf = async (id: string): Promise<string | null> => {
  const res = await turso.execute({ sql: "SELECT status FROM notification_jobs WHERE id = ?", args: [id] });
  return res.rows.length === 0 ? null : (res.rows[0] as unknown as { status: string }).status;
};

before(async () => {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files.filter((f) => f < MIGRATION)) {
    for (const statement of parseStatements(await readFile(join(MIGRATIONS_DIR, file), "utf-8"))) {
      await turso.execute(statement);
    }
  }

  // State of a production database right before this migration.
  await turso.execute(
    `INSERT INTO users (id, email, password_hash, timezone, is_admin, created_at, updated_at)
     VALUES ('u1', 'u1@test.local', 'x', 'Asia/Ho_Chi_Minh', 0, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`
  );
  await insertJob("old-pending", "checklist_30m", "pending", { refId: "run-a" });
  await insertJob("old-processing", "checklist_30m", "processing", { refId: "run-b" });
  await insertJob("old-sent", "checklist_30m", "sent", { refId: "run-c" });
  await insertJob("reminder", "todo_reminder", "pending", { refId: "todo-1" });
  await insertJob("digest", "digest_morning", "pending", { localDate: "2026-06-20" });
  await insertJob("overdue-1", "todo_overdue", "pending", { refId: "todo-2", runAt: "2026-06-20T03:00:00.000Z", localDate: "2026-06-20" });

  await apply(MIGRATION);
});

test("every job survives the rebuild; only pending/processing 30-minute jobs are cancelled", async () => {
  assert.equal(await statusOf("old-pending"), "cancelled");
  assert.equal(await statusOf("old-processing"), "cancelled");
  assert.equal(await statusOf("old-sent"), "sent", "history is kept as it was");
  assert.equal(await statusOf("reminder"), "pending");
  assert.equal(await statusOf("digest"), "pending");
  assert.equal(await statusOf("overdue-1"), "pending");

  const count = await turso.execute("SELECT COUNT(*) AS n FROM notification_jobs");
  assert.equal(Number((count.rows[0] as unknown as { n: number }).n), 6);
});

test("the table now accepts checklist_running and still rejects unknown kinds", async () => {
  await insertJob("run-1", "checklist_running", "pending", { refId: "run-1", localDate: "2026-06-20" });
  assert.equal(await statusOf("run-1"), "pending");

  await assert.rejects(() => insertJob("bad", "checklist_hourly", "pending", { refId: "x" }), /CHECK/i);
});

test("a run gets one row per slot: same run_at conflicts, different run_at does not", async () => {
  await insertJob("slot-1", "checklist_running", "pending", { refId: "run-2", runAt: "2026-06-20T06:15:00.000Z" });
  await insertJob("slot-2", "checklist_running", "pending", { refId: "run-2", runAt: "2026-06-20T07:15:00.000Z" });
  await insertJob("slot-3", "checklist_running", "pending", { refId: "run-2", runAt: "2026-06-21T23:00:00.000Z" });

  await assert.rejects(
    () => insertJob("slot-dup", "checklist_running", "pending", { refId: "run-2", runAt: "2026-06-20T06:15:00.000Z" }),
    /UNIQUE/i
  );
  // The same instant for another run is fine.
  await insertJob("slot-other", "checklist_running", "pending", { refId: "run-3", runAt: "2026-06-20T06:15:00.000Z" });
});

test("the older indexes still hold: one reminder per todo, one digest per day, overdue per slot", async () => {
  await assert.rejects(() => insertJob("reminder-2", "todo_reminder", "pending", { refId: "todo-1" }), /UNIQUE/i);
  await assert.rejects(
    () => insertJob("digest-2", "digest_morning", "pending", { localDate: "2026-06-20" }),
    /UNIQUE/i
  );
  await assert.rejects(
    () => insertJob("overdue-2", "todo_overdue", "pending", { refId: "todo-2", runAt: "2026-06-20T03:00:00.000Z" }),
    /UNIQUE/i
  );
  await insertJob("overdue-3", "todo_overdue", "pending", { refId: "todo-2", runAt: "2026-06-20T05:00:00.000Z" });
});

test("the lookup indexes exist and the user's jobs still cascade on delete", async () => {
  const names = (await turso.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notification_jobs'"))
    .rows.map((row) => String(row.name));
  for (const expected of [
    "uq_notification_jobs_ref",
    "uq_notification_jobs_digest",
    "uq_notification_jobs_occurrence",
    "uq_notification_jobs_slot",
    "idx_notification_jobs_due",
    "idx_notification_jobs_ref",
    "idx_notification_jobs_target",
  ]) {
    assert.ok(names.includes(expected), expected);
  }

  await turso.execute("DELETE FROM users WHERE id = 'u1'");
  const left = await turso.execute("SELECT COUNT(*) AS n FROM notification_jobs");
  assert.equal(Number((left.rows[0] as unknown as { n: number }).n), 0);
});

test("the per-minute backfill query for running checklists uses the new partial index", async () => {
  const plan = await turso.execute({
    sql: `EXPLAIN QUERY PLAN
          SELECT r.id FROM checklist_runs r
          WHERE r.status = 'in_progress' AND r.deleted_at IS NULL AND r.started_at >= ?
          ORDER BY r.started_at ASC, r.id ASC LIMIT ?`,
    args: ["2026-01-01T00:00:00.000Z", 200],
  });
  const details = plan.rows.map((row) => String(row.detail)).join(" | ");
  assert.match(details, /idx_checklist_runs_running/, details);
});

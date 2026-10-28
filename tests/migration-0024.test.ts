import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { before, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";

const { turso } = await import("../src/config/db.js");
const { parseStatements } = await import("./helpers/migrations.js");

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const MIGRATION = "0024_cancel_checklist_overdue.sql";

const apply = async (file: string): Promise<void> => {
  const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
  // One atomic batch per file, the way `npm run db:migrate` applies it.
  await turso.batch(parseStatements(sql), "write");
};

const insertJob = async (
  id: string,
  kind: string,
  status: string,
  runAt = "2026-06-20T03:00:00.000Z"
): Promise<void> => {
  await turso.execute({
    sql: `INSERT INTO notification_jobs
          (id, user_id, kind, ref_id, local_date, run_at, status, attempts, created_at)
          VALUES (?, 'u1', ?, 'ref-1', '2026-06-20', ?, ?, 0, '2026-06-01T00:00:00Z')`,
    args: [id, kind, runAt, status],
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
  await insertJob("ck-pending", "checklist_overdue", "pending", "2026-06-20T03:00:00.000Z");
  await insertJob("ck-pending-2", "checklist_overdue", "pending", "2026-06-20T05:00:00.000Z");
  await insertJob("ck-processing", "checklist_overdue", "processing", "2026-06-20T07:00:00.000Z");
  await insertJob("ck-sent", "checklist_overdue", "sent", "2026-06-19T03:00:00.000Z");
  await insertJob("ck-missed", "checklist_overdue", "missed", "2026-06-19T05:00:00.000Z");
  await insertJob("todo-overdue", "todo_overdue", "pending", "2026-06-20T03:00:00.000Z");
  await insertJob("ck-due", "checklist_due", "pending", "2026-06-21T00:30:00.000Z");
  await insertJob("ck-running", "checklist_running", "pending", "2026-06-20T06:15:00.000Z");

  await apply(MIGRATION);
});

test("pending and processing checklist_overdue jobs are cancelled", async () => {
  assert.equal(await statusOf("ck-pending"), "cancelled");
  assert.equal(await statusOf("ck-pending-2"), "cancelled");
  assert.equal(await statusOf("ck-processing"), "cancelled");
});

test("history is kept, and no other kind is touched", async () => {
  assert.equal(await statusOf("ck-sent"), "sent");
  assert.equal(await statusOf("ck-missed"), "missed");
  assert.equal(await statusOf("todo-overdue"), "pending", "todos still repeat");
  assert.equal(await statusOf("ck-due"), "pending", "the on-time checklist reminder stays");
  assert.equal(await statusOf("ck-running"), "pending", "the in-progress nudge stays");

  const count = await turso.execute("SELECT COUNT(*) AS n FROM notification_jobs");
  assert.equal(Number((count.rows[0] as unknown as { n: number }).n), 8, "no row was deleted");
});

test("the table still accepts the legacy kind, so old rows and a late deploy never break", async () => {
  await insertJob("late-insert", "checklist_overdue", "pending", "2026-06-22T03:00:00.000Z");
  assert.equal(await statusOf("late-insert"), "pending");
});

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { before, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";

const { turso } = await import("../src/config/db.js");
const { parseStatements } = await import("./helpers/migrations.js");

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const MIGRATION = "0023_checklist_occurrence_marks.sql";

const apply = async (file: string): Promise<void> => {
  const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
  // One atomic batch per file, the way `npm run db:migrate` applies it.
  await turso.batch(parseStatements(sql), "write");
};

const insertMark = (id: string, status: string, localDate = "2026-06-20", templateId = "tpl-1") =>
  turso.execute({
    sql: `INSERT INTO checklist_occurrence_marks
          (id, user_id, template_id, local_date, status, created_at, updated_at)
          VALUES (?, 'u1', ?, ?, ?, '2026-06-20T01:00:00Z', '2026-06-20T01:00:00Z')`,
    args: [id, templateId, localDate, status],
  });

const indexNames = async (table: string): Promise<string[]> =>
  (await turso.execute({ sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?", args: [table] }))
    .rows.map((row) => String(row.name));

const count = async (table: string): Promise<number> =>
  Number((await turso.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);

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
  await turso.execute(
    `INSERT INTO checklist_templates (id, user_id, title, is_system, times_used, sort_order, created_at, updated_at)
     VALUES ('tpl-1', 'u1', 'Rời nhà', 0, 0, 0, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`
  );
  await turso.execute(
    `INSERT INTO checklist_runs (id, template_id, user_id, status, started_at, completed_at, created_at, updated_at)
     VALUES ('run-1', 'tpl-1', 'u1', 'completed', '2026-06-19T16:30:00Z', '2026-06-19T17:30:00Z',
             '2026-06-19T16:30:00Z', '2026-06-19T17:30:00Z')`
  );

  await apply(MIGRATION);
});

test("existing runs are left exactly as they were", async () => {
  const run = (await turso.execute("SELECT * FROM checklist_runs WHERE id = 'run-1'")).rows[0];
  assert.equal(run.status, "completed");
  assert.equal(run.started_at, "2026-06-19T16:30:00Z");
  assert.equal(run.completed_at, "2026-06-19T17:30:00Z");
});

test("the table starts empty and accepts the two statuses, rejecting anything else", async () => {
  assert.equal(await count("checklist_occurrence_marks"), 0);
  await insertMark("m-done", "done", "2026-06-20");
  await insertMark("m-open", "open", "2026-06-21");
  await assert.rejects(() => insertMark("m-bad", "maybe", "2026-06-22"), /CHECK/i);
  await assert.rejects(() => insertMark("m-null", null as never, "2026-06-23"), /NOT NULL|CHECK/i);
});

test("one mark per user, checklist and day - even when the old row is soft-deleted", async () => {
  await assert.rejects(() => insertMark("m-dup", "open", "2026-06-20"), /UNIQUE/i);
  await turso.execute("UPDATE checklist_occurrence_marks SET deleted_at = '2026-06-21T00:00:00Z' WHERE id = 'm-done'");
  await assert.rejects(() => insertMark("m-dup", "open", "2026-06-20"), /UNIQUE/i, "the tombstone is revived, not duplicated");
});

test("the run lookup is indexed by start time and the unused completion index is gone", async () => {
  const runIndexes = await indexNames("checklist_runs");
  assert.ok(runIndexes.includes("idx_checklist_runs_user_started"));
  assert.ok(!runIndexes.includes("idx_checklist_runs_user_completed"));
  assert.ok(runIndexes.includes("idx_checklist_runs_running"), "the 0020 index is untouched");
  assert.ok((await indexNames("checklist_occurrence_marks")).includes("idx_checklist_occurrence_marks_sync"));
});

test("the planner's run query uses the new index", async () => {
  const plan = await turso.execute({
    sql: `EXPLAIN QUERY PLAN
          SELECT user_id, template_id, started_at, completed_at FROM checklist_runs
          WHERE status = 'completed' AND deleted_at IS NULL
            AND started_at >= ? AND started_at < ? AND user_id IN (?)`,
    args: ["2026-06-20T00:00:00Z", "2026-06-21T00:00:00Z", "u1"],
  });
  assert.ok(
    plan.rows.some((row) => String(row.detail).includes("idx_checklist_runs_user_started")),
    plan.rows.map((row) => String(row.detail)).join(" | ")
  );
});

test("marks go away with their checklist and with their user", async () => {
  await insertMark("m-tpl", "done", "2026-07-01");
  await turso.execute("DELETE FROM checklist_templates WHERE id = 'tpl-1'");
  assert.equal(await count("checklist_occurrence_marks"), 0);

  await turso.execute(
    `INSERT INTO checklist_templates (id, user_id, title, is_system, times_used, sort_order, created_at, updated_at)
     VALUES ('tpl-2', 'u1', 'Đi ngủ', 0, 0, 0, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`
  );
  await insertMark("m-user", "open", "2026-07-02", "tpl-2");
  await turso.execute("DELETE FROM users WHERE id = 'u1'");
  assert.equal(await count("checklist_occurrence_marks"), 0);
});

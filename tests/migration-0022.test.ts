import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { before, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";

const { turso } = await import("../src/config/db.js");
const { parseStatements } = await import("./helpers/migrations.js");

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const MIGRATION = "0022_overdue_digests.sql";

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
  // Repeat nudges of todo-a: the 12:00 one is already sent, so the rest of that day is left alone.
  await insertJob("a-12", "todo_overdue", "sent", { refId: "todo-a", runAt: "2026-06-20T05:00:00.000Z", localDate: "2026-06-20" });
  await insertJob("a-14", "todo_overdue", "pending", { refId: "todo-a", runAt: "2026-06-20T07:00:00.000Z", localDate: "2026-06-20" });
  // todo-b has only pending nudges: they are rebuilt by the server's backfill with the new cadence.
  await insertJob("b-12", "todo_overdue", "pending", { refId: "todo-b", runAt: "2026-06-20T05:00:00.000Z", localDate: "2026-06-20" });
  await insertJob("b-14", "todo_overdue", "pending", { refId: "todo-b", runAt: "2026-06-20T07:00:00.000Z", localDate: "2026-06-20" });
  // The same todo on another day, and another user's todo, are independent.
  await insertJob("b-next", "todo_overdue", "pending", { refId: "todo-b", runAt: "2026-06-21T05:00:00.000Z", localDate: "2026-06-21" });
  // Everything else is untouched.
  await insertJob("reminder", "todo_reminder", "pending", { refId: "todo-1" });
  await insertJob("digest", "digest_review", "pending", { localDate: "2026-06-20" });
  await insertJob("checklist-slot", "checklist_overdue", "pending", { refId: "tpl-1", runAt: "2026-06-20T03:00:00.000Z", localDate: "2026-06-20" });
  await insertJob("running", "checklist_running", "pending", { refId: "run-1", runAt: "2026-06-20T04:00:00.000Z", localDate: "2026-06-20" });
  await insertJob("done-sent", "todo_overdue", "missed", { refId: "todo-c", runAt: "2026-06-20T05:00:00.000Z", localDate: "2026-06-20" });

  await apply(MIGRATION);
});

test("pending repeat nudges are cleared for the backfill, except for todos that already had one sent that day", async () => {
  assert.equal(await statusOf("a-12"), "sent");
  assert.equal(await statusOf("a-14"), "pending", "left alone: the tick drops it before sending if it no longer applies");
  assert.equal(await statusOf("b-12"), null);
  assert.equal(await statusOf("b-14"), null);
  assert.equal(await statusOf("b-next"), null, "another day of the same todo, with nothing sent that day");
  assert.equal(await statusOf("done-sent"), "missed", "history is kept");
});

test("every other job survives the rebuild exactly as it was", async () => {
  assert.equal(await statusOf("reminder"), "pending");
  assert.equal(await statusOf("digest"), "pending");
  assert.equal(await statusOf("checklist-slot"), "pending");
  assert.equal(await statusOf("running"), "pending");
});

test("the table accepts both overdue digests and still rejects unknown kinds", async () => {
  await insertJob("evening", "digest_overdue_evening", "pending", { localDate: "2026-06-20" });
  await insertJob("morning", "digest_overdue_morning", "pending", { localDate: "2026-06-20" });
  assert.equal(await statusOf("evening"), "pending");
  assert.equal(await statusOf("morning"), "pending");

  await assert.rejects(() => insertJob("bad", "digest_overdue", "pending", { localDate: "2026-06-20" }), /CHECK/i);
});

test("one overdue digest per user, kind and day", async () => {
  await assert.rejects(
    () => insertJob("evening-2", "digest_overdue_evening", "pending", { localDate: "2026-06-20" }),
    /UNIQUE/i
  );
  await insertJob("evening-next", "digest_overdue_evening", "pending", { localDate: "2026-06-21" });
  // The evening and morning digests of the same day are different kinds.
  await assert.rejects(() => insertJob("review-2", "digest_review", "pending", { localDate: "2026-06-20" }), /UNIQUE/i);
});

test("the indexes from migrations 0016-0020 are all still there and still unique", async () => {
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

  await assert.rejects(() => insertJob("reminder-2", "todo_reminder", "pending", { refId: "todo-1" }), /UNIQUE/i);
  await assert.rejects(
    () => insertJob("running-dup", "checklist_running", "pending", { refId: "run-1", runAt: "2026-06-20T04:00:00.000Z" }),
    /UNIQUE/i
  );
  await insertJob("running-2", "checklist_running", "pending", { refId: "run-1", runAt: "2026-06-20T05:00:00.000Z" });
});

test("the user's jobs still cascade on delete", async () => {
  await turso.execute("DELETE FROM users WHERE id = 'u1'");
  const left = await turso.execute("SELECT COUNT(*) AS n FROM notification_jobs");
  assert.equal(Number((left.rows[0] as unknown as { n: number }).n), 0);
});

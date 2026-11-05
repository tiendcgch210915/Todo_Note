import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { before, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";

const { turso } = await import("../src/config/db.js");
const { parseStatements } = await import("./helpers/migrations.js");

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const MIGRATION = "0027_todo_reminder_repeat.sql";

const insertJob = async (
  id: string,
  kind: string,
  runAt: string,
  cardKey: string | null = null
): Promise<void> => {
  await turso.execute({
    sql: `INSERT INTO notification_jobs
          (id, user_id, kind, ref_id, local_date, run_at, status, attempts, created_at, card_key)
          VALUES (?, 'u1', ?, 'ref-1', '2026-06-20', ?, 'sent', 1, '2026-06-01T00:00:00Z', ?)`,
    args: [id, kind, runAt, cardKey],
  });
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
  await insertJob("reminder", "todo_reminder", "2026-06-20T03:00:00.000Z", "2026-06-20T10:00");
  await insertJob("overdue", "todo_overdue", "2026-06-20T05:00:00.000Z", "2026-06-20T10:00");
  await insertJob("digest", "digest_morning", "2026-06-20T00:00:00.000Z");

  const sql = await readFile(join(MIGRATIONS_DIR, MIGRATION), "utf-8");
  // One atomic batch per file, the way `npm run db:migrate` applies it.
  await turso.batch(parseStatements(sql), "write");
});

test("existing jobs survive the rebuild, including the card_key of delivered cards", async () => {
  const res = await turso.execute("SELECT id, kind, status, attempts, card_key FROM notification_jobs ORDER BY id");
  assert.deepEqual(
    res.rows.map((r) => ({ ...r })),
    [
      { id: "digest", kind: "digest_morning", status: "sent", attempts: 1, card_key: null },
      { id: "overdue", kind: "todo_overdue", status: "sent", attempts: 1, card_key: "2026-06-20T10:00" },
      { id: "reminder", kind: "todo_reminder", status: "sent", attempts: 1, card_key: "2026-06-20T10:00" },
    ]
  );
});

test("the new kind is accepted and is unique per slot (user, kind, ref_id, run_at)", async () => {
  await insertJob("repeat-1", "todo_reminder_repeat", "2026-06-20T03:02:00.000Z");
  await insertJob("repeat-2", "todo_reminder_repeat", "2026-06-20T03:04:00.000Z");
  await assert.rejects(
    () => insertJob("repeat-dup", "todo_reminder_repeat", "2026-06-20T03:02:00.000Z"),
    /UNIQUE/i
  );
});

test("an unknown kind is still rejected, and the other indexes are back", async () => {
  await assert.rejects(() => insertJob("bad", "todo_something_else", "2026-06-20T03:00:00.000Z"), /CHECK/i);

  const res = await turso.execute("PRAGMA index_list('notification_jobs')");
  const names = res.rows.map((r) => String((r as unknown as { name: string }).name));
  for (const name of [
    "uq_notification_jobs_ref",
    "uq_notification_jobs_digest",
    "uq_notification_jobs_occurrence",
    "uq_notification_jobs_slot",
    "idx_notification_jobs_due",
    "idx_notification_jobs_ref",
    "idx_notification_jobs_target",
  ]) {
    assert.ok(names.includes(name), name);
  }
});

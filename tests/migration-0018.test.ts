import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { before, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";

const { turso } = await import("../src/config/db.js");
const { parseStatements } = await import("./helpers/migrations.js");

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const MIGRATION = "0018_overdue_nudges_and_review.sql";

const apply = async (file: string): Promise<void> => {
  const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
  // One atomic batch per file, the way `npm run db:migrate` applies it.
  await turso.batch(parseStatements(sql), "write");
};

const OLD_KINDS = [
  "todo_reminder",
  "todo_timer_end",
  "checklist_30m",
  "checklist_due",
  "digest_morning",
  "digest_todos",
  "digest_habits",
];

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
    `INSERT INTO notification_settings (user_id, morning_time, evening_time, created_at, updated_at)
     VALUES ('u1', '06:30', '18:00', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`
  );
  for (const [i, kind] of OLD_KINDS.entries()) {
    const digest = kind.startsWith("digest_");
    await turso.execute({
      sql: `INSERT INTO notification_jobs
            (id, user_id, kind, ref_id, local_date, run_at, status, attempts, created_at)
            VALUES (?, 'u1', ?, ?, ?, ?, ?, ?, '2026-06-01T00:00:00Z')`,
      args: [`job-${i}`, kind, digest ? null : `ref-${i}`, "2026-06-20", "2026-06-20T01:00:00.000Z", i % 2 === 0 ? "sent" : "pending", i],
    });
  }

  await apply(MIGRATION);
});

test("existing notification settings keep their times and gain the 21:30 review time", async () => {
  const res = await turso.execute("SELECT morning_time, evening_time, review_time FROM notification_settings WHERE user_id = 'u1'");
  assert.deepEqual({ ...(res.rows[0] as object) }, { morning_time: "06:30", evening_time: "18:00", review_time: "21:30" });

  await turso.execute(
    `INSERT INTO users (id, email, password_hash, timezone, is_admin, created_at, updated_at)
     VALUES ('u2', 'u2@test.local', 'x', 'Asia/Ho_Chi_Minh', 0, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`
  );
  await turso.execute(
    `INSERT INTO notification_settings (user_id, created_at, updated_at) VALUES ('u2', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`
  );
  const fresh = await turso.execute("SELECT review_time FROM notification_settings WHERE user_id = 'u2'");
  assert.equal((fresh.rows[0] as unknown as { review_time: string }).review_time, "21:30", "column default");
});

test("rebuilding notification_jobs keeps every existing job exactly as it was", async () => {
  const res = await turso.execute(
    "SELECT id, kind, ref_id, local_date, run_at, status, attempts FROM notification_jobs ORDER BY id"
  );
  assert.equal(res.rows.length, OLD_KINDS.length);
  for (const [i, kind] of OLD_KINDS.entries()) {
    const row = res.rows.find((r) => r.id === `job-${i}`) as unknown as Record<string, unknown>;
    assert.equal(row.kind, kind);
    assert.equal(row.status, i % 2 === 0 ? "sent" : "pending");
    assert.equal(Number(row.attempts), i);
    assert.equal(row.run_at, "2026-06-20T01:00:00.000Z");
  }
});

test("the table now accepts the three new kinds and still rejects unknown ones", async () => {
  for (const kind of ["todo_overdue", "checklist_overdue", "digest_review"]) {
    await turso.execute({
      sql: `INSERT INTO notification_jobs (id, user_id, kind, ref_id, local_date, run_at, status, attempts, created_at)
            VALUES (?, 'u1', ?, 'r', '2026-06-21', '2026-06-21T01:00:00.000Z', 'pending', 0, '2026-06-01T00:00:00Z')`,
      args: [`new-${kind}`, kind],
    });
  }
  await assert.rejects(
    turso.execute(
      `INSERT INTO notification_jobs (id, user_id, kind, run_at, status, attempts, created_at)
       VALUES ('bad', 'u1', 'made_up', '2026-06-21T01:00:00.000Z', 'pending', 0, '2026-06-01T00:00:00Z')`
    ),
    /CHECK/
  );
});

test("unique indexes: one review per user and day, one nudge per slot, many slots per todo", async () => {
  const insert = (id: string, kind: string, ref: string | null, date: string, runAt: string) =>
    turso.execute({
      sql: `INSERT INTO notification_jobs (id, user_id, kind, ref_id, local_date, run_at, status, attempts, created_at)
            VALUES (?, 'u1', ?, ?, ?, ?, 'pending', 0, '2026-06-01T00:00:00Z')`,
      args: [id, kind, ref, date, runAt],
    });

  // digest_review joined the per-day digest index (digest_review 2026-06-21 already exists above)
  await assert.rejects(insert("dup-review", "digest_review", null, "2026-06-21", "2026-06-21T14:30:00.000Z"), /UNIQUE/);
  await insert("review-next-day", "digest_review", null, "2026-06-22", "2026-06-22T14:30:00.000Z");

  // several slots of one todo on the same day are fine, the same slot twice is not
  await insert("slot-1", "todo_overdue", "todo-x", "2026-06-22", "2026-06-22T05:00:00.000Z");
  await insert("slot-2", "todo_overdue", "todo-x", "2026-06-22", "2026-06-22T07:00:00.000Z");
  await assert.rejects(insert("slot-dup", "todo_overdue", "todo-x", "2026-06-22", "2026-06-22T05:00:00.000Z"), /UNIQUE/);
  await insert("slot-ck", "checklist_overdue", "todo-x", "2026-06-22", "2026-06-22T05:00:00.000Z");

  // the older indexes survived the rebuild
  await assert.rejects(insert("dup-digest", "digest_morning", null, "2026-06-20", "2026-06-20T01:00:00.000Z"), /UNIQUE/);
  await assert.rejects(insert("dup-event", "todo_reminder", "ref-0", "2026-06-20", "2026-06-20T02:00:00.000Z"), /UNIQUE/);
  await assert.rejects(insert("dup-due", "checklist_due", "ref-3", "2026-06-20", "2026-06-20T02:00:00.000Z"), /UNIQUE/);
});

test("the lookup indexes were recreated", async () => {
  const res = await turso.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notification_jobs'");
  const names = new Set(res.rows.map((row) => String(row.name)));
  for (const name of [
    "uq_notification_jobs_ref",
    "uq_notification_jobs_digest",
    "uq_notification_jobs_occurrence",
    "uq_notification_jobs_slot",
    "idx_notification_jobs_due",
    "idx_notification_jobs_ref",
    "idx_notification_jobs_target",
  ]) {
    assert.ok(names.has(name), name);
  }
});

test("the user's jobs still cascade when the user is deleted", async () => {
  await turso.execute("PRAGMA foreign_keys = ON");
  await turso.execute(
    `INSERT INTO users (id, email, password_hash, timezone, is_admin, created_at, updated_at)
     VALUES ('u3', 'u3@test.local', 'x', 'Asia/Ho_Chi_Minh', 0, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`
  );
  await turso.execute(
    `INSERT INTO notification_jobs (id, user_id, kind, run_at, status, attempts, created_at)
     VALUES ('cascade-1', 'u3', 'digest_review', '2026-06-21T14:30:00.000Z', 'pending', 0, '2026-06-01T00:00:00Z')`
  );
  await turso.execute("DELETE FROM users WHERE id = 'u3'");
  const left = await turso.execute("SELECT COUNT(*) AS c FROM notification_jobs WHERE id = 'cascade-1'");
  assert.equal(Number((left.rows[0] as unknown as { c: number }).c), 0);
});

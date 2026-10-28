/**
 * verify-sync-payload.ts
 * Run: npx tsx src/scripts/verify-sync-payload.ts
 *
 * Creates a test user with a full checklist run + habit logs, then
 * calls GET /sync/changes and validates every field in every entity
 * against the API_CONTRACT §3.5–§3.8 spec.
 */
import { turso } from "../config/db.js";
import { newId } from "../utils/id.js";
import { nowISO } from "../utils/time.js";

// ── NOT-NULL field map per entity type ────────────────────────────────────────
// Fields that are NOT NULL in DB schema → must be non-null in sync payload.
// (Nullable fields like deleted_at, completed_at, note, description are OK null.)
const NOT_NULL: Record<string, string[]> = {
  users: ["id", "email", "timezone", "created_at", "updated_at"],
  tags: ["id", "user_id", "name", "color", "created_at", "updated_at"],
  todos: ["id", "user_id", "title", "status", "position", "created_at", "updated_at"],
  notes: [
    "id",
    "user_id",
    "title",
    "type",
    "content_format",
    "created_at",
    "updated_at",
  ],
  habits: ["id", "user_id", "title", "frequency_type", "target_per_period", "start_date", "checklist_template_id", "created_at", "updated_at"],
  habit_logs: ["id", "habit_id", "log_date", "created_at", "updated_at"],
  checklist_categories: ["id", "user_id", "name", "slug", "color", "sort_order", "created_at", "updated_at"],
  checklist_templates: ["id", "user_id", "title", "sort_order", "created_at", "updated_at"],
  checklist_template_orders: ["id", "user_id", "template_id", "sort_order", "created_at", "updated_at"],
  checklist_template_items: ["id", "template_id", "position", "title", "created_at", "updated_at"],
  checklist_runs: ["id", "template_id", "user_id", "status", "started_at", "created_at", "updated_at"],
  checklist_run_items: ["id", "run_id", "template_item_id", "status", "created_at", "updated_at"],
  checklist_schedules: ["id", "user_id", "template_id", "start_date", "time", "enabled", "created_at", "updated_at"],
  checklist_schedule_overrides: ["id", "user_id", "template_id", "local_date", "time", "created_at", "updated_at"],
  checklist_occurrence_marks: ["id", "user_id", "template_id", "local_date", "status", "created_at", "updated_at"],
};

// ── REQUIRED KEYS per entity type (must be present even if null) ─────────────
const REQUIRED_KEYS: Record<string, string[]> = {
  todos: ["id", "habit_id", "time", "tag_ids", "linked_note_ids"],
  notes: [
    "id",
    "body",
    "body_delta",
    "cornell_cue",
    "cornell_cue_delta",
    "cornell_summary",
    "cornell_summary_delta",
    "content_format",
    "tag_ids",
    "note_links",
    "linked_todo_ids",
  ],
  habit_logs: ["id", "habit_id", "log_date", "completed", "note", "created_at", "updated_at", "deleted_at"],
  checklist_template_orders: ["id", "user_id", "template_id", "sort_order", "created_at", "updated_at", "deleted_at"],
  checklist_template_items: ["id", "template_id", "position", "title", "description", "is_required", "created_at", "updated_at", "deleted_at"],
  checklist_runs: ["id", "template_id", "user_id", "name", "status", "started_at", "completed_at", "duration_ms", "created_at", "updated_at", "deleted_at"],
  checklist_run_items: ["id", "run_id", "template_item_id", "status", "completed_at", "note", "created_at", "updated_at", "deleted_at"],
  checklist_schedules: [
    "id", "user_id", "template_id", "start_date", "time", "recurrence_type", "recurrence_interval",
    "recurrence_days_of_week", "recurrence_end_date", "enabled", "paused_from", "paused_until",
    "created_at", "updated_at", "deleted_at",
  ],
  checklist_schedule_overrides: ["id", "user_id", "template_id", "local_date", "time", "created_at", "updated_at", "deleted_at"],
  checklist_occurrence_marks: ["id", "user_id", "template_id", "local_date", "status", "created_at", "updated_at", "deleted_at"],
};

async function createTestData(userId: string): Promise<void> {
  const now = nowISO();

  await turso.execute({
    sql: `INSERT INTO notes
          (id, user_id, title, type, body, body_delta, cornell_cue,
           cornell_cue_delta, cornell_summary, cornell_summary_delta,
           content_format, is_pinned, created_at, updated_at)
          VALUES (?, ?, 'Verify Cornell note', 'cornell', ?, ?, ?, ?, ?, ?,
                  'quill_delta_v1', 0, ?, ?)`,
    args: [
      newId(),
      userId,
      "Structured notes column",
      JSON.stringify({
        ops: [
          { insert: "Structured", attributes: { bold: true } },
          { insert: " notes column\n" },
        ],
      }),
      "Key cue",
      JSON.stringify({
        ops: [{ insert: "Key cue", attributes: { underline: true } }, { insert: "\n" }],
      }),
      "Short summary",
      JSON.stringify({
        ops: [{ insert: "Short summary\n", attributes: { italic: true } }],
      }),
      now,
      now,
    ],
  });

  // Create a habit + 2 logs
  const habitId = newId();
  await turso.execute({
    sql: `INSERT INTO habits (id, user_id, title, description, icon, color, frequency_type,
          target_per_period, active_weekdays, start_date, end_date, current_streak,
          longest_streak, is_archived, created_at, updated_at)
          VALUES (?,?,?,NULL,NULL,'#4CAF50','daily',1,NULL,'2026-01-01',NULL,0,0,0,?,?)`,
    args: [habitId, userId, "Morning workout", now, now],
  });
  for (const date of ["2026-05-20", "2026-05-21"]) {
    await turso.execute({
      sql: `INSERT INTO habit_logs (id, habit_id, log_date, completed, note, created_at, updated_at)
            VALUES (?,?,?,1,NULL,?,?)`,
      args: [newId(), habitId, date, now, now],
    });
  }
  await turso.execute({
    sql: `INSERT INTO todos
          (id, user_id, title, status, position, is_frog, scheduled_date, time,
           habit_id, created_at, updated_at)
          VALUES (?,?,?,'open',0,0,'2026-05-20','08:30',?,?,?)`,
    args: [newId(), userId, "Verify linked habit todo", habitId, now, now],
  });

  // Create a checklist template + 2 items + 1 run (with items)
  const tplId = newId();
  const orderId = newId();
  await turso.execute({
    sql: `INSERT INTO checklist_templates (id, user_id, title, description, icon, category,
          sort_order, is_system, times_used, last_used_at, created_at, updated_at)
          VALUES (?,?,?,NULL,NULL,NULL,1,0,0,NULL,?,?)`,
    args: [tplId, userId, "Verify template", now, now],
  });
  await turso.execute({
    sql: `INSERT INTO checklist_template_orders
          (id, user_id, template_id, sort_order, created_at, updated_at)
          VALUES (?,?,?,?,?,?)`,
    args: [orderId, userId, tplId, 1, now, now],
  });
  await turso.batch([
    {
      sql: `INSERT INTO checklist_schedules
            (id, user_id, template_id, start_date, time, recurrence_type, recurrence_interval,
             recurrence_days_of_week, recurrence_end_date, enabled, created_at, updated_at)
            VALUES (?,?,?,?,?,'weekly',1,'1,3,5',NULL,1,?,?)`,
      args: [newId(), userId, tplId, now.slice(0, 10), "07:30", now, now],
    },
    {
      sql: `INSERT INTO checklist_schedule_overrides
            (id, user_id, template_id, local_date, time, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?)`,
      args: [newId(), userId, tplId, now.slice(0, 10), "08:15", now, now],
    },
    {
      sql: `INSERT INTO checklist_occurrence_marks
            (id, user_id, template_id, local_date, status, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?)`,
      args: [newId(), userId, tplId, now.slice(0, 10), "open", now, now],
    },
  ], "write");
  const item1 = newId(); const item2 = newId();
  await turso.batch([
    {
      sql: `INSERT INTO checklist_template_items (id, template_id, position, title, description, is_required, created_at, updated_at)
            VALUES (?,?,1,'Step A',NULL,1,?,?)`,
      args: [item1, tplId, now, now],
    },
    {
      sql: `INSERT INTO checklist_template_items (id, template_id, position, title, description, is_required, created_at, updated_at)
            VALUES (?,?,2,'Step B','optional note',0,?,?)`,
      args: [item2, tplId, now, now],
    },
  ], "write");

  const runId = newId();
  await turso.batch([
    {
      sql: `INSERT INTO checklist_runs (id, template_id, user_id, name, status, started_at, completed_at, duration_ms, created_at, updated_at)
            VALUES (?,?,?,NULL,'in_progress',?,NULL,90000,?,?)`,
      args: [runId, tplId, userId, now, now, now],
    },
    {
      sql: `INSERT INTO checklist_run_items (id, run_id, template_item_id, status, completed_at, note, created_at, updated_at)
            VALUES (?,?,?,'pending',NULL,NULL,?,?)`,
      args: [newId(), runId, item1, now, now],
    },
    {
      sql: `INSERT INTO checklist_run_items (id, run_id, template_item_id, status, completed_at, note, created_at, updated_at)
            VALUES (?,?,?,'done',?,NULL,?,?)`,
      args: [newId(), runId, item2, now, now, now],
    },
  ], "write");
}

async function validateEntity(
  entityType: string,
  entity: Record<string, unknown>,
  idx: number
): Promise<string[]> {
  const errors: string[] = [];
  const prefix = `${entityType}[${idx}]`;

  // Check required keys present
  const requiredKeys = REQUIRED_KEYS[entityType];
  if (requiredKeys) {
    for (const key of requiredKeys) {
      if (!(key in entity)) {
        errors.push(`${prefix} MISSING KEY: "${key}"`);
      }
    }
  }

  // Check NOT NULL fields
  const notNullFields = NOT_NULL[entityType] ?? [];
  for (const field of notNullFields) {
    if (entity[field] === null || entity[field] === undefined) {
      errors.push(`${prefix}.${field} = ${JSON.stringify(entity[field])} (should be non-null)`);
    }
  }

  return errors;
}

async function main() {
  console.log("=== SYNC PAYLOAD VERIFICATION ===\n");

  // Create a fresh test user
  const userId = newId();
  const email = `verify-payload-${Date.now()}@test.local`;
  await turso.execute({
    sql: `INSERT INTO users (id, email, password_hash, display_name, timezone, is_admin, created_at, updated_at)
          VALUES (?,?,?,NULL,'Asia/Ho_Chi_Minh',0,?,?)`,
    args: [userId, email, "test-hash", nowISO(), nowISO()],
  });

  await createTestData(userId);
  console.log(`Test user: ${email} (${userId})\n`);

  // Call GET /sync/changes via the repository directly
  const { getChangesSince } = await import("../repositories/sync.repo.js");
  const changes = await getChangesSince(userId, null); // initial sync

  let totalErrors = 0;
  const allEntityTypes = Object.keys(changes) as (keyof typeof changes)[];

  for (const entityType of allEntityTypes) {
    const entities = changes[entityType] as Record<string, unknown>[];
    if (entities.length === 0) {
      console.log(`${entityType}: (empty)`);
      continue;
    }

    const errors: string[] = [];
    for (let i = 0; i < entities.length; i++) {
      const errs = await validateEntity(entityType, entities[i], i);
      errors.push(...errs);
    }

    if (errors.length > 0) {
      console.log(`${entityType}: ${entities.length} entities — ❌ ${errors.length} ERRORS`);
      errors.forEach((e) => console.log("  ⚠️ ", e));
      totalErrors += errors.length;
    } else {
      console.log(`${entityType}: ${entities.length} entities — ✅ OK`);
    }

    // Print first entity as sample
    const sample = entities[0];
    console.log("  Sample:", JSON.stringify(sample, null, 2).split("\n").join("\n  "));
  }

  // ── Special: print raw checklist_run_item for easy copy-paste ───────────────
  console.log("\n=== RAW checklist_run_item (first) ===");
  const items = changes.checklist_run_items as Record<string, unknown>[];
  if (items.length > 0) {
    console.log(JSON.stringify(items[0], null, 2));
  } else {
    console.log("(none)");
  }

  // ── Cleanup test user ────────────────────────────────────────────────────────
  await turso.execute({ sql: "DELETE FROM users WHERE id = ?", args: [userId] });
  console.log("\n[test user cleaned up]");

  if (totalErrors === 0) {
    console.log("\n✅ All entities pass — no missing keys, no unexpected nulls.");
  } else {
    console.log(`\n❌ TOTAL ISSUES FOUND: ${totalErrors}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

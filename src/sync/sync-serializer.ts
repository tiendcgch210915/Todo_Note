/**
 * sync-serializer.ts
 *
 * Pure functions (no DB access) cho sync layer:
 *  - toSyncEntity: DB row → sync payload (0/1→true/false, embed associations)
 *  - fromSyncEntity: sync payload → DB input (true/false→0/1, strip server-only fields)
 *
 * Contract §3.1 & §5.3
 */

// ── Entity type union ───────────────────────────────────────────────────────

export type EntityType =
  | "todo"
  | "note"
  | "tag"
  | "habit"
  | "habit_log"
  | "checklist_category"
  | "checklist_template"
  | "checklist_template_order"
  | "checklist_template_item"
  | "checklist_run"
  | "checklist_run_item"
  | "checklist_schedule"
  | "checklist_schedule_override"
  | "user";

// ── Association bundles (pre-fetched in bulk by sync.repo) ──────────────────

export type TodoAssoc = {
  tag_ids: string[];
  linked_note_ids: string[];
};

export type NoteAssoc = {
  tag_ids: string[];
  /** outgoing links (§7.1: only targets with deleted_at IS NULL) */
  note_links: { target_note_id: string; label: string | null }[];
  linked_todo_ids: string[];
};

// ── Sync entity TypeScript shapes (documentation + type-checking) ───────────

export type SyncTodo = {
  id: string;
  user_id: string;
  parent_id: string | null;
  title: string;
  description: string | null;
  status: "open" | "in_progress" | "done" | "archived";
  position: number;
  is_frog: boolean;
  frog_date: string | null;
  is_important: boolean | null;
  is_urgent: boolean | null;
  estimated_minutes: number | null;
  actual_minutes: number | null;
  start_at: string | null;
  due_at: string | null;
  scheduled_date: string | null;
  time: string | null;
  trigger_after_todo_id: string | null;
  habit_id: string | null;
  completed_at: string | null;
  // Recurrence fields (migration 0006)
  recurrence_type: "daily" | "weekly" | "custom" | null;
  recurrence_interval: number | null;
  recurrence_days_of_week: string | null;
  recurrence_end_date: string | null;
  recurrence_template_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // embedded junctions
  tag_ids: string[];
  linked_note_ids: string[];
};

export type SyncNote = {
  id: string;
  user_id: string;
  title: string;
  type: "free" | "cornell";
  body: string | null;
  body_delta: QuillDelta | null;
  cornell_cue: string | null;
  cornell_cue_delta: QuillDelta | null;
  cornell_summary: string | null;
  cornell_summary_delta: QuillDelta | null;
  content_format: "plain" | "quill_delta_v1";
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // embedded junctions
  tag_ids: string[];
  note_links: { target_note_id: string; label: string | null }[];
  linked_todo_ids: string[];
};

export type SyncTag = {
  id: string;
  user_id: string;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type SyncHabit = {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  icon: string | null;
  color: string;
  frequency_type: "daily" | "weekly" | "custom";
  target_per_period: number;
  active_weekdays: string | null;
  start_date: string;
  end_date: string | null;
  /**
   * Checklist template whose completed runs auto-tick this habit (the user's own or a
   * system template). On push: field absent keeps the stored link, `null` clears it,
   * an unknown/foreign/deleted template is rejected with op error `invalid_checklist`.
   * The server clears it (and bumps `updated_at`) when the template is deleted.
   */
  checklist_template_id: string | null;
  /** server-only: read-only on pull, STRIPPED on push */
  current_streak: number;
  /** server-only: read-only on pull, STRIPPED on push */
  longest_streak: number;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type SyncHabitLog = {
  id: string;
  habit_id: string;
  log_date: string;
  completed: boolean;
  note: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type SyncChecklistCategory = {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  icon: string | null;
  color: string;
  sort_order: number;
  /** server-only: STRIPPED on push */
  is_system: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type SyncChecklistTemplate = {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  category_id: string | null;
  sort_order: number;
  /** server-only: STRIPPED on push */
  is_system: boolean;
  /** server-only: STRIPPED on push */
  times_used: number;
  /** server-only: STRIPPED on push */
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type SyncChecklistTemplateOrder = {
  id: string;
  user_id: string;
  template_id: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type SyncChecklistTemplateItem = {
  id: string;
  template_id: string;
  position: number;
  title: string;
  description: string | null;
  is_required: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type SyncChecklistRun = {
  id: string;
  template_id: string;
  user_id: string;
  name: string | null;
  status: "in_progress" | "completed" | "abandoned";
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type SyncChecklistRunItem = {
  id: string;
  run_id: string;
  template_item_id: string;
  status: "pending" | "done" | "skipped";
  completed_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/** Lịch lặp của một checklist cho một người dùng; tên trường lặp giống hệt todo. */
export type SyncChecklistSchedule = {
  id: string;
  user_id: string;
  template_id: string;
  start_date: string;
  time: string;
  recurrence_type: "daily" | "weekly" | "custom" | null;
  recurrence_interval: number | null;
  recurrence_days_of_week: string | null;
  recurrence_end_date: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/** Đổi giờ của MỘT ngày trong lịch. */
export type SyncChecklistScheduleOverride = {
  id: string;
  user_id: string;
  template_id: string;
  local_date: string;
  time: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type SyncUser = {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  timezone: string;
  settings: string | null;
  /** server-only: STRIPPED on push */
  is_admin: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

// ── Utilities ───────────────────────────────────────────────────────────────

import { nowISO } from "../utils/time.js";
import {
  parseStoredQuillDelta,
  serializeQuillDelta,
  type QuillDelta,
} from "../schemas/quill-delta.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** SQLite INTEGER 0/1 → boolean */
const toBool = (v: unknown): boolean => v === 1 || v === true;

/** SQLite INTEGER 0/1/NULL → boolean | null */
const toBoolNullable = (v: unknown): boolean | null => {
  if (v === null || v === undefined) return null;
  return v === 1 || v === true;
};

/** boolean → SQLite INTEGER 0/1 */
const fromBool = (v: unknown): number => (v === true || v === 1) ? 1 : 0;

/** boolean/null → SQLite INTEGER 0/1/null */
const fromBoolNullable = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  return (v === true || v === 1) ? 1 : 0;
};

// ── Server-only fields (stripped on fromSyncEntity push) ────────────────────

const SERVER_ONLY: Partial<Record<EntityType, string[]>> = {
  habit: ["current_streak", "longest_streak"],
  // auto_closed: provenance flag of the midnight job, never set or shown by clients
  habit_log: ["auto_closed"],
  checklist_category: ["is_system"],
  checklist_template: ["times_used", "last_used_at", "is_system"],
  user: ["email", "password_hash", "is_admin"],
};

// ── toSyncEntity: DB row → sync payload ─────────────────────────────────────

/**
 * Convert a raw DB row to a sync entity payload:
 *  - integer booleans → true/false
 *  - embed associations for todo/note (caller must supply `assoc`)
 *  - strip password_hash from user
 */
export function toSyncEntity(
  row: Record<string, unknown>,
  type: EntityType,
  assoc?: TodoAssoc | NoteAssoc
): Record<string, unknown> {
  switch (type) {
    case "todo": {
      const a = (assoc as TodoAssoc | undefined) ?? { tag_ids: [], linked_note_ids: [] };
      return {
        ...row,
        is_frog: toBool(row.is_frog),
        is_important: toBoolNullable(row.is_important),
        is_urgent: toBoolNullable(row.is_urgent),
        tag_ids: a.tag_ids,
        linked_note_ids: a.linked_note_ids,
      };
    }

    case "note": {
      const a = (assoc as NoteAssoc | undefined) ?? {
        tag_ids: [],
        note_links: [],
        linked_todo_ids: [],
      };
      return {
        ...row,
        body_delta: parseStoredQuillDelta(row.body_delta),
        cornell_cue_delta: parseStoredQuillDelta(row.cornell_cue_delta),
        cornell_summary_delta: parseStoredQuillDelta(
          row.cornell_summary_delta
        ),
        content_format: row.content_format ?? "plain",
        is_pinned: toBool(row.is_pinned),
        tag_ids: a.tag_ids,
        note_links: a.note_links,
        linked_todo_ids: a.linked_todo_ids,
      };
    }

    case "habit": {
      return {
        ...row,
        is_archived: toBool(row.is_archived),
      };
    }

    case "habit_log": {
      // Defensive: migration 0005 backfilled updated_at from created_at;
      // if created_at was also NULL on an old row, both timestamps can be null.
      const hl_now = nowISO();
      // getFullEntity (server_version in conflicts) reads SELECT *, so drop the server-only flag here.
      const { auto_closed: _autoClosed, ...logRow } = row;
      return {
        ...logRow,
        completed: toBool(row.completed),
        created_at: (row.created_at as string | null) ?? hl_now,
        updated_at: (row.updated_at as string | null) ?? hl_now,
      };
    }

    case "checklist_template": {
      return {
        ...row,
        is_system: toBool(row.is_system),
      };
    }

    case "checklist_category": {
      return {
        ...row,
        is_system: toBool(row.is_system),
      };
    }

    case "checklist_schedule": {
      return {
        ...row,
        enabled: toBool(row.enabled),
      };
    }

    case "checklist_template_item": {
      // Defensive: created_at/updated_at existed before 0005 but may be
      // null on rows where the original INSERT omitted them (very old data).
      const cti_now = nowISO();
      return {
        ...row,
        is_required: toBool(row.is_required),
        created_at: (row.created_at as string | null) ?? cti_now,
        updated_at: (row.updated_at as string | null) ?? cti_now,
      };
    }

    case "user": {
      // Strip password_hash — never expose to client
      const { password_hash: _stripped, ...safeRow } =
        row as Record<string, unknown> & { password_hash?: unknown };
      void _stripped;
      return {
        ...safeRow,
        is_admin: toBool(row.is_admin),
      };
    }

    case "checklist_run": {
      // Defensive: created_at/updated_at added by migration 0005 and backfilled
      // from started_at; NULL if started_at was also NULL on that old row.
      const cr_now = nowISO();
      return {
        ...row,
        created_at: (row.created_at as string | null) ?? cr_now,
        updated_at: (row.updated_at as string | null) ?? cr_now,
      };
    }

    case "checklist_run_item": {
      // Same backfill chain as checklist_run — inherits the same NULL risk.
      const cri_now = nowISO();
      return {
        ...row,
        created_at: (row.created_at as string | null) ?? cri_now,
        updated_at: (row.updated_at as string | null) ?? cri_now,
      };
    }

    // tag: no bool fields, no nullable timestamps risk → plain pass-through
    default:
      return { ...row };
  }
}

// ── fromSyncEntity: sync payload → DB input ─────────────────────────────────

/**
 * Convert a sync push payload to DB-ready input:
 *  - true/false → 0/1 integers
 *  - strip server-only fields (§5.3)
 *  - does NOT strip junction fields (tag_ids, note_links, linked_todo_ids) — caller handles
 */
export function fromSyncEntity(
  payload: Record<string, unknown>,
  type: EntityType
): Record<string, unknown> {
  // Strip server-only fields
  const stripped: Record<string, unknown> = { ...payload };
  for (const field of SERVER_ONLY[type] ?? []) {
    delete stripped[field];
  }

  // Convert booleans back to integers
  switch (type) {
    case "todo": {
      if ("is_frog" in stripped) stripped.is_frog = fromBool(stripped.is_frog);
      if ("is_important" in stripped)
        stripped.is_important = fromBoolNullable(stripped.is_important);
      if ("is_urgent" in stripped)
        stripped.is_urgent = fromBoolNullable(stripped.is_urgent);
      break;
    }

    case "note": {
      if ("is_pinned" in stripped) stripped.is_pinned = fromBool(stripped.is_pinned);
      if ("body_delta" in stripped) {
        stripped.body_delta = serializeQuillDelta(
          (stripped.body_delta as QuillDelta | null) ?? null
        );
      }
      if ("cornell_cue_delta" in stripped) {
        stripped.cornell_cue_delta = serializeQuillDelta(
          (stripped.cornell_cue_delta as QuillDelta | null) ?? null
        );
      }
      if ("cornell_summary_delta" in stripped) {
        stripped.cornell_summary_delta = serializeQuillDelta(
          (stripped.cornell_summary_delta as QuillDelta | null) ?? null
        );
      }
      break;
    }

    case "habit": {
      if ("is_archived" in stripped) stripped.is_archived = fromBool(stripped.is_archived);
      break;
    }

    case "habit_log": {
      if ("completed" in stripped) stripped.completed = fromBool(stripped.completed);
      break;
    }

    case "checklist_template": {
      // is_system already stripped as server-only — defensive: remove if somehow present
      if ("is_required" in stripped) stripped.is_required = fromBool(stripped.is_required);
      break;
    }

    case "checklist_schedule": {
      if ("enabled" in stripped) stripped.enabled = fromBool(stripped.enabled);
      break;
    }

    case "checklist_template_item": {
      if ("is_required" in stripped) stripped.is_required = fromBool(stripped.is_required);
      break;
    }

    // tag, checklist_run, checklist_run_item, user: no extra bool conversion needed
  }

  return stripped;
}

/**
 * sync.repo.ts
 *
 * Tất cả DB access cho sync layer. Không N+1: associations được bulk-fetch
 * bằng IN(...) queries rồi group in JS.
 *
 * API_CONTRACT §4 (pull) + §5 (push helpers)
 */
import { turso } from "../config/db.js";
import { nowISO } from "../utils/time.js";
import {
  toSyncEntity,
  fromSyncEntity,
  type EntityType,
  type TodoAssoc,
  type NoteAssoc,
} from "../sync/sync-serializer.js";

// ── Return type ──────────────────────────────────────────────────────────────

export type SyncChanges = {
  users: Record<string, unknown>[];
  tags: Record<string, unknown>[];
  todos: Record<string, unknown>[];
  notes: Record<string, unknown>[];
  habits: Record<string, unknown>[];
  habit_logs: Record<string, unknown>[];
  checklist_categories: Record<string, unknown>[];
  checklist_templates: Record<string, unknown>[];
  checklist_template_orders: Record<string, unknown>[];
  checklist_template_items: Record<string, unknown>[];
  checklist_runs: Record<string, unknown>[];
  checklist_run_items: Record<string, unknown>[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build IN(?,?,…) placeholder string */
const inPlaceholders = (ids: string[]): string => ids.map(() => "?").join(", ");

/**
 * Cast unknown[] to turso-compatible arg array.
 * Sync payload fields are DB primitives at runtime (string | number | null).
 * This avoids `any` while satisfying the InArgs type constraint.
 */
const dbArgs = (vals: unknown[]): (string | number | bigint | ArrayBuffer | null)[] =>
  vals as (string | number | bigint | ArrayBuffer | null)[];

const hasOwn = (obj: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

export class SyncPullQueryError extends Error {
  constructor(
    public readonly queryName: string,
    cause: unknown
  ) {
    super(`Sync pull query failed: ${queryName}`, { cause });
    this.name = "SyncPullQueryError";
  }
}

const runSyncQuery = async <T>(
  queryName: string,
  operation: Promise<T>
): Promise<T> => {
  try {
    return await operation;
  } catch (error) {
    throw new SyncPullQueryError(queryName, error);
  }
};

const syncTodoFields = [
  "parent_id",
  "title",
  "description",
  "status",
  "position",
  "is_frog",
  "frog_date",
  "is_important",
  "is_urgent",
  "estimated_minutes",
  "actual_minutes",
  "start_at",
  "due_at",
  "scheduled_date",
  "time",
  "trigger_after_todo_id",
  "habit_id",
  "completed_at",
  "recurrence_type",
  "recurrence_interval",
  "recurrence_days_of_week",
  "recurrence_end_date",
  "recurrence_template_id",
  "deleted_at",
] as const;

const updateExistingTodoFromSync = async (
  userId: string,
  p: Record<string, unknown>
): Promise<void> => {
  const sets: string[] = [];
  const args: unknown[] = [];

  for (const field of syncTodoFields) {
    if (hasOwn(p, field)) {
      sets.push(`${field} = ?`);
      args.push(p[field] ?? null);
    }
  }

  sets.push("updated_at = ?");
  args.push((p.updated_at as string | null) ?? nowISO());
  args.push(p.id, userId);

  await turso.execute({
    sql: `UPDATE todos SET ${sets.join(", ")}
          WHERE id = ? AND user_id = ?`,
    args: dbArgs(args),
  });
};

const syncNoteFields = [
  "title",
  "type",
  "body",
  "body_delta",
  "cornell_cue",
  "cornell_cue_delta",
  "cornell_summary",
  "cornell_summary_delta",
  "content_format",
  "is_pinned",
  "deleted_at",
] as const;

const updateExistingNoteFromSync = async (
  userId: string,
  p: Record<string, unknown>
): Promise<void> => {
  const sets: string[] = [];
  const args: unknown[] = [];

  for (const field of syncNoteFields) {
    if (hasOwn(p, field)) {
      sets.push(`${field} = ?`);
      args.push(p[field] ?? null);
    }
  }

  sets.push("updated_at = ?");
  args.push((p.updated_at as string | null) ?? nowISO());
  args.push(p.id, userId);

  await turso.execute({
    sql: `UPDATE notes SET ${sets.join(", ")}
          WHERE id = ? AND user_id = ?`,
    args: dbArgs(args),
  });
};

// ── getChangesSince ──────────────────────────────────────────────────────────

/**
 * Pull delta or full snapshot.
 *
 * `since` = "" | undefined → initial sync: only living entities (deleted_at IS NULL)
 * `since` = ISO timestamp  → delta: entities where updated_at > since (incl. soft-deleted)
 *
 * Bulk-fetch associations with IN queries to avoid N+1.
 */
export const getChangesSince = async (
  userId: string,
  since: string | undefined | null
): Promise<SyncChanges> => {
  const isInitial = !since || since === "";
  const a1 = isInitial ? [userId] : [userId, since!]; // single-arg or (userId, since)

  // ── Phase 1: all 10 main entity queries IN PARALLEL ──────────────────────
  // No inter-dependencies at this level → fire all at once, halving latency
  // on remote DBs (Turso: ~50 ms/query × 10 seq → 2 round-trips instead).
  const [
    usersRes, tagsRes, todosRes, notesRes,
    habitsRes, habitLogsRes, categoriesRes, templatesRes, templateOrdersRes,
    templateItemsRes,
    runsRes, runItemsRes,
  ] = await Promise.all([
    runSyncQuery("users", turso.execute({
      sql: isInitial
        ? "SELECT * FROM users WHERE id = ? AND deleted_at IS NULL"
        : "SELECT * FROM users WHERE id = ? AND updated_at > ?",
      args: a1,
    })),
    runSyncQuery("tags", turso.execute({
      sql: isInitial
        ? "SELECT * FROM tags WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC"
        : "SELECT * FROM tags WHERE user_id = ? AND updated_at > ? ORDER BY updated_at DESC",
      args: a1,
    })),
    runSyncQuery("todos", turso.execute({
      sql: isInitial
        ? "SELECT * FROM todos WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC"
        : "SELECT * FROM todos WHERE user_id = ? AND updated_at > ? ORDER BY updated_at DESC",
      args: a1,
    })),
    runSyncQuery("notes", turso.execute({
      sql: isInitial
        ? "SELECT * FROM notes WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC"
        : "SELECT * FROM notes WHERE user_id = ? AND updated_at > ? ORDER BY updated_at DESC",
      args: a1,
    })),
    runSyncQuery("habits", turso.execute({
      sql: isInitial
        ? "SELECT * FROM habits WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC"
        : "SELECT * FROM habits WHERE user_id = ? AND updated_at > ? ORDER BY updated_at DESC",
      args: a1,
    })),
    runSyncQuery("habit_logs", turso.execute({
      sql: isInitial
        ? `SELECT l.id, l.habit_id, l.log_date, l.completed, l.note,
                  l.created_at, l.updated_at, l.deleted_at
           FROM habit_logs l
           JOIN habits h ON h.id = l.habit_id
           WHERE h.user_id = ? AND h.deleted_at IS NULL AND l.deleted_at IS NULL
           ORDER BY l.updated_at DESC`
        : `SELECT l.id, l.habit_id, l.log_date, l.completed, l.note,
                  l.created_at, l.updated_at, l.deleted_at
           FROM habit_logs l
           JOIN habits h ON h.id = l.habit_id
           WHERE h.user_id = ? AND l.updated_at > ?
           ORDER BY l.updated_at DESC`,
      args: a1,
    })),
    runSyncQuery("checklist_categories", turso.execute({
      sql: isInitial
        ? `SELECT * FROM checklist_categories
           WHERE (user_id = ? OR is_system = 1) AND deleted_at IS NULL
           ORDER BY is_system DESC, sort_order ASC, updated_at DESC`
        : `SELECT * FROM checklist_categories
           WHERE (user_id = ? OR is_system = 1) AND updated_at > ?
           ORDER BY is_system DESC, sort_order ASC, updated_at DESC`,
      args: a1,
    })),
    runSyncQuery("checklist_templates", turso.execute({
      sql: isInitial
        ? `SELECT * FROM checklist_templates
           WHERE (user_id = ? OR is_system = 1) AND deleted_at IS NULL
           ORDER BY sort_order ASC, updated_at DESC`
        : `SELECT * FROM checklist_templates
           WHERE (user_id = ? OR is_system = 1) AND updated_at > ?
           ORDER BY sort_order ASC, updated_at DESC`,
      args: a1,
    })),
    runSyncQuery("checklist_template_orders", turso.execute({
      sql: isInitial
        ? `SELECT * FROM checklist_template_orders
           WHERE user_id = ? AND deleted_at IS NULL
           ORDER BY sort_order ASC, updated_at DESC`
        : `SELECT * FROM checklist_template_orders
           WHERE user_id = ? AND updated_at > ?
           ORDER BY sort_order ASC, updated_at DESC`,
      args: a1,
    })),
    runSyncQuery("checklist_template_items", turso.execute({
      sql: isInitial
        ? `SELECT i.* FROM checklist_template_items i
           JOIN checklist_templates t ON t.id = i.template_id
           WHERE (t.user_id = ? OR t.is_system = 1) AND i.deleted_at IS NULL
           ORDER BY i.updated_at DESC`
        : `SELECT i.* FROM checklist_template_items i
           JOIN checklist_templates t ON t.id = i.template_id
           WHERE (t.user_id = ? OR t.is_system = 1) AND i.updated_at > ?
           ORDER BY i.updated_at DESC`,
      args: a1,
    })),
    runSyncQuery("checklist_runs", turso.execute({
      sql: isInitial
        ? "SELECT * FROM checklist_runs WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC"
        : "SELECT * FROM checklist_runs WHERE user_id = ? AND updated_at > ? ORDER BY updated_at DESC",
      args: a1,
    })),
    runSyncQuery("checklist_run_items", turso.execute({
      sql: isInitial
        ? `SELECT ri.* FROM checklist_run_items ri
           JOIN checklist_runs r ON r.id = ri.run_id
           WHERE r.user_id = ? AND r.deleted_at IS NULL AND ri.deleted_at IS NULL
           ORDER BY ri.updated_at DESC`
        : `SELECT ri.* FROM checklist_run_items ri
           JOIN checklist_runs r ON r.id = ri.run_id
           WHERE r.user_id = ? AND ri.updated_at > ?
           ORDER BY ri.updated_at DESC`,
      args: a1,
    })),
  ]);

  // ── Phase 2: association queries for todo + note (PARALLEL) ──────────────
  const todoRows = todosRes.rows as unknown as Record<string, unknown>[];
  const noteRows = notesRes.rows as unknown as Record<string, unknown>[];
  const todoIds = todoRows.map((r) => r.id as string);
  const noteIds = noteRows.map((r) => r.id as string);

  const emptyResult = { rows: [] as unknown[] };

  const [tTagsRes, tNotesRes, nTagsRes, nLinksRes, nTodosRes] = await Promise.all([
    todoIds.length > 0
      ? runSyncQuery("todo_tags", turso.execute({
          sql: `SELECT tt.todo_id, tt.tag_id
                FROM todo_tags tt JOIN tags g ON g.id = tt.tag_id
                WHERE tt.todo_id IN (${inPlaceholders(todoIds)}) AND g.deleted_at IS NULL`,
          args: todoIds,
        }))
      : Promise.resolve(emptyResult),
    todoIds.length > 0
      ? runSyncQuery("todo_linked_notes", turso.execute({
          sql: `SELECT ntl.todo_id, ntl.note_id
                FROM note_todo_links ntl JOIN notes n ON n.id = ntl.note_id
                WHERE ntl.todo_id IN (${inPlaceholders(todoIds)}) AND n.deleted_at IS NULL`,
          args: todoIds,
        }))
      : Promise.resolve(emptyResult),
    noteIds.length > 0
      ? runSyncQuery("note_tags", turso.execute({
          sql: `SELECT nt.note_id, nt.tag_id
                FROM note_tags nt JOIN tags g ON g.id = nt.tag_id
                WHERE nt.note_id IN (${inPlaceholders(noteIds)}) AND g.deleted_at IS NULL`,
          args: noteIds,
        }))
      : Promise.resolve(emptyResult),
    noteIds.length > 0
      ? runSyncQuery("note_links", turso.execute({
          sql: `SELECT nl.source_note_id, nl.target_note_id, nl.label
                FROM note_links nl JOIN notes t ON t.id = nl.target_note_id
                WHERE nl.source_note_id IN (${inPlaceholders(noteIds)}) AND t.deleted_at IS NULL`,
          args: noteIds,
        }))
      : Promise.resolve(emptyResult),
    noteIds.length > 0
      ? runSyncQuery("note_linked_todos", turso.execute({
          sql: `SELECT ntl.note_id, ntl.todo_id
                FROM note_todo_links ntl JOIN todos t ON t.id = ntl.todo_id
                WHERE ntl.note_id IN (${inPlaceholders(noteIds)}) AND t.deleted_at IS NULL`,
          args: noteIds,
        }))
      : Promise.resolve(emptyResult),
  ]);

  // ── Group associations into Maps ─────────────────────────────────────────
  const todoTagMap = new Map<string, string[]>();
  const todoLinkedNoteMap = new Map<string, string[]>();
  for (const r of tTagsRes.rows as unknown as { todo_id: string; tag_id: string }[]) {
    if (!todoTagMap.has(r.todo_id)) todoTagMap.set(r.todo_id, []);
    todoTagMap.get(r.todo_id)!.push(r.tag_id);
  }
  for (const r of tNotesRes.rows as unknown as { todo_id: string; note_id: string }[]) {
    if (!todoLinkedNoteMap.has(r.todo_id)) todoLinkedNoteMap.set(r.todo_id, []);
    todoLinkedNoteMap.get(r.todo_id)!.push(r.note_id);
  }

  const noteTagMap = new Map<string, string[]>();
  const noteLinkMap = new Map<string, { target_note_id: string; label: string | null }[]>();
  const noteTodoMap = new Map<string, string[]>();
  for (const r of nTagsRes.rows as unknown as { note_id: string; tag_id: string }[]) {
    if (!noteTagMap.has(r.note_id)) noteTagMap.set(r.note_id, []);
    noteTagMap.get(r.note_id)!.push(r.tag_id);
  }
  for (const r of nLinksRes.rows as unknown as {
    source_note_id: string; target_note_id: string; label: string | null;
  }[]) {
    if (!noteLinkMap.has(r.source_note_id)) noteLinkMap.set(r.source_note_id, []);
    noteLinkMap.get(r.source_note_id)!.push({ target_note_id: r.target_note_id, label: r.label ?? null });
  }
  for (const r of nTodosRes.rows as unknown as { note_id: string; todo_id: string }[]) {
    if (!noteTodoMap.has(r.note_id)) noteTodoMap.set(r.note_id, []);
    noteTodoMap.get(r.note_id)!.push(r.todo_id);
  }

  // ── Serialize ─────────────────────────────────────────────────────────────
  const users = (usersRes.rows as unknown as Record<string, unknown>[]).map((r) =>
    toSyncEntity(r, "user")
  );
  const tags = (tagsRes.rows as unknown as Record<string, unknown>[]).map((r) =>
    toSyncEntity(r, "tag")
  );
  const todos = todoRows.map((r) =>
    toSyncEntity(r, "todo", {
      tag_ids: todoTagMap.get(r.id as string) ?? [],
      linked_note_ids: todoLinkedNoteMap.get(r.id as string) ?? [],
    } satisfies TodoAssoc)
  );
  const notes = noteRows.map((r) =>
    toSyncEntity(r, "note", {
      tag_ids: noteTagMap.get(r.id as string) ?? [],
      note_links: noteLinkMap.get(r.id as string) ?? [],
      linked_todo_ids: noteTodoMap.get(r.id as string) ?? [],
    } satisfies NoteAssoc)
  );
  const habits = (habitsRes.rows as unknown as Record<string, unknown>[]).map((r) =>
    toSyncEntity(r, "habit")
  );
  const habit_logs = (habitLogsRes.rows as unknown as Record<string, unknown>[]).map((r) =>
    toSyncEntity(r, "habit_log")
  );
  const checklist_categories = (
    categoriesRes.rows as unknown as Record<string, unknown>[]
  ).map((r) => toSyncEntity(r, "checklist_category"));
  const checklist_templates = (templatesRes.rows as unknown as Record<string, unknown>[]).map(
    (r) => toSyncEntity(r, "checklist_template")
  );
  const checklist_template_orders = (
    templateOrdersRes.rows as unknown as Record<string, unknown>[]
  ).map((r) => toSyncEntity(r, "checklist_template_order"));
  const checklist_template_items = (
    templateItemsRes.rows as unknown as Record<string, unknown>[]
  ).map((r) => toSyncEntity(r, "checklist_template_item"));
  const checklist_runs = (runsRes.rows as unknown as Record<string, unknown>[]).map((r) =>
    toSyncEntity(r, "checklist_run")
  );
  const checklist_run_items = (runItemsRes.rows as unknown as Record<string, unknown>[]).map(
    (r) => toSyncEntity(r, "checklist_run_item")
  );

  return {
    users,
    tags,
    todos,
    notes,
    habits,
    habit_logs,
    checklist_categories,
    checklist_templates,
    checklist_template_orders,
    checklist_template_items,
    checklist_runs,
    checklist_run_items,
  };
};

// ── getEntityUpdatedAt ───────────────────────────────────────────────────────

/** LWW helper: returns current server updated_at for an entity (null if not found) */
export const getEntityUpdatedAt = async (
  type: EntityType,
  id: string
): Promise<string | null> => {
  const TABLE: Partial<Record<EntityType, string>> = {
    todo: "todos",
    note: "notes",
    tag: "tags",
    habit: "habits",
    habit_log: "habit_logs",
    checklist_category: "checklist_categories",
    checklist_template: "checklist_templates",
    checklist_template_order: "checklist_template_orders",
    checklist_template_item: "checklist_template_items",
    checklist_run: "checklist_runs",
    checklist_run_item: "checklist_run_items",
    user: "users",
  };
  const table = TABLE[type];
  if (!table) return null;
  const res = await turso.execute({
    sql: `SELECT updated_at FROM ${table} WHERE id = ?`,
    args: [id],
  });
  if (res.rows.length === 0) return null;
  return ((res.rows[0] as unknown as Record<string, unknown>).updated_at as string) ?? null;
};

// ── upsertEntity ─────────────────────────────────────────────────────────────

/**
 * Write an entity to DB (INSERT or UPDATE).
 * `dbPayload` must already be processed by `fromSyncEntity` (booleans → integers,
 * server-only fields stripped). The LWW decision happens in the service layer
 * before calling this.
 */
export const upsertEntity = async (
  userId: string,
  type: EntityType,
  dbPayload: Record<string, unknown>,
  opts: { partialUpdate?: boolean } = {}
): Promise<void> => {
  const p = dbPayload;
  const now = nowISO();
  const createdAt = (p.created_at as string | null) ?? now;
  const updatedAt = (p.updated_at as string | null) ?? now;
  const deletedAt = (p.deleted_at as string | null) ?? null;

  switch (type) {
    case "todo": {
      if (opts.partialUpdate) {
        await updateExistingTodoFromSync(userId, p);
        break;
      }

      const recurrenceInterval = hasOwn(p, "recurrence_interval")
        ? (p.recurrence_interval ?? null)
        : p.recurrence_type
          ? 1
          : null;

      await turso.execute({
        sql: `INSERT INTO todos
              (id, user_id, parent_id, title, description, status, position,
               is_frog, frog_date, is_important, is_urgent, estimated_minutes, actual_minutes,
               start_at, due_at, scheduled_date, time, trigger_after_todo_id, habit_id, completed_at,
               recurrence_type, recurrence_interval, recurrence_days_of_week,
               recurrence_end_date, recurrence_template_id,
               created_at, updated_at, deleted_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                parent_id = excluded.parent_id,
                title = excluded.title,
                description = excluded.description,
                status = excluded.status,
                position = excluded.position,
                is_frog = excluded.is_frog,
                frog_date = excluded.frog_date,
                is_important = excluded.is_important,
                is_urgent = excluded.is_urgent,
                estimated_minutes = excluded.estimated_minutes,
                actual_minutes = excluded.actual_minutes,
                start_at = excluded.start_at,
                due_at = excluded.due_at,
                scheduled_date = excluded.scheduled_date,
                time = excluded.time,
                trigger_after_todo_id = excluded.trigger_after_todo_id,
                habit_id = excluded.habit_id,
                completed_at = excluded.completed_at,
                recurrence_type = excluded.recurrence_type,
                recurrence_interval = excluded.recurrence_interval,
                recurrence_days_of_week = excluded.recurrence_days_of_week,
                recurrence_end_date = excluded.recurrence_end_date,
                recurrence_template_id = excluded.recurrence_template_id,
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at`,
        args: dbArgs([
          p.id, userId, p.parent_id ?? null, p.title, p.description ?? null,
          p.status ?? "open", p.position ?? 0,
          p.is_frog ?? 0, p.frog_date ?? null,
          p.is_important ?? null, p.is_urgent ?? null,
          p.estimated_minutes ?? null, p.actual_minutes ?? null,
          p.start_at ?? null, p.due_at ?? null, p.scheduled_date ?? null, p.time ?? null,
          p.trigger_after_todo_id ?? null, p.habit_id ?? null, p.completed_at ?? null,
          p.recurrence_type ?? null, recurrenceInterval,
          p.recurrence_days_of_week ?? null, p.recurrence_end_date ?? null,
          p.recurrence_template_id ?? null,
          createdAt, updatedAt, deletedAt,
        ]),
      });
      break;
    }

    case "note": {
      if (opts.partialUpdate) {
        await updateExistingNoteFromSync(userId, p);
        break;
      }

      await turso.execute({
        sql: `INSERT INTO notes
              (id, user_id, title, type, body, body_delta, cornell_cue,
               cornell_cue_delta, cornell_summary, cornell_summary_delta,
               content_format, is_pinned, created_at, updated_at, deleted_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                type = excluded.type,
                body = excluded.body,
                body_delta = excluded.body_delta,
                cornell_cue = excluded.cornell_cue,
                cornell_cue_delta = excluded.cornell_cue_delta,
                cornell_summary = excluded.cornell_summary,
                cornell_summary_delta = excluded.cornell_summary_delta,
                content_format = excluded.content_format,
                is_pinned = excluded.is_pinned,
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at`,
        args: dbArgs([
          p.id, userId, p.title, p.type ?? "free",
          p.body ?? null, p.body_delta ?? null,
          p.cornell_cue ?? null, p.cornell_cue_delta ?? null,
          p.cornell_summary ?? null, p.cornell_summary_delta ?? null,
          p.content_format ?? "plain",
          p.is_pinned ?? 0,
          createdAt, updatedAt, deletedAt,
        ]),
      });
      break;
    }

    case "tag": {
      await turso.execute({
        sql: `INSERT INTO tags (id, user_id, name, color, created_at, updated_at, deleted_at)
              VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                color = excluded.color,
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at`,
        args: dbArgs([
          p.id, userId, p.name, p.color ?? "#888888",
          createdAt, updatedAt, deletedAt,
        ]),
      });
      break;
    }

    case "habit": {
      // current_streak + longest_streak: server-only, already stripped by fromSyncEntity
      // We preserve the server values by not including them in SET
      await turso.execute({
        sql: `INSERT INTO habits
              (id, user_id, title, description, icon, color, frequency_type,
               target_per_period, active_weekdays, start_date, end_date,
               current_streak, longest_streak, is_archived,
               created_at, updated_at, deleted_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                description = excluded.description,
                icon = excluded.icon,
                color = excluded.color,
                frequency_type = excluded.frequency_type,
                target_per_period = excluded.target_per_period,
                active_weekdays = excluded.active_weekdays,
                start_date = excluded.start_date,
                end_date = excluded.end_date,
                is_archived = excluded.is_archived,
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at`,
        args: dbArgs([
          p.id, userId, p.title, p.description ?? null, p.icon ?? null,
          p.color ?? "#4CAF50", p.frequency_type ?? "daily",
          p.target_per_period ?? 1, p.active_weekdays ?? null,
          p.start_date, p.end_date ?? null,
          p.is_archived ?? 0,
          createdAt, updatedAt, deletedAt,
        ]),
      });
      break;
    }

    case "habit_log": {
      await turso.execute({
        sql: `INSERT INTO habit_logs
              (id, habit_id, log_date, completed, note, created_at, updated_at, deleted_at)
              VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                completed = excluded.completed,
                note = excluded.note,
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at`,
        args: dbArgs([
          p.id, p.habit_id, p.log_date, p.completed ?? 0, p.note ?? null,
          createdAt, updatedAt, deletedAt,
        ]),
      });
      break;
    }

    case "checklist_category": {
      await turso.execute({
        sql: `INSERT INTO checklist_categories
              (id, user_id, name, slug, icon, color, sort_order, is_system,
               created_at, updated_at, deleted_at)
              VALUES (?,?,?,?,?,?,?,0,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                slug = excluded.slug,
                icon = excluded.icon,
                color = excluded.color,
                sort_order = excluded.sort_order,
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at`,
        args: dbArgs([
          p.id, userId, p.name, p.slug, p.icon ?? null,
          p.color ?? "#888888", p.sort_order ?? 0,
          createdAt, updatedAt, deletedAt,
        ]),
      });
      break;
    }

    case "checklist_template": {
      // times_used, last_used_at, is_system: server-only, already stripped
      // On INSERT default: times_used=0, is_system=0 (user can't set system)
      await turso.execute({
        sql: `INSERT INTO checklist_templates
              (id, user_id, title, description, icon, category, category_id,
               sort_order, is_system, times_used, last_used_at,
               created_at, updated_at, deleted_at)
              VALUES (?,?,?,?,?,?,?,?,0,0,NULL,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                description = excluded.description,
                icon = excluded.icon,
                category = excluded.category,
                category_id = excluded.category_id,
                sort_order = excluded.sort_order,
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at`,
        args: dbArgs([
          p.id, userId, p.title, p.description ?? null, p.icon ?? null,
          p.category ?? null, p.category_id ?? null, p.sort_order ?? 0,
          createdAt, updatedAt, deletedAt,
        ]),
      });
      break;
    }

    case "checklist_template_order": {
      const visible = await turso.execute({
        sql: `SELECT 1 FROM checklist_templates
              WHERE id = ? AND deleted_at IS NULL
                AND (is_system = 1 OR (is_system = 0 AND user_id = ?))`,
        args: dbArgs([p.template_id, userId]),
      });
      if (visible.rows.length === 0) break;

      const existing = await turso.execute({
        sql: `SELECT id FROM checklist_template_orders
              WHERE user_id = ? AND (id = ? OR template_id = ?)
              LIMIT 1`,
        args: dbArgs([userId, p.id, p.template_id]),
      });

      if (existing.rows.length > 0) {
        const existingId = (existing.rows[0] as unknown as { id: string }).id;
        await turso.execute({
          sql: `UPDATE checklist_template_orders
                SET template_id = ?, sort_order = ?, updated_at = ?, deleted_at = ?
                WHERE id = ? AND user_id = ?`,
          args: dbArgs([
            p.template_id,
            p.sort_order ?? 0,
            updatedAt,
            deletedAt,
            existingId,
            userId,
          ]),
        });
      } else {
        await turso.execute({
          sql: `INSERT INTO checklist_template_orders
                (id, user_id, template_id, sort_order, created_at, updated_at, deleted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: dbArgs([
            p.id, userId, p.template_id, p.sort_order ?? 0,
            createdAt, updatedAt, deletedAt,
          ]),
        });
      }
      break;
    }

    case "checklist_template_item": {
      await turso.execute({
        sql: `INSERT INTO checklist_template_items
              (id, template_id, position, title, description, is_required,
               created_at, updated_at, deleted_at)
              VALUES (?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                position = excluded.position,
                title = excluded.title,
                description = excluded.description,
                is_required = excluded.is_required,
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at`,
        args: dbArgs([
          p.id, p.template_id, p.position ?? 0, p.title, p.description ?? null,
          p.is_required ?? 1,
          createdAt, updatedAt, deletedAt,
        ]),
      });
      break;
    }

    case "checklist_run": {
      await turso.execute({
        sql: `INSERT INTO checklist_runs
               (id, template_id, user_id, name, status, started_at, completed_at,
                duration_ms, created_at, updated_at, deleted_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 status = excluded.status,
                 started_at = excluded.started_at,
                 completed_at = excluded.completed_at,
                 duration_ms = excluded.duration_ms,
                 updated_at = excluded.updated_at,
                 deleted_at = excluded.deleted_at`,
        args: dbArgs([
          p.id, p.template_id, userId, p.name ?? null,
          p.status ?? "in_progress", p.started_at ?? now, p.completed_at ?? null,
          p.duration_ms ?? null, createdAt, updatedAt, deletedAt,
        ]),
      });
      break;
    }

    case "checklist_run_item": {
      await turso.execute({
        sql: `INSERT INTO checklist_run_items
              (id, run_id, template_item_id, status, completed_at, note,
               created_at, updated_at, deleted_at)
              VALUES (?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                completed_at = excluded.completed_at,
                note = excluded.note,
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at`,
        args: dbArgs([
          p.id, p.run_id, p.template_item_id,
          p.status ?? "pending", p.completed_at ?? null, p.note ?? null,
          createdAt, updatedAt, deletedAt,
        ]),
      });
      break;
    }

    case "user": {
      // user: email/password_hash/is_admin already stripped by fromSyncEntity
      // Only allow updating safe profile fields
      await turso.execute({
        sql: `UPDATE users
              SET display_name = ?, avatar_url = ?, timezone = ?, settings = ?,
                  updated_at = ?
              WHERE id = ?`,
        args: dbArgs([
          p.display_name ?? null, p.avatar_url ?? null,
          p.timezone ?? "Asia/Ho_Chi_Minh", p.settings ?? null,
          updatedAt, userId,
        ]),
      });
      break;
    }
  }
};

// ── softDeleteEntity ─────────────────────────────────────────────────────────

/**
 * Soft-delete an entity with §6 cascade rules:
 *   todo           → recursive subtasks (WITH RECURSIVE)
 *   habit          → habit_logs
 *   checklist_template → checklist_template_items
 *   checklist_run  → checklist_run_items
 */
export const softDeleteEntity = async (
  type: EntityType,
  id: string,
  deletedAt: string
): Promise<void> => {
  switch (type) {
    case "todo": {
      // Collect entire subtree with recursive CTE, then batch-delete
      const treeRes = await turso.execute({
        sql: `WITH RECURSIVE subtree(id) AS (
                SELECT id FROM todos WHERE id = ? AND deleted_at IS NULL
                UNION ALL
                SELECT t.id FROM todos t
                INNER JOIN subtree p ON t.parent_id = p.id
                WHERE t.deleted_at IS NULL
              )
              SELECT id FROM subtree`,
        args: [id],
      });
      const allIds = (treeRes.rows as unknown as { id: string }[]).map((r) => r.id);
      if (allIds.length > 0) {
        await turso.batch(
          allIds.map((tid) => ({
            sql: "UPDATE todos SET deleted_at = ?, updated_at = ? WHERE id = ?",
            args: [deletedAt, deletedAt, tid] as (string | null)[],
          })),
          "write"
        );
      }
      break;
    }
    case "habit": {
      await turso.batch([
        {
          sql: "UPDATE habits SET deleted_at = ?, updated_at = ? WHERE id = ?",
          args: [deletedAt, deletedAt, id],
        },
        {
          sql: "UPDATE habit_logs SET deleted_at = ?, updated_at = ? WHERE habit_id = ? AND deleted_at IS NULL",
          args: [deletedAt, deletedAt, id],
        },
      ], "write");
      break;
    }
    case "checklist_category": {
      await turso.batch([
        {
          sql: "UPDATE checklist_categories SET deleted_at = ?, updated_at = ? WHERE id = ?",
          args: [deletedAt, deletedAt, id],
        },
        {
          sql: "UPDATE checklist_templates SET category_id = NULL, category = NULL, updated_at = ? WHERE category_id = ?",
          args: [deletedAt, id],
        },
      ], "write");
      break;
    }
    case "checklist_template": {
      await turso.batch([
        {
          sql: "UPDATE checklist_templates SET deleted_at = ?, updated_at = ? WHERE id = ?",
          args: [deletedAt, deletedAt, id],
        },
        {
          sql: "UPDATE checklist_template_items SET deleted_at = ?, updated_at = ? WHERE template_id = ? AND deleted_at IS NULL",
          args: [deletedAt, deletedAt, id],
        },
        {
          sql: "UPDATE checklist_template_orders SET deleted_at = ?, updated_at = ? WHERE template_id = ? AND deleted_at IS NULL",
          args: [deletedAt, deletedAt, id],
        },
      ], "write");
      break;
    }
    case "checklist_template_order": {
      await turso.execute({
        sql: "UPDATE checklist_template_orders SET deleted_at = ?, updated_at = ? WHERE id = ?",
        args: [deletedAt, deletedAt, id],
      });
      break;
    }
    case "checklist_run": {
      await turso.batch([
        {
          sql: "UPDATE checklist_runs SET deleted_at = ?, updated_at = ? WHERE id = ?",
          args: [deletedAt, deletedAt, id],
        },
        {
          sql: "UPDATE checklist_run_items SET deleted_at = ?, updated_at = ? WHERE run_id = ? AND deleted_at IS NULL",
          args: [deletedAt, deletedAt, id],
        },
      ], "write");
      break;
    }
    default: {
      // note, tag, habit_log, checklist_template_item, checklist_run_item, user
      const TABLE: Partial<Record<EntityType, string>> = {
        note: "notes",
        tag: "tags",
        habit_log: "habit_logs",
        checklist_template_item: "checklist_template_items",
        checklist_run_item: "checklist_run_items",
        user: "users",
      };
      const table = TABLE[type];
      if (!table) return;
      await turso.execute({
        sql: `UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ?`,
        args: [deletedAt, deletedAt, id],
      });
    }
  }
};

// ── reconcileJunctions ───────────────────────────────────────────────────────

/**
 * Sync junction data after an entity upsert (Phase B4 §5.4).
 *
 * For `todo`: reconciles tag_ids (add/remove from todo_tags).
 * For `note`: reconciles tag_ids + note_links + linked_todo_ids.
 *
 * NOTE: does NOT bump entity.updated_at — it was already set from payload.updated_at
 * by upsertEntity. Bumping again would overwrite the client's timestamp.
 *
 * `syncPayload` is the ORIGINAL sync payload (with boolean junctions),
 * NOT the fromSyncEntity-processed one.
 */
export const reconcileJunctions = async (
  type: EntityType,
  id: string,
  userId: string,
  syncPayload: Record<string, unknown>
): Promise<void> => {
  if (type !== "todo" && type !== "note") return; // only these have junctions

  if (type === "todo") {
    if (hasOwn(syncPayload, "tag_ids")) {
      const newTagIds = (syncPayload.tag_ids as string[] | undefined) ?? [];
      await reconcileTodoTags(id, userId, newTagIds);
    }
  }

  if (type === "note") {
    if (hasOwn(syncPayload, "tag_ids")) {
      const newTagIds = (syncPayload.tag_ids as string[] | undefined) ?? [];
      await reconcileNoteTags(id, userId, newTagIds);
    }
    if (hasOwn(syncPayload, "note_links")) {
      const newNoteLinks = (
        syncPayload.note_links as
          | { target_note_id: string; label?: string | null }[]
          | undefined
      ) ?? [];
      await reconcileNoteLinks(id, userId, newNoteLinks);
    }
    if (hasOwn(syncPayload, "linked_todo_ids")) {
      const newLinkedTodoIds =
        (syncPayload.linked_todo_ids as string[] | undefined) ?? [];
      await reconcileNoteTodoLinks(id, userId, newLinkedTodoIds);
    }
  }
};

// ── Junction reconcile helpers ───────────────────────────────────────────────

/** Reconcile todo_tags: add new tag_ids, remove stale ones. */
async function reconcileTodoTags(todoId: string, userId: string, newTagIds: string[]): Promise<void> {
  // Current tags
  const cur = await turso.execute({
    sql: "SELECT tag_id FROM todo_tags WHERE todo_id = ?",
    args: [todoId],
  });
  const currentSet = new Set(
    (cur.rows as unknown as { tag_id: string }[]).map((r) => r.tag_id)
  );
  const newSet = new Set(newTagIds);

  const toAdd = newTagIds.filter((id) => !currentSet.has(id));
  const toRemove = [...currentSet].filter((id) => !newSet.has(id));

  if (toAdd.length === 0 && toRemove.length === 0) return;

  const stmts: { sql: string; args: (string | number | null)[] }[] = [];

  // Add only tags that exist and belong to user (§7.1 anti-leak)
  for (const tagId of toAdd) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO todo_tags (todo_id, tag_id)
            SELECT ?, t.id FROM tags t
            WHERE t.id = ? AND t.user_id = ? AND t.deleted_at IS NULL`,
      args: [todoId, tagId, userId],
    });
  }

  // Remove stale
  for (const tagId of toRemove) {
    stmts.push({
      sql: "DELETE FROM todo_tags WHERE todo_id = ? AND tag_id = ?",
      args: [todoId, tagId],
    });
  }

  await turso.batch(stmts, "write");
}

/** Reconcile note_tags: add new, remove stale. */
async function reconcileNoteTags(noteId: string, userId: string, newTagIds: string[]): Promise<void> {
  const cur = await turso.execute({
    sql: "SELECT tag_id FROM note_tags WHERE note_id = ?",
    args: [noteId],
  });
  const currentSet = new Set(
    (cur.rows as unknown as { tag_id: string }[]).map((r) => r.tag_id)
  );
  const newSet = new Set(newTagIds);

  const toAdd = newTagIds.filter((id) => !currentSet.has(id));
  const toRemove = [...currentSet].filter((id) => !newSet.has(id));

  if (toAdd.length === 0 && toRemove.length === 0) return;

  const stmts: { sql: string; args: (string | number | null)[] }[] = [];

  for (const tagId of toAdd) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO note_tags (note_id, tag_id)
            SELECT ?, t.id FROM tags t
            WHERE t.id = ? AND t.user_id = ? AND t.deleted_at IS NULL`,
      args: [noteId, tagId, userId],
    });
  }
  for (const tagId of toRemove) {
    stmts.push({
      sql: "DELETE FROM note_tags WHERE note_id = ? AND tag_id = ?",
      args: [noteId, tagId],
    });
  }

  await turso.batch(stmts, "write");
}

/**
 * Reconcile note_links (outgoing from this note).
 * §5.4: match (source, target), UPDATE label if changed — do NOT DELETE+INSERT.
 */
async function reconcileNoteLinks(
  sourceNoteId: string,
  userId: string,
  newLinks: { target_note_id: string; label?: string | null }[]
): Promise<void> {
  const cur = await turso.execute({
    sql: "SELECT target_note_id, label FROM note_links WHERE source_note_id = ?",
    args: [sourceNoteId],
  });
  const currentMap = new Map<string, string | null>(
    (cur.rows as unknown as { target_note_id: string; label: string | null }[]).map((r) => [
      r.target_note_id,
      r.label ?? null,
    ])
  );
  const newMap = new Map<string, string | null>(
    newLinks.map((l) => [l.target_note_id, l.label ?? null])
  );

  const stmts: { sql: string; args: (string | number | null)[] }[] = [];
  const { newId } = await import("../utils/id.js");
  const now = nowISO();

  for (const [targetId, newLabel] of newMap) {
    if (currentMap.has(targetId)) {
      // Existing link: UPDATE label if changed
      if (currentMap.get(targetId) !== newLabel) {
        stmts.push({
          sql: "UPDATE note_links SET label = ? WHERE source_note_id = ? AND target_note_id = ?",
          args: [newLabel, sourceNoteId, targetId],
        });
      }
    } else {
      // New link: INSERT (verify target note exists and belongs to user)
      stmts.push({
        sql: `INSERT OR IGNORE INTO note_links (id, source_note_id, target_note_id, label, created_at)
              SELECT ?, ?, n.id, ?, ?
              FROM notes n
              WHERE n.id = ? AND n.user_id = ? AND n.deleted_at IS NULL`,
        args: [newId(), sourceNoteId, newLabel, now, targetId, userId],
      });
    }
  }

  // Remove links no longer in payload
  for (const targetId of currentMap.keys()) {
    if (!newMap.has(targetId)) {
      stmts.push({
        sql: "DELETE FROM note_links WHERE source_note_id = ? AND target_note_id = ?",
        args: [sourceNoteId, targetId],
      });
    }
  }

  if (stmts.length > 0) {
    await turso.batch(stmts, "write");
  }
}

/** Reconcile note_todo_links for a note. */
async function reconcileNoteTodoLinks(
  noteId: string,
  userId: string,
  newTodoIds: string[]
): Promise<void> {
  const cur = await turso.execute({
    sql: "SELECT todo_id FROM note_todo_links WHERE note_id = ?",
    args: [noteId],
  });
  const currentSet = new Set(
    (cur.rows as unknown as { todo_id: string }[]).map((r) => r.todo_id)
  );
  const newSet = new Set(newTodoIds);

  const toAdd = newTodoIds.filter((id) => !currentSet.has(id));
  const toRemove = [...currentSet].filter((id) => !newSet.has(id));

  if (toAdd.length === 0 && toRemove.length === 0) return;

  const { newId } = await import("../utils/id.js");
  const now = nowISO();
  const stmts: { sql: string; args: (string | number | null)[] }[] = [];

  for (const todoId of toAdd) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO note_todo_links (id, note_id, todo_id, created_at)
            SELECT ?, ?, t.id, ?
            FROM todos t
            WHERE t.id = ? AND t.user_id = ? AND t.deleted_at IS NULL`,
      args: [newId(), noteId, now, todoId, userId],
    });
  }
  for (const todoId of toRemove) {
    stmts.push({
      sql: "DELETE FROM note_todo_links WHERE note_id = ? AND todo_id = ?",
      args: [noteId, todoId],
    });
  }

  await turso.batch(stmts, "write");
}

// ── Push helpers (used by sync.service.ts) ───────────────────────────────────

/**
 * Return ownership + timestamp info for LWW + auth checks.
 *
 * For child entities (habit_log, checklist_template_item, checklist_run_item)
 * `user_id` is resolved via JOIN to the parent table.
 * For user entity `user_id === id`.
 *
 * Returns null if the entity doesn't exist.
 */
export const getEntityInfo = async (
  type: EntityType,
  id: string
): Promise<{ user_id: string | null; updated_at: string | null } | null> => {
  let sql: string;
  switch (type) {
    case "todo":
      sql = "SELECT user_id, updated_at FROM todos WHERE id = ?";
      break;
    case "note":
      sql = "SELECT user_id, updated_at FROM notes WHERE id = ?";
      break;
    case "tag":
      sql = "SELECT user_id, updated_at FROM tags WHERE id = ?";
      break;
    case "habit":
      sql = "SELECT user_id, updated_at FROM habits WHERE id = ?";
      break;
    case "habit_log":
      sql = `SELECT h.user_id, hl.updated_at
             FROM habit_logs hl JOIN habits h ON h.id = hl.habit_id
             WHERE hl.id = ?`;
      break;
    case "checklist_category":
      sql = "SELECT user_id, updated_at FROM checklist_categories WHERE id = ?";
      break;
    case "checklist_template":
      sql = "SELECT user_id, updated_at FROM checklist_templates WHERE id = ?";
      break;
    case "checklist_template_order":
      sql = "SELECT user_id, updated_at FROM checklist_template_orders WHERE id = ?";
      break;
    case "checklist_template_item":
      sql = `SELECT ct.user_id, cti.updated_at
             FROM checklist_template_items cti
             JOIN checklist_templates ct ON ct.id = cti.template_id
             WHERE cti.id = ?`;
      break;
    case "checklist_run":
      sql = "SELECT user_id, updated_at FROM checklist_runs WHERE id = ?";
      break;
    case "checklist_run_item":
      sql = `SELECT cr.user_id, cri.updated_at
             FROM checklist_run_items cri
             JOIN checklist_runs cr ON cr.id = cri.run_id
             WHERE cri.id = ?`;
      break;
    case "user":
      sql = "SELECT id AS user_id, updated_at FROM users WHERE id = ?";
      break;
  }
  const res = await turso.execute({ sql, args: [id] });
  if (res.rows.length === 0) return null;
  const row = res.rows[0] as unknown as { user_id: string | null; updated_at: string | null };
  return { user_id: row.user_id, updated_at: row.updated_at };
};

/** Return true if checklist_template id exists AND is_system = 1. */
export const isSystemTemplate = async (id: string): Promise<boolean> => {
  const res = await turso.execute({
    sql: "SELECT is_system FROM checklist_templates WHERE id = ?",
    args: [id],
  });
  if (res.rows.length === 0) return false;
  const row = res.rows[0] as unknown as { is_system: number };
  return row.is_system === 1;
};

/** Return true if checklist_category id exists AND is_system = 1. */
export const isSystemCategory = async (id: string): Promise<boolean> => {
  const res = await turso.execute({
    sql: "SELECT is_system FROM checklist_categories WHERE id = ?",
    args: [id],
  });
  if (res.rows.length === 0) return false;
  const row = res.rows[0] as unknown as { is_system: number };
  return row.is_system === 1;
};

/** §3.3 Tag natural-key lookup: find tag by (user_id, name) regardless of deleted_at. */
export const getTagByNaturalKey = async (
  userId: string,
  name: string
): Promise<{ id: string; deleted_at: string | null } | null> => {
  const res = await turso.execute({
    sql: "SELECT id, deleted_at FROM tags WHERE user_id = ? AND name = ?",
    args: [userId, name],
  });
  if (res.rows.length === 0) return null;
  const row = res.rows[0] as unknown as { id: string; deleted_at: string | null };
  return { id: row.id, deleted_at: row.deleted_at };
};

/** §3.5 Habit-log natural-key lookup: find log by (habit_id, log_date), verified via habit ownership. */
export const getHabitLogByNaturalKey = async (
  habitId: string,
  logDate: string,
  userId: string
): Promise<{ id: string; deleted_at: string | null } | null> => {
  const res = await turso.execute({
    sql: `SELECT hl.id, hl.deleted_at
          FROM habit_logs hl
          JOIN habits h ON h.id = hl.habit_id
          WHERE hl.habit_id = ? AND hl.log_date = ? AND h.user_id = ?`,
    args: [habitId, logDate, userId],
  });
  if (res.rows.length === 0) return null;
  const row = res.rows[0] as unknown as { id: string; deleted_at: string | null };
  return { id: row.id, deleted_at: row.deleted_at };
};

/**
 * §3.6 Recurring-occurrence natural key: a series holds at most one live
 * occurrence per scheduled date. Returns the occurrence (other than `excludeId`)
 * that already holds `(seriesId, scheduledDate)`, or null.
 */
export const getLiveOccurrenceBySeriesDate = async (
  userId: string,
  seriesId: string,
  scheduledDate: string,
  excludeId: string
): Promise<{ id: string } | null> => {
  const res = await turso.execute({
    sql: `SELECT id FROM todos
          WHERE user_id = ?
            AND deleted_at IS NULL
            AND parent_id IS NULL
            AND recurrence_type IS NOT NULL
            AND COALESCE(recurrence_template_id, id) = ?
            AND scheduled_date = ?
            AND id <> ?
          ORDER BY created_at ASC, id ASC
          LIMIT 1`,
    args: [userId, seriesId, scheduledDate, excludeId],
  });
  if (res.rows.length === 0) return null;
  return { id: (res.rows[0] as unknown as { id: string }).id };
};

/**
 * §3.3 Resurrect a dead tag row: clear deleted_at, apply new name/color/updated_at.
 * The server keeps its canonical id; the pushed id is different → caller returns conflict.
 */
export const resurrectTagRow = async (
  serverTagId: string,
  patch: { name?: unknown; color?: unknown; updated_at?: unknown }
): Promise<void> => {
  const now = nowISO();
  await turso.execute({
    sql: `UPDATE tags
          SET name = ?, color = COALESCE(?, color), deleted_at = NULL, updated_at = ?
          WHERE id = ?`,
    args: [
      (patch.name as string) ?? null,
      (patch.color as string | null) ?? null,
      (patch.updated_at as string) ?? now,
      serverTagId,
    ],
  });
};

/**
 * §3.5 Resurrect a dead habit_log row: clear deleted_at, apply completed/note/updated_at.
 */
export const resurrectHabitLogRow = async (
  serverLogId: string,
  patch: { completed?: unknown; note?: unknown; updated_at?: unknown }
): Promise<void> => {
  const now = nowISO();
  // completed comes in as boolean from push payload; store as 0/1
  const completed = patch.completed === true || patch.completed === 1 ? 1 : 0;
  await turso.execute({
    sql: `UPDATE habit_logs
          SET completed = ?, note = COALESCE(?, note),
              deleted_at = NULL, updated_at = ?
          WHERE id = ?`,
    args: [
      completed,
      (patch.note as string | null) ?? null,
      (patch.updated_at as string) ?? now,
      serverLogId,
    ],
  });
};

/**
 * Return a full sync payload for a single entity (used for server_version in conflict).
 * Performs association lookups for todo + note.
 */
export const getFullEntity = async (
  type: EntityType,
  id: string,
  _userId: string
): Promise<Record<string, unknown> | null> => {
  const TABLE: Partial<Record<EntityType, string>> = {
    todo: "todos",
    note: "notes",
    tag: "tags",
    habit: "habits",
    habit_log: "habit_logs",
    checklist_category: "checklist_categories",
    checklist_template: "checklist_templates",
    checklist_template_order: "checklist_template_orders",
    checklist_template_item: "checklist_template_items",
    checklist_run: "checklist_runs",
    checklist_run_item: "checklist_run_items",
    user: "users",
  };
  const table = TABLE[type];
  if (!table) return null;

  const rowRes = await turso.execute({
    sql: `SELECT * FROM ${table} WHERE id = ?`,
    args: [id],
  });
  if (rowRes.rows.length === 0) return null;
  const row = rowRes.rows[0] as unknown as Record<string, unknown>;

  // For todo: fetch tag_ids + linked_note_ids
  if (type === "todo") {
    const [tagsRes, notesRes] = await Promise.all([
      turso.execute({
        sql: `SELECT tt.tag_id FROM todo_tags tt
              JOIN tags g ON g.id = tt.tag_id
              WHERE tt.todo_id = ? AND g.deleted_at IS NULL`,
        args: [id],
      }),
      turso.execute({
        sql: `SELECT ntl.note_id FROM note_todo_links ntl
              JOIN notes n ON n.id = ntl.note_id
              WHERE ntl.todo_id = ? AND n.deleted_at IS NULL`,
        args: [id],
      }),
    ]);
    const assoc: TodoAssoc = {
      tag_ids: (tagsRes.rows as unknown as { tag_id: string }[]).map((r) => r.tag_id),
      linked_note_ids: (notesRes.rows as unknown as { note_id: string }[]).map((r) => r.note_id),
    };
    return toSyncEntity(row, "todo", assoc);
  }

  // For note: fetch tag_ids + note_links + linked_todo_ids
  if (type === "note") {
    const [tagsRes, linksRes, todosRes] = await Promise.all([
      turso.execute({
        sql: `SELECT nt.tag_id FROM note_tags nt
              JOIN tags g ON g.id = nt.tag_id
              WHERE nt.note_id = ? AND g.deleted_at IS NULL`,
        args: [id],
      }),
      turso.execute({
        sql: `SELECT nl.target_note_id, nl.label
              FROM note_links nl
              JOIN notes n ON n.id = nl.target_note_id
              WHERE nl.source_note_id = ? AND n.deleted_at IS NULL`,
        args: [id],
      }),
      turso.execute({
        sql: `SELECT ntl.todo_id FROM note_todo_links ntl
              JOIN todos t ON t.id = ntl.todo_id
              WHERE ntl.note_id = ? AND t.deleted_at IS NULL`,
        args: [id],
      }),
    ]);
    const assoc: NoteAssoc = {
      tag_ids: (tagsRes.rows as unknown as { tag_id: string }[]).map((r) => r.tag_id),
      note_links: (linksRes.rows as unknown as { target_note_id: string; label: string | null }[]).map(
        (r) => ({ target_note_id: r.target_note_id, label: r.label })
      ),
      linked_todo_ids: (todosRes.rows as unknown as { todo_id: string }[]).map((r) => r.todo_id),
    };
    return toSyncEntity(row, "note", assoc);
  }

  // All other types: no associations
  return toSyncEntity(row, type);
};

import { turso } from "../config/db.js";
import { newId } from "../utils/id.js";
import { addDays, nowISO } from "../utils/time.js";
import type { TagRow } from "./tags.js";

export type TodoDeleteScope = "this" | "future" | "all";

export type TodoRow = {
  id: string;
  user_id: string;
  parent_id: string | null;
  title: string;
  description: string | null;
  status: "open" | "in_progress" | "done" | "archived";
  position: number;
  is_frog: number;
  frog_date: string | null;
  is_important: number | null;
  is_urgent: number | null;
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
};

const TODO_COLUMNS =
  "id, user_id, parent_id, title, description, status, position, " +
  "is_frog, frog_date, is_important, is_urgent, " +
  "estimated_minutes, actual_minutes, start_at, due_at, scheduled_date, time, " +
  "trigger_after_todo_id, habit_id, completed_at, " +
  "recurrence_type, recurrence_interval, recurrence_days_of_week, " +
  "recurrence_end_date, recurrence_template_id, " +
  "created_at, updated_at, deleted_at";

const nullableNum = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

const mapRow = (row: Record<string, unknown>): TodoRow => ({
  id: row.id as string,
  user_id: row.user_id as string,
  parent_id: (row.parent_id as string | null) ?? null,
  title: row.title as string,
  description: (row.description as string | null) ?? null,
  status: row.status as TodoRow["status"],
  position: Number(row.position),
  is_frog: Number(row.is_frog),
  frog_date: (row.frog_date as string | null) ?? null,
  is_important: nullableNum(row.is_important),
  is_urgent: nullableNum(row.is_urgent),
  estimated_minutes: nullableNum(row.estimated_minutes),
  actual_minutes: nullableNum(row.actual_minutes),
  start_at: (row.start_at as string | null) ?? null,
  due_at: (row.due_at as string | null) ?? null,
  scheduled_date: (row.scheduled_date as string | null) ?? null,
  time: (row.time as string | null) ?? null,
  trigger_after_todo_id: (row.trigger_after_todo_id as string | null) ?? null,
  habit_id: (row.habit_id as string | null) ?? null,
  completed_at: (row.completed_at as string | null) ?? null,
  recurrence_type: (row.recurrence_type as TodoRow["recurrence_type"]) ?? null,
  recurrence_interval: nullableNum(row.recurrence_interval),
  recurrence_days_of_week: (row.recurrence_days_of_week as string | null) ?? null,
  recurrence_end_date: (row.recurrence_end_date as string | null) ?? null,
  recurrence_template_id: (row.recurrence_template_id as string | null) ?? null,
  created_at: row.created_at as string,
  updated_at: row.updated_at as string,
  deleted_at: (row.deleted_at as string | null) ?? null,
});

const mapTagRow = (row: Record<string, unknown>): TagRow => ({
  id: row.id as string,
  user_id: row.user_id as string,
  name: row.name as string,
  color: row.color as string,
  created_at: row.created_at as string,
  updated_at: row.updated_at as string,
  deleted_at: (row.deleted_at as string | null) ?? null,
});

export class TodoRepoError extends Error {
  constructor(
    public code:
      | "not_found"
      | "invalid_parent"
      | "invalid_trigger"
      | "invalid_habit"
      | "bad_input"
      | "cycle"
      | "duplicate"
  ) {
    super(code);
  }
}

const isUniqueViolation = (e: unknown): boolean => {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE/i.test(msg);
};

const TODO_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const assertValidTimeState = (state: {
  parent_id: string | null;
  scheduled_date: string | null;
  time: string | null;
}): void => {
  if (state.time === null) return;
  if (!TODO_TIME_RE.test(state.time)) throw new TodoRepoError("bad_input");
  if (state.parent_id !== null) throw new TodoRepoError("bad_input");
  if (state.scheduled_date === null) throw new TodoRepoError("bad_input");
};

// ============================================================
// Read
// ============================================================

export const getTodoById = async (id: string): Promise<TodoRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${TODO_COLUMNS} FROM todos WHERE id = ?`,
    args: [id],
  });
  if (res.rows.length === 0) return null;
  return mapRow(res.rows[0] as unknown as Record<string, unknown>);
};

export const getTodoByIdScoped = async (
  id: string,
  userId: string
): Promise<TodoRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${TODO_COLUMNS} FROM todos
          WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    args: [id, userId],
  });
  if (res.rows.length === 0) return null;
  return mapRow(res.rows[0] as unknown as Record<string, unknown>);
};

// ============================================================
// Ownership / cycle helpers
// ============================================================

const assertParentExistsForUser = async (
  parentId: string,
  userId: string
): Promise<void> => {
  const res = await turso.execute({
    sql: "SELECT id FROM todos WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    args: [parentId, userId],
  });
  if (res.rows.length === 0) throw new TodoRepoError("invalid_parent");
};

const assertTriggerExistsForUser = async (
  triggerId: string,
  userId: string
): Promise<void> => {
  const res = await turso.execute({
    sql: "SELECT id FROM todos WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    args: [triggerId, userId],
  });
  if (res.rows.length === 0) throw new TodoRepoError("invalid_trigger");
};

const assertHabitExistsForUser = async (
  habitId: string,
  userId: string
): Promise<void> => {
  const res = await turso.execute({
    sql: "SELECT id FROM habits WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    args: [habitId, userId],
  });
  if (res.rows.length === 0) throw new TodoRepoError("invalid_habit");
};

const detectCycle = async (
  candidateParentId: string,
  selfId: string,
  userId: string
): Promise<void> => {
  let cur: string | null = candidateParentId;
  for (let i = 0; i < 50; i++) {
    if (cur === null) return;
    if (cur === selfId) throw new TodoRepoError("cycle");
    const r = await turso.execute({
      sql: "SELECT parent_id FROM todos WHERE id = ? AND user_id = ?",
      args: [cur, userId],
    });
    if (r.rows.length === 0) return;
    const row = r.rows[0] as unknown as { parent_id: string | null };
    cur = row.parent_id ?? null;
  }
};

// ============================================================
// Create
// ============================================================

export type CreateTodoInput = {
  user_id: string;
  title: string;
  description?: string | null;
  parent_id?: string | null;
  scheduled_date?: string | null;
  time?: string | null;
  status?: TodoRow["status"];
  is_frog?: boolean;
  frog_date?: string | null;
  is_important?: boolean | null;
  is_urgent?: boolean | null;
  estimated_minutes?: number | null;
  start_at?: string | null;
  due_at?: string | null;
  trigger_after_todo_id?: string | null;
  habit_id?: string | null;
  position?: number;
  // Recurrence (migration 0006)
  recurrence_type?: TodoRow["recurrence_type"];
  recurrence_interval?: number | null;
  recurrence_days_of_week?: string | null;
  recurrence_end_date?: string | null;
  recurrence_template_id?: string | null;
};

const boolToInt = (v: boolean | null | undefined): number | null => {
  if (v === undefined || v === null) return null;
  return v ? 1 : 0;
};

export const createTodo = async (input: CreateTodoInput): Promise<TodoRow> => {
  assertValidTimeState({
    parent_id: input.parent_id ?? null,
    scheduled_date: input.scheduled_date ?? null,
    time: input.time ?? null,
  });

  if (input.parent_id) {
    await assertParentExistsForUser(input.parent_id, input.user_id);
  }
  if (input.trigger_after_todo_id) {
    await assertTriggerExistsForUser(input.trigger_after_todo_id, input.user_id);
  }
  if (input.habit_id) {
    await assertHabitExistsForUser(input.habit_id, input.user_id);
  }

  // Auto position = MAX+1 trong cùng scope (same parent hoặc same scheduled_date top-level)
  let position = input.position;
  if (position === undefined) {
    if (input.parent_id) {
      const r = await turso.execute({
        sql: "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM todos WHERE parent_id = ? AND deleted_at IS NULL",
        args: [input.parent_id],
      });
      position = Number((r.rows[0] as unknown as Record<string, unknown>).p);
    } else if (input.scheduled_date) {
      const r = await turso.execute({
        sql: `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM todos
              WHERE user_id = ? AND scheduled_date = ? AND parent_id IS NULL AND deleted_at IS NULL`,
        args: [input.user_id, input.scheduled_date],
      });
      position = Number((r.rows[0] as unknown as Record<string, unknown>).p);
    } else {
      position = 0;
    }
  }

  const id = newId();
  const now = nowISO();
  const recurrenceInterval =
    input.recurrence_interval !== undefined
      ? input.recurrence_interval
      : input.recurrence_type
        ? 1
        : null;
  await turso.execute({
    sql: `INSERT INTO todos
          (id, user_id, parent_id, title, description, status, position,
           is_frog, frog_date, is_important, is_urgent,
           estimated_minutes, start_at, due_at, scheduled_date, time,
           trigger_after_todo_id, habit_id,
           recurrence_type, recurrence_interval, recurrence_days_of_week,
           recurrence_end_date, recurrence_template_id,
           created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.user_id,
      input.parent_id ?? null,
      input.title,
      input.description ?? null,
      input.status ?? "open",
      position,
      input.is_frog ? 1 : 0,
      input.frog_date ?? null,
      boolToInt(input.is_important ?? null),
      boolToInt(input.is_urgent ?? null),
      input.estimated_minutes ?? null,
      input.start_at ?? null,
      input.due_at ?? null,
      input.scheduled_date ?? null,
      input.time ?? null,
      input.trigger_after_todo_id ?? null,
      input.habit_id ?? null,
      input.recurrence_type ?? null,
      recurrenceInterval,
      input.recurrence_days_of_week ?? null,
      input.recurrence_end_date ?? null,
      input.recurrence_template_id ?? null,
      now,
      now,
    ],
  });
  const row = await getTodoById(id);
  if (!row) throw new Error("createTodo: row missing after insert");
  return row;
};

// ============================================================
// Update
// ============================================================

export type UpdateTodoPatch = Partial<{
  title: string;
  description: string | null;
  parent_id: string | null;
  status: TodoRow["status"];
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
  // Recurrence (migration 0006)
  recurrence_type: TodoRow["recurrence_type"];
  recurrence_interval: number | null;
  recurrence_days_of_week: string | null;
  recurrence_end_date: string | null;
  recurrence_template_id: string | null;
}>;

export const updateTodo = async (
  id: string,
  userId: string,
  patch: UpdateTodoPatch
): Promise<TodoRow | null> => {
  const current = await getTodoByIdScoped(id, userId);
  if (!current) return null;

  // Parent ownership + cycle
  if (patch.parent_id !== undefined && patch.parent_id !== null) {
    if (patch.parent_id === id) throw new TodoRepoError("cycle");
    await assertParentExistsForUser(patch.parent_id, userId);
    await detectCycle(patch.parent_id, id, userId);
  }
  if (patch.trigger_after_todo_id !== undefined && patch.trigger_after_todo_id !== null) {
    if (patch.trigger_after_todo_id === id) throw new TodoRepoError("invalid_trigger");
    await assertTriggerExistsForUser(patch.trigger_after_todo_id, userId);
  }
  if (patch.habit_id !== undefined && patch.habit_id !== null) {
    await assertHabitExistsForUser(patch.habit_id, userId);
  }

  assertValidTimeState({
    parent_id: patch.parent_id !== undefined ? patch.parent_id : current.parent_id,
    scheduled_date:
      patch.scheduled_date !== undefined
        ? patch.scheduled_date
        : current.scheduled_date,
    time: patch.time !== undefined ? patch.time : current.time,
  });

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const push = (sql: string, val: string | number | null) => {
    sets.push(sql);
    args.push(val);
  };
  if (patch.title !== undefined) push("title = ?", patch.title);
  if (patch.description !== undefined) push("description = ?", patch.description);
  if (patch.parent_id !== undefined) push("parent_id = ?", patch.parent_id);
  if (patch.status !== undefined) push("status = ?", patch.status);
  if (patch.position !== undefined) push("position = ?", patch.position);
  if (patch.is_frog !== undefined) push("is_frog = ?", patch.is_frog ? 1 : 0);
  if (patch.frog_date !== undefined) push("frog_date = ?", patch.frog_date);
  if (patch.is_important !== undefined) push("is_important = ?", boolToInt(patch.is_important));
  if (patch.is_urgent !== undefined) push("is_urgent = ?", boolToInt(patch.is_urgent));
  if (patch.estimated_minutes !== undefined)
    push("estimated_minutes = ?", patch.estimated_minutes);
  if (patch.actual_minutes !== undefined) push("actual_minutes = ?", patch.actual_minutes);
  if (patch.start_at !== undefined) push("start_at = ?", patch.start_at);
  if (patch.due_at !== undefined) push("due_at = ?", patch.due_at);
  if (patch.scheduled_date !== undefined) push("scheduled_date = ?", patch.scheduled_date);
  if (patch.time !== undefined) push("time = ?", patch.time);
  if (patch.trigger_after_todo_id !== undefined)
    push("trigger_after_todo_id = ?", patch.trigger_after_todo_id);
  if (patch.habit_id !== undefined) push("habit_id = ?", patch.habit_id);
  if (patch.recurrence_type !== undefined)
    push("recurrence_type = ?", patch.recurrence_type);
  if (patch.recurrence_interval !== undefined)
    push("recurrence_interval = ?", patch.recurrence_interval);
  if (patch.recurrence_days_of_week !== undefined)
    push("recurrence_days_of_week = ?", patch.recurrence_days_of_week);
  if (patch.recurrence_end_date !== undefined)
    push("recurrence_end_date = ?", patch.recurrence_end_date);
  if (patch.recurrence_template_id !== undefined)
    push("recurrence_template_id = ?", patch.recurrence_template_id);

  if (sets.length === 0) return current;

  sets.push("updated_at = ?");
  args.push(nowISO());
  args.push(id, userId);

  const res = await turso.execute({
    sql: `UPDATE todos SET ${sets.join(", ")}
          WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    args,
  });
  if (res.rowsAffected === 0) return null;
  return getTodoByIdScoped(id, userId);
};

// ============================================================
// Complete / Uncomplete / Soft delete / Frog / Classify
// ============================================================

export const completeTodo = async (
  id: string,
  userId: string,
  actualMinutes?: number | null
): Promise<{ todo: TodoRow; completedNow: boolean } | null> => {
  const now = nowISO();
  const sets = ["status = 'done'", "completed_at = ?", "updated_at = ?"];
  const args: (string | number | null)[] = [now, now];
  if (actualMinutes !== undefined) {
    sets.push("actual_minutes = ?");
    args.push(actualMinutes);
  }
  args.push(id, userId);
  const res = await turso.execute({
    sql: `UPDATE todos SET ${sets.join(", ")}
          WHERE id = ? AND user_id = ? AND deleted_at IS NULL
            AND status != 'done'`,
    args,
  });
  if (res.rowsAffected > 0) {
    const todo = await getTodoByIdScoped(id, userId);
    return todo ? { todo, completedNow: true } : null;
  }

  const existing = await getTodoByIdScoped(id, userId);
  if (!existing) return null;
  if (existing.status === "done" && actualMinutes !== undefined) {
    const actualUpdatedAt = nowISO();
    await turso.execute({
      sql: `UPDATE todos
            SET actual_minutes = ?, updated_at = ?
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      args: [actualMinutes, actualUpdatedAt, id, userId],
    });
    const updated = await getTodoByIdScoped(id, userId);
    return updated ? { todo: updated, completedNow: false } : null;
  }
  return { todo: existing, completedNow: false };
};

export const findRecurringOccurrenceByDate = async (
  userId: string,
  recurrenceTemplateId: string,
  scheduledDate: string,
  includeDeleted = false
): Promise<TodoRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${TODO_COLUMNS} FROM todos
          WHERE user_id = ?
            ${includeDeleted ? "" : "AND deleted_at IS NULL"}
            AND scheduled_date = ?
            AND recurrence_type IS NOT NULL
            AND COALESCE(recurrence_template_id, id) = ?
          ORDER BY (deleted_at IS NOT NULL) ASC, created_at ASC, id ASC
          LIMIT 1`,
    args: [userId, scheduledDate, recurrenceTemplateId],
  });
  if (res.rows.length === 0) return null;
  return mapRow(res.rows[0] as unknown as Record<string, unknown>);
};

export const createNextRecurringTodo = async (
  source: TodoRow,
  scheduledDate: string,
  recurrenceTemplateId: string
): Promise<TodoRow> => {
  const id = newId();
  const now = nowISO();
  await turso.batch(
    [
      {
        sql: `INSERT INTO todos
              (id, user_id, parent_id, title, description, status, position,
               is_frog, frog_date, is_important, is_urgent,
               estimated_minutes, actual_minutes, start_at, due_at, scheduled_date, time,
               trigger_after_todo_id, habit_id, completed_at,
               recurrence_type, recurrence_interval, recurrence_days_of_week,
               recurrence_end_date, recurrence_template_id,
               created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          source.user_id,
          source.parent_id,
          source.title,
          source.description,
          source.position,
          0,
          null,
          source.is_frog === 1 ? 1 : source.is_important,
          source.is_frog === 1 ? 1 : source.is_urgent,
          source.estimated_minutes,
          source.start_at,
          source.due_at,
          scheduledDate,
          source.time,
          source.trigger_after_todo_id,
          source.habit_id,
          source.recurrence_type,
          source.recurrence_interval,
          source.recurrence_days_of_week,
          source.recurrence_end_date,
          recurrenceTemplateId,
          now,
          now,
        ],
      },
      {
        sql: `INSERT INTO todo_tags (todo_id, tag_id)
              SELECT ?, tag_id FROM todo_tags WHERE todo_id = ?`,
        args: [id, source.id],
      },
    ],
    "write"
  );
  const row = await getTodoById(id);
  if (!row) throw new Error("createNextRecurringTodo: row missing after insert");
  return row;
};

type TodoTreeRow = TodoRow & { depth: number };

export const ensureRecurringSubtasksCopied = async (
  sourceRootId: string,
  targetRootId: string,
  userId: string
): Promise<void> => {
  const [sourceRoot, targetRoot] = await Promise.all([
    getTodoById(sourceRootId),
    getTodoByIdScoped(targetRootId, userId),
  ]);
  if (
    !sourceRoot ||
    sourceRoot.user_id !== userId ||
    !targetRoot
  ) {
    throw new TodoRepoError("not_found");
  }

  const targetChildren = await turso.execute({
    sql: `SELECT id FROM todos
          WHERE parent_id = ? AND user_id = ? AND deleted_at IS NULL
          LIMIT 1`,
    args: [targetRootId, userId],
  });
  if (targetChildren.rows.length > 0) return;

  const sourceDeletedSql =
    sourceRoot.deleted_at === null
      ? "deleted_at IS NULL"
      : "deleted_at = ?";
  const sourceDeletedArgs =
    sourceRoot.deleted_at === null ? [] : [sourceRoot.deleted_at];
  const sourceTree = await turso.execute({
    sql: `WITH RECURSIVE subtree AS (
            SELECT ${TODO_COLUMNS}, 1 AS depth
            FROM todos
            WHERE parent_id = ? AND user_id = ? AND ${sourceDeletedSql}
            UNION ALL
            SELECT ${TODO_COLUMNS.split(", ").map((column) => `t.${column}`).join(", ")},
                   subtree.depth + 1 AS depth
            FROM todos t
            INNER JOIN subtree ON t.parent_id = subtree.id
            WHERE t.user_id = ? AND t.${sourceDeletedSql}
          )
          SELECT * FROM subtree
          ORDER BY depth ASC, position ASC, created_at ASC, id ASC`,
    args: [
      sourceRootId,
      userId,
      ...sourceDeletedArgs,
      userId,
      ...sourceDeletedArgs,
    ],
  });
  if (sourceTree.rows.length === 0) return;

  const sourceRows = sourceTree.rows.map((row) => {
    const record = row as unknown as Record<string, unknown>;
    return {
      ...mapRow(record),
      depth: Number(record.depth),
    } satisfies TodoTreeRow;
  });

  const idMap = new Map<string, string>([[sourceRootId, targetRootId]]);
  for (const source of sourceRows) {
    idMap.set(source.id, newId());
  }

  const now = nowISO();
  const statements: {
    sql: string;
    args: (string | number | null)[];
  }[] = [];

  for (const source of sourceRows) {
    const clonedId = idMap.get(source.id);
    const clonedParentId =
      source.parent_id === null ? targetRootId : idMap.get(source.parent_id);
    if (!clonedId || !clonedParentId) {
      throw new Error("ensureRecurringSubtasksCopied: invalid subtree mapping");
    }
    const clonedTriggerId =
      source.trigger_after_todo_id === null
        ? null
        : idMap.get(source.trigger_after_todo_id) ??
          source.trigger_after_todo_id;

    statements.push(
      {
        sql: `INSERT INTO todos
              (id, user_id, parent_id, title, description, status, position,
               is_frog, frog_date, is_important, is_urgent,
               estimated_minutes, actual_minutes, start_at, due_at, scheduled_date, time,
               trigger_after_todo_id, habit_id, completed_at,
               recurrence_type, recurrence_interval, recurrence_days_of_week,
               recurrence_end_date, recurrence_template_id,
               created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL,
                      ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          clonedId,
          userId,
          clonedParentId,
          source.title,
          source.description,
          source.position,
          0,
          null,
          source.is_frog === 1 ? 1 : source.is_important,
          source.is_frog === 1 ? 1 : source.is_urgent,
          source.estimated_minutes,
          source.start_at,
          source.due_at,
          source.scheduled_date,
          clonedTriggerId,
          source.habit_id,
          source.recurrence_type,
          source.recurrence_interval,
          source.recurrence_days_of_week,
          source.recurrence_end_date,
          source.recurrence_template_id,
          now,
          now,
        ],
      },
      {
        sql: `INSERT INTO todo_tags (todo_id, tag_id)
              SELECT ?, tag_id FROM todo_tags WHERE todo_id = ?`,
        args: [clonedId, source.id],
      }
    );
  }

  await turso.batch(statements, "write");
};

export const uncompleteTodo = async (
  id: string,
  userId: string
): Promise<TodoRow | null> => {
  const now = nowISO();
  const res = await turso.execute({
    sql: `UPDATE todos
          SET status = 'open', completed_at = NULL, updated_at = ?
          WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    args: [now, id, userId],
  });
  if (res.rowsAffected === 0) return null;
  return getTodoByIdScoped(id, userId);
};

export type DeleteTodoResult = {
  deleted_ids: string[];
};

export const softDeleteTodoByScope = async (
  id: string,
  userId: string,
  scope: TodoDeleteScope,
  deletedAt = nowISO()
): Promise<DeleteTodoResult | null> => {
  const target = await getTodoByIdScoped(id, userId);
  if (!target) return null;

  const isRecurring =
    target.recurrence_type !== null || target.recurrence_template_id !== null;
  const seriesId = target.recurrence_template_id ?? target.id;

  let rootsSql =
    "SELECT id FROM todos WHERE id = ? AND user_id = ? AND deleted_at IS NULL";
  let rootsArgs: (string | null)[] = [id, userId];
  let recurrenceCutoff: string | null = null;

  if (isRecurring && scope === "all") {
    rootsSql = `SELECT id FROM todos
                WHERE user_id = ? AND deleted_at IS NULL
                  AND (id = ? OR recurrence_template_id = ?)`;
    rootsArgs = [userId, seriesId, seriesId];
  } else if (isRecurring && scope === "future") {
    if (!target.scheduled_date) throw new TodoRepoError("bad_input");
    rootsSql = `SELECT id FROM todos
                WHERE user_id = ? AND deleted_at IS NULL
                  AND (id = ? OR recurrence_template_id = ?)
                  AND scheduled_date >= ?`;
    rootsArgs = [userId, seriesId, seriesId, target.scheduled_date];
    recurrenceCutoff = addDays(target.scheduled_date, -1);
  }

  const treeRes = await turso.execute({
    sql: `WITH RECURSIVE roots(id) AS (
            ${rootsSql}
          ),
          subtree(id) AS (
            SELECT id FROM roots
            UNION
            SELECT t.id FROM todos t
            INNER JOIN subtree p ON t.parent_id = p.id
            WHERE t.user_id = ? AND t.deleted_at IS NULL
          )
          SELECT id FROM subtree`,
    args: [...rootsArgs, userId],
  });
  const deletedIds = (treeRes.rows as unknown as { id: string }[]).map(
    (row) => row.id
  );

  const statements: {
    sql: string;
    args: (string | null)[];
  }[] = [];

  if (recurrenceCutoff !== null && target.scheduled_date !== null) {
    statements.push({
      sql: `UPDATE todos
            SET recurrence_end_date = CASE
                  WHEN recurrence_end_date IS NULL OR recurrence_end_date > ?
                    THEN ?
                  ELSE recurrence_end_date
                END,
                updated_at = ?
            WHERE user_id = ? AND deleted_at IS NULL
              AND (id = ? OR recurrence_template_id = ?)
              AND scheduled_date < ?
              AND recurrence_type IS NOT NULL`,
      args: [
        recurrenceCutoff,
        recurrenceCutoff,
        deletedAt,
        userId,
        seriesId,
        seriesId,
        target.scheduled_date,
      ],
    });
  }

  statements.push(
    ...deletedIds.map((todoId) => ({
      sql: "UPDATE todos SET deleted_at = ?, updated_at = ? WHERE id = ?",
      args: [deletedAt, deletedAt, todoId],
    }))
  );

  if (statements.length > 0) {
    await turso.batch(statements, "write");
  }
  return { deleted_ids: deletedIds };
};

// Overload: userId tùy chọn (admin web không cần truyền)
// §7.2 Cascade: soft-delete todo → soft-delete mọi subtask đệ quy (parent_id tree)
export const softDeleteTodo = async (
  id: string,
  userId?: string
): Promise<boolean> => {
  const now = nowISO();

  // Verify target tồn tại + thuộc user (nếu có userId scope)
  const checkSql = userId
    ? "SELECT id FROM todos WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    : "SELECT id FROM todos WHERE id = ? AND deleted_at IS NULL";
  const checkArgs = userId ? [id, userId] : [id];
  const check = await turso.execute({ sql: checkSql, args: checkArgs });
  if (check.rows.length === 0) return false;

  // Thu thập toàn bộ ids trong cây con bằng WITH RECURSIVE (libSQL/SQLite 3.8+)
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

  // Batch soft-delete tất cả trong 1 transaction
  const stmts = allIds.map((tid) => ({
    sql: "UPDATE todos SET deleted_at = ?, updated_at = ? WHERE id = ?",
    args: [now, now, tid] as (string | null)[],
  }));
  await turso.batch(stmts, "write");
  return true;
};

export const markFrog = async (
  id: string,
  userId: string,
  date: string
): Promise<TodoRow | null> => {
  return setSingleFrogForDay(id, userId, date);
};

export const setSingleFrogForDay = async (
  id: string,
  userId: string,
  date: string,
  updatedAt = nowISO()
): Promise<TodoRow | null> => {
  const now = nowISO();
  const stamp = updatedAt || now;
  const res = await turso.batch(
    [
      {
        sql: `UPDATE todos
              SET is_frog = 0, frog_date = NULL, updated_at = ?
              WHERE user_id = ?
                AND id <> ?
                AND is_frog = 1
                AND COALESCE(frog_date, scheduled_date) = ?
                AND deleted_at IS NULL`,
        args: [stamp, userId, id, date],
      },
      {
        sql: `UPDATE todos
              SET is_frog = 1,
                  frog_date = ?,
                  is_important = 1,
                  is_urgent = 1,
                  updated_at = ?
              WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        args: [date, stamp, id, userId],
      },
    ],
    "write"
  );
  if ((res[1].rowsAffected ?? 0) === 0) return null;
  return getTodoByIdScoped(id, userId);
};

export const unmarkFrog = async (
  id: string,
  userId: string
): Promise<TodoRow | null> => {
  const now = nowISO();
  const res = await turso.execute({
    sql: `UPDATE todos
          SET is_frog = 0, frog_date = NULL, updated_at = ?
          WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    args: [now, id, userId],
  });
  if (res.rowsAffected === 0) return null;
  return getTodoByIdScoped(id, userId);
};

export const classifyEisenhower = async (
  id: string,
  userId: string,
  isImportant: boolean | null,
  isUrgent: boolean | null
): Promise<TodoRow | null> => {
  const now = nowISO();
  const res = await turso.execute({
    sql: `UPDATE todos
          SET is_important = ?, is_urgent = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    args: [boolToInt(isImportant), boolToInt(isUrgent), now, id, userId],
  });
  if (res.rowsAffected === 0) return null;
  return getTodoByIdScoped(id, userId);
};

// ============================================================
// List / day-list / subtasks / triggers
// ============================================================

type Cursor = { updated_at: string; id: string };

const encodeCursor = (c: Cursor): string =>
  Buffer.from(`${c.updated_at}|${c.id}`, "utf8").toString("base64url");

const decodeCursor = (raw: string): Cursor => {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const idx = decoded.indexOf("|");
  if (idx < 0) throw new Error("bad_cursor");
  const updated_at = decoded.slice(0, idx);
  const id = decoded.slice(idx + 1);
  if (!updated_at || !id) throw new Error("bad_cursor");
  return { updated_at, id };
};

export type ListOpts = {
  cursor?: string;
  limit: number;
  scheduled_date?: string;
  status?: TodoRow["status"];
  is_frog?: boolean;
  parent_id?: string; // "null" → top-level, uuid → children
  q?: string;
  tag?: string;
  tag_id?: string;
  habit_id?: string;
};

export type TodoTagFields = {
  tags: TagRow[];
  tag_ids: string[];
};

export type TodoWithTags = TodoRow & TodoTagFields;

export type ListResult = {
  rows: TodoWithTags[];
  nextCursor: string | null;
};

const attachTagsToRows = async <T extends TodoRow>(
  rows: T[]
): Promise<(T & TodoTagFields)[]> => {
  if (rows.length === 0) return [];
  const tagMap = await listTagsForTodoIds(rows.map((row) => row.id));
  return rows.map((row) => {
    const tags = tagMap.get(row.id) ?? [];
    return {
      ...row,
      tags,
      tag_ids: tags.map((tag) => tag.id),
    };
  });
};

export const listTodosByUser = async (
  userId: string,
  opts: ListOpts | number = { limit: 200 }
): Promise<ListResult | TodoRow[]> => {
  // Backward-compat: nếu gọi với number (admin), trả flat array
  if (typeof opts === "number") {
    const res = await turso.execute({
      sql: `SELECT ${TODO_COLUMNS} FROM todos
            WHERE user_id = ? AND deleted_at IS NULL
            ORDER BY created_at DESC LIMIT ?`,
      args: [userId, opts],
    });
    return (res.rows as unknown as Record<string, unknown>[]).map(mapRow);
  }

  const where: string[] = ["t.user_id = ?", "t.deleted_at IS NULL"];
  const args: (string | number)[] = [userId];
  let join = "";

  if (opts.scheduled_date) {
    where.push("t.scheduled_date = ?");
    args.push(opts.scheduled_date);
  }
  if (opts.status) {
    where.push("t.status = ?");
    args.push(opts.status);
  }
  if (typeof opts.is_frog === "boolean") {
    where.push("t.is_frog = ?");
    args.push(opts.is_frog ? 1 : 0);
  }
  if (opts.parent_id === "null") {
    where.push("t.parent_id IS NULL");
  } else if (opts.parent_id) {
    where.push("t.parent_id = ?");
    args.push(opts.parent_id);
  }
  if (opts.habit_id) {
    where.push("t.habit_id = ?");
    args.push(opts.habit_id);
  }
  if (opts.q) {
    where.push("(t.title LIKE ? OR t.description LIKE ?)");
    const pattern = `%${opts.q}%`;
    args.push(pattern, pattern);
  }
  if (opts.tag_id) {
    join =
      "JOIN todo_tags tt ON tt.todo_id = t.id JOIN tags g ON g.id = tt.tag_id AND g.deleted_at IS NULL";
    where.push("g.id = ? AND g.user_id = ?");
    args.push(opts.tag_id, userId);
  } else if (opts.tag) {
    join =
      "JOIN todo_tags tt ON tt.todo_id = t.id JOIN tags g ON g.id = tt.tag_id AND g.deleted_at IS NULL";
    where.push("g.name = ? COLLATE NOCASE");
    args.push(opts.tag);
  }

  if (opts.cursor) {
    const c = decodeCursor(opts.cursor);
    where.push("(t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))");
    args.push(c.updated_at, c.updated_at, c.id);
  }

  const limitPlus = opts.limit + 1;
  args.push(limitPlus);

  const sql = `SELECT ${TODO_COLUMNS.split(", ").map((c) => `t.${c}`).join(", ")}
               FROM todos t ${join}
               WHERE ${where.join(" AND ")}
               ORDER BY t.is_frog DESC, t.position ASC, t.updated_at DESC, t.id DESC
               LIMIT ?`;

  const res = await turso.execute({ sql, args });
  const raw = (res.rows as unknown as Record<string, unknown>[]).map(mapRow);

  let nextCursor: string | null = null;
  let rows = raw;
  if (raw.length > opts.limit) {
    rows = raw.slice(0, opts.limit);
    const last = rows[rows.length - 1];
    nextCursor = encodeCursor({ updated_at: last.updated_at, id: last.id });
  }
  return { rows: await attachTagsToRows(rows), nextCursor };
};

export type DayTopLevelRow = TodoRow & TodoTagFields & { has_subtasks: number };

export const listDayTopLevel = async (
  userId: string,
  date: string
): Promise<DayTopLevelRow[]> => {
  const res = await turso.execute({
    sql: `SELECT ${TODO_COLUMNS.split(", ").map((c) => `t.${c}`).join(", ")},
                 (CASE WHEN EXISTS (
                    SELECT 1 FROM todos s
                    WHERE s.parent_id = t.id AND s.deleted_at IS NULL
                  ) THEN 1 ELSE 0 END) AS has_subtasks
          FROM todos t
          WHERE t.user_id = ? AND t.scheduled_date = ?
            AND t.parent_id IS NULL AND t.deleted_at IS NULL
          ORDER BY t.is_frog DESC, t.position ASC, t.updated_at DESC`,
    args: [userId, date],
  });
  const rows = (res.rows as unknown as Record<string, unknown>[]).map((r) => ({
    ...mapRow(r),
    has_subtasks: Number(r.has_subtasks),
  }));
  return attachTagsToRows(rows);
};

export const listSubtasks = async (
  parentId: string,
  userId: string
): Promise<TodoRow[]> => {
  const res = await turso.execute({
    sql: `SELECT ${TODO_COLUMNS} FROM todos
          WHERE parent_id = ? AND user_id = ? AND deleted_at IS NULL
          ORDER BY position ASC, created_at ASC`,
    args: [parentId, userId],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapRow);
};

export const listTriggeredTodos = async (
  triggerId: string,
  userId: string
): Promise<TodoRow[]> => {
  const res = await turso.execute({
    sql: `SELECT ${TODO_COLUMNS} FROM todos
          WHERE trigger_after_todo_id = ? AND user_id = ?
            AND status != 'done' AND deleted_at IS NULL
          ORDER BY position ASC, created_at ASC`,
    args: [triggerId, userId],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapRow);
};

export const listTodosByHabitDate = async (
  userId: string,
  habitId: string,
  scheduledDate: string
): Promise<TodoRow[]> => {
  const res = await turso.execute({
    sql: `SELECT ${TODO_COLUMNS} FROM todos
          WHERE user_id = ?
            AND habit_id = ?
            AND scheduled_date = ?
            AND deleted_at IS NULL
          ORDER BY position ASC, created_at ASC`,
    args: [userId, habitId, scheduledDate],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapRow);
};

// ============================================================
// Tags
// ============================================================

export const attachTagToTodo = async (
  todoId: string,
  tagId: string,
  userId: string
): Promise<boolean> => {
  const now = nowISO();
  try {
    // Verify ownership bằng SELECT trước
    const check = await turso.execute({
      sql: `SELECT t.id FROM todos t, tags g
            WHERE t.id = ? AND t.user_id = ? AND t.deleted_at IS NULL
              AND g.id = ? AND g.user_id = ? AND g.deleted_at IS NULL`,
      args: [todoId, userId, tagId, userId],
    });
    if (check.rows.length === 0) throw new TodoRepoError("not_found");

    // INSERT junction + bump parent updated_at trong 1 batch
    await turso.batch(
      [
        {
          sql: "INSERT INTO todo_tags (todo_id, tag_id) VALUES (?, ?)",
          args: [todoId, tagId],
        },
        {
          sql: "UPDATE todos SET updated_at = ? WHERE id = ?",
          args: [now, todoId],
        },
      ],
      "write"
    );
    return true;
  } catch (e) {
    if (e instanceof TodoRepoError) throw e;
    if (isUniqueViolation(e)) return false; // idempotent
    throw e;
  }
};

export const detachTagFromTodo = async (
  todoId: string,
  tagId: string,
  userId: string
): Promise<boolean> => {
  const now = nowISO();
  // Verify ownership
  const check = await turso.execute({
    sql: "SELECT id FROM todos WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    args: [todoId, userId],
  });
  if (check.rows.length === 0) return false;

  const res = await turso.batch(
    [
      {
        sql: "DELETE FROM todo_tags WHERE todo_id = ? AND tag_id = ?",
        args: [todoId, tagId],
      },
      {
        sql: "UPDATE todos SET updated_at = ? WHERE id = ?",
        args: [now, todoId],
      },
    ],
    "write"
  );
  return (res[0].rowsAffected ?? 0) > 0;
};

export const replaceTodoTags = async (
  todoId: string,
  tagIds: string[],
  userId: string
): Promise<boolean> => {
  const uniqueTagIds = [...new Set(tagIds)];
  const todoRes = await turso.execute({
    sql: "SELECT id FROM todos WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    args: [todoId, userId],
  });
  if (todoRes.rows.length === 0) return false;

  if (uniqueTagIds.length > 0) {
    const placeholders = uniqueTagIds.map(() => "?").join(", ");
    const tagRes = await turso.execute({
      sql: `SELECT COUNT(*) AS c FROM tags
            WHERE user_id = ?
              AND deleted_at IS NULL
              AND id IN (${placeholders})`,
      args: [userId, ...uniqueTagIds],
    });
    if (Number((tagRes.rows[0] as unknown as Record<string, unknown>).c) !== uniqueTagIds.length) {
      return false;
    }
  }

  const now = nowISO();
  const stmts: { sql: string; args: (string | number | null)[] }[] = [
    {
      sql: "DELETE FROM todo_tags WHERE todo_id = ?",
      args: [todoId],
    },
    ...uniqueTagIds.map((tagId) => ({
      sql: "INSERT OR IGNORE INTO todo_tags (todo_id, tag_id) VALUES (?, ?)",
      args: [todoId, tagId] as (string | number | null)[],
    })),
    {
      sql: "UPDATE todos SET updated_at = ? WHERE id = ?",
      args: [now, todoId],
    },
  ];
  await turso.batch(stmts, "write");
  return true;
};

export const listTagsForTodoIds = async (
  todoIds: string[]
): Promise<Map<string, TagRow[]>> => {
  const map = new Map<string, TagRow[]>();
  if (todoIds.length === 0) return map;
  const placeholders = todoIds.map(() => "?").join(", ");
  const res = await turso.execute({
    sql: `SELECT
            tt.todo_id,
            g.id,
            g.user_id,
            g.name,
            g.color,
            g.created_at,
            g.updated_at,
            g.deleted_at
          FROM todo_tags tt
          JOIN tags g ON g.id = tt.tag_id
          WHERE tt.todo_id IN (${placeholders})
            AND g.deleted_at IS NULL
          ORDER BY g.name COLLATE NOCASE ASC`,
    args: todoIds,
  });
  for (const row of res.rows as unknown as Record<string, unknown>[]) {
    const todoId = row.todo_id as string;
    const tags = map.get(todoId) ?? [];
    tags.push(mapTagRow(row));
    map.set(todoId, tags);
  }
  return map;
};

export const getTodoWithTags = async (
  id: string,
  userId: string
): Promise<TodoWithTags | null> => {
  const todo = await getTodoByIdScoped(id, userId);
  if (!todo) return null;
  const rows = await attachTagsToRows([todo]);
  return rows[0] ?? null;
};

export const listTodoTags = async (todoId: string): Promise<TagRow[]> => {
  const res = await turso.execute({
    sql: `SELECT g.id, g.user_id, g.name, g.color, g.created_at, g.updated_at, g.deleted_at
          FROM todo_tags tt
          JOIN tags g ON g.id = tt.tag_id
          WHERE tt.todo_id = ? AND g.deleted_at IS NULL
          ORDER BY g.name COLLATE NOCASE ASC`,
    args: [todoId],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapTagRow);
};

// ============================================================
// Relations bundle
// ============================================================

export type LinkedNote = { id: string; title: string };

export type TodoWithRelations = {
  todo: TodoRow;
  tags: TagRow[];
  tag_ids: string[];
  subtasks: TodoRow[];
  linked_notes: LinkedNote[];
};

export const getTodoWithRelations = async (
  id: string,
  userId: string
): Promise<TodoWithRelations | null> => {
  const todo = await getTodoByIdScoped(id, userId);
  if (!todo) return null;
  const [tags, subtasks, linkedNotesRes] = await Promise.all([
    listTodoTags(id),
    listSubtasks(id, userId),
    turso.execute({
      sql: `SELECT n.id, n.title
            FROM note_todo_links l
            JOIN notes n ON n.id = l.note_id
            WHERE l.todo_id = ? AND n.deleted_at IS NULL`,
      args: [id],
    }),
  ]);
  const linked_notes = (linkedNotesRes.rows as unknown as Record<string, unknown>[]).map(
    (r) => ({ id: r.id as string, title: r.title as string })
  );
  return { todo, tags, tag_ids: tags.map((tag) => tag.id), subtasks, linked_notes };
};

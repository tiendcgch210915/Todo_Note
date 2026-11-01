import { turso } from "../config/db.js";

export type DayTodoStat = {
  id: string;
  title: string;
  status: string;
  scheduled_date: string | null;
  time: string | null;
  due_at: string | null;
  completed_at: string | null;
  is_important: number | null;
  is_urgent: number | null;
  is_frog: number;
  frog_date: string | null;
};

const mapStat = (row: Record<string, unknown>): DayTodoStat => ({
  id: row.id as string,
  title: row.title as string,
  status: row.status as string,
  scheduled_date: (row.scheduled_date as string | null) ?? null,
  time: (row.time as string | null) ?? null,
  due_at: (row.due_at as string | null) ?? null,
  completed_at: (row.completed_at as string | null) ?? null,
  is_important: row.is_important === null ? null : Number(row.is_important),
  is_urgent: row.is_urgent === null ? null : Number(row.is_urgent),
  is_frog: Number(row.is_frog),
  frog_date: (row.frog_date as string | null) ?? null,
});

// Top-level todos của ngày D (cho dashboard today + eisenhower)
export const listDayTopLevelStats = async (
  userId: string,
  date: string
): Promise<DayTodoStat[]> => {
  const res = await turso.execute({
    sql: `SELECT id, title, status, scheduled_date, time, due_at, completed_at,
                 is_important, is_urgent, is_frog, frog_date
          FROM todos
          WHERE user_id = ? AND scheduled_date = ?
            AND parent_id IS NULL
            AND status != 'archived'
            AND deleted_at IS NULL`,
    args: [userId, date],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapStat);
};

export type SubtaskNode = {
  status: string;
  completed_at: string | null;
  subtasks: SubtaskNode[];
};

// Live subtasks (any depth) of the given top-level todos, as trees keyed by top-level id.
export const listSubtaskTrees = async (
  userId: string,
  rootIds: string[]
): Promise<Map<string, SubtaskNode[]>> => {
  const trees = new Map<string, SubtaskNode[]>();
  if (rootIds.length === 0) return trees;
  const res = await turso.execute({
    sql: `WITH RECURSIVE sub(id, parent_id, status, completed_at) AS (
            SELECT id, parent_id, status, completed_at FROM todos
            WHERE user_id = ? AND parent_id IN (SELECT value FROM json_each(?))
              AND status != 'archived' AND deleted_at IS NULL
            UNION
            SELECT t.id, t.parent_id, t.status, t.completed_at FROM todos t
            JOIN sub ON t.parent_id = sub.id
            WHERE t.user_id = ? AND t.status != 'archived' AND t.deleted_at IS NULL
          )
          SELECT id, parent_id, status, completed_at FROM sub`,
    args: [userId, JSON.stringify(rootIds), userId],
  });
  const rows = res.rows as unknown as Record<string, unknown>[];
  const nodes = new Map<string, SubtaskNode>();
  for (const row of rows) {
    nodes.set(row.id as string, {
      status: row.status as string,
      completed_at: (row.completed_at as string | null) ?? null,
      subtasks: [],
    });
  }
  for (const row of rows) {
    const node = nodes.get(row.id as string)!;
    const parentId = row.parent_id as string;
    const parent = nodes.get(parentId);
    if (parent) parent.subtasks.push(node);
    else trees.set(parentId, [...(trees.get(parentId) ?? []), node]);
  }
  return trees;
};

export type DayScorableTodo = DayTodoStat & { subtasks: SubtaskNode[] };

// Top-level todos của ngày D kèm cây subtask, đủ để tính điểm.
export const listDayScorableTodos = async (
  userId: string,
  date: string
): Promise<DayScorableTodo[]> => {
  const todos = await listDayTopLevelStats(userId, date);
  const trees = await listSubtaskTrees(
    userId,
    todos.map((todo) => todo.id)
  );
  return todos.map((todo) => ({ ...todo, subtasks: trees.get(todo.id) ?? [] }));
};

// Habits active trong ngày D + log của ngày D
export const countDayHabits = async (
  userId: string,
  date: string
): Promise<{ total: number; completed: number }> => {
  const res = await turso.execute({
    sql: `SELECT
            COUNT(DISTINCT h.id) AS total,
            COUNT(DISTINCT CASE WHEN l.completed = 1 THEN h.id END) AS completed
          FROM habits h
          LEFT JOIN habit_logs l ON l.habit_id = h.id AND l.log_date = ?
          WHERE h.user_id = ?
            AND h.deleted_at IS NULL
            AND h.is_archived = 0
            AND h.start_date <= ?
            AND (h.end_date IS NULL OR h.end_date >= ?)`,
    args: [date, userId, date, date],
  });
  const row = res.rows[0] as unknown as Record<string, unknown>;
  return {
    total: Number(row.total),
    completed: Number(row.completed),
  };
};

export const getFrogForDay = async (
  userId: string,
  date: string
): Promise<{ id: string; title: string; status: string } | null> => {
  const res = await turso.execute({
    sql: `SELECT id, title, status FROM todos
          WHERE user_id = ? AND is_frog = 1 AND frog_date = ?
            AND parent_id IS NULL AND deleted_at IS NULL
          ORDER BY position ASC LIMIT 1`,
    args: [userId, date],
  });
  if (res.rows.length === 0) return null;
  const r = res.rows[0] as unknown as Record<string, unknown>;
  return {
    id: r.id as string,
    title: r.title as string,
    status: r.status as string,
  };
};

// Range queries (cho calendar overview)
export const countTodosByDay = async (
  userId: string,
  from: string,
  to: string
): Promise<{ date: string; total_todos: number; timed_todos: number; done_todos: number }[]> => {
  const res = await turso.execute({
    sql: `SELECT scheduled_date, COUNT(*) AS total, COUNT(time) AS timed,
                 SUM(status = 'done') AS done
          FROM todos
          WHERE user_id = ? AND scheduled_date BETWEEN ? AND ?
            AND parent_id IS NULL
            AND status != 'archived'
            AND deleted_at IS NULL
          GROUP BY scheduled_date`,
    args: [userId, from, to],
  });
  return res.rows.map((r) => ({
    date: String(r.scheduled_date),
    total_todos: Number(r.total),
    timed_todos: Number(r.timed),
    done_todos: Number(r.done),
  }));
};

export const activeHabitsInRange = async (
  userId: string,
  from: string,
  to: string
): Promise<{ id: string; start_date: string; end_date: string | null }[]> => {
  const res = await turso.execute({
    sql: `SELECT id, start_date, end_date FROM habits
          WHERE user_id = ?
            AND deleted_at IS NULL
            AND is_archived = 0
            AND start_date <= ?
            AND (end_date IS NULL OR end_date >= ?)`,
    args: [userId, to, from],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    start_date: r.start_date as string,
    end_date: (r.end_date as string | null) ?? null,
  }));
};

export const countCompletedHabitsByDay = async (
  userId: string,
  from: string,
  to: string
): Promise<{ date: string; completed: number }[]> => {
  const res = await turso.execute({
    sql: `SELECT l.log_date, COUNT(DISTINCT l.habit_id) AS completed
          FROM habit_logs l
          JOIN habits h ON h.id = l.habit_id
          WHERE h.user_id = ?
            AND h.deleted_at IS NULL
            AND l.completed = 1 AND l.log_date BETWEEN ? AND ?
          GROUP BY l.log_date`,
    args: [userId, from, to],
  });
  return res.rows.map((r) => ({
    date: String(r.log_date),
    completed: Number(r.completed),
  }));
};

import { turso } from "../config/db.js";
import { newId } from "../utils/id.js";
import type { TodoRow } from "./todos.js";

export type DailyTodoSnapshotRow = Pick<
  TodoRow,
  | "id"
  | "user_id"
  | "title"
  | "description"
  | "status"
  | "position"
  | "is_frog"
  | "frog_date"
  | "is_important"
  | "is_urgent"
  | "estimated_minutes"
  | "actual_minutes"
  | "due_at"
  | "scheduled_date"
  | "time"
  | "completed_at"
  | "created_at"
  | "updated_at"
>;

export type DailyTodoLogInput = {
  user_id: string;
  log_date: string;
  todo_id: string;
  title: string;
  description: string | null;
  status: TodoRow["status"];
  completed: number;
  completed_at: string | null;
  scheduled_date: string | null;
  time: string | null;
  due_at: string | null;
  is_important: number | null;
  is_urgent: number | null;
  is_frog: number;
  frog_date: string | null;
  estimated_minutes: number | null;
  actual_minutes: number | null;
  position: number;
  todo_created_at: string;
  todo_updated_at: string;
};

export type DailyTodoLogRow = DailyTodoLogInput & {
  id: string;
  logged_at: string;
  created_at: string;
  updated_at: string;
};

export type DailyTodoSummaryRow = {
  user_id: string;
  log_date: string;
  total_todos: number;
  done_todos: number;
  score: number;
  closed_at: string;
  created_at: string;
  updated_at: string;
};

const nullableNum = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

const mapSnapshotRow = (
  row: Record<string, unknown>
): DailyTodoSnapshotRow => ({
  id: row.id as string,
  user_id: row.user_id as string,
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
  due_at: (row.due_at as string | null) ?? null,
  scheduled_date: (row.scheduled_date as string | null) ?? null,
  time: (row.time as string | null) ?? null,
  completed_at: (row.completed_at as string | null) ?? null,
  created_at: row.created_at as string,
  updated_at: row.updated_at as string,
});

const mapLogRow = (row: Record<string, unknown>): DailyTodoLogRow => ({
  id: row.id as string,
  user_id: row.user_id as string,
  log_date: row.log_date as string,
  todo_id: row.todo_id as string,
  title: row.title as string,
  description: (row.description as string | null) ?? null,
  status: row.status as TodoRow["status"],
  completed: Number(row.completed),
  completed_at: (row.completed_at as string | null) ?? null,
  scheduled_date: (row.scheduled_date as string | null) ?? null,
  time: (row.time as string | null) ?? null,
  due_at: (row.due_at as string | null) ?? null,
  is_important: nullableNum(row.is_important),
  is_urgent: nullableNum(row.is_urgent),
  is_frog: Number(row.is_frog),
  frog_date: (row.frog_date as string | null) ?? null,
  estimated_minutes: nullableNum(row.estimated_minutes),
  actual_minutes: nullableNum(row.actual_minutes),
  position: Number(row.position),
  todo_created_at: row.todo_created_at as string,
  todo_updated_at: row.todo_updated_at as string,
  logged_at: row.logged_at as string,
  created_at: row.created_at as string,
  updated_at: row.updated_at as string,
});

const mapSummaryRow = (
  row: Record<string, unknown>
): DailyTodoSummaryRow => ({
  user_id: row.user_id as string,
  log_date: row.log_date as string,
  total_todos: Number(row.total_todos),
  done_todos: Number(row.done_todos),
  score: Number(row.score),
  closed_at: row.closed_at as string,
  created_at: row.created_at as string,
  updated_at: row.updated_at as string,
});

export const getDailyTodoSummary = async (
  userId: string,
  date: string
): Promise<DailyTodoSummaryRow | null> => {
  const res = await turso.execute({
    sql: `SELECT user_id, log_date, total_todos, done_todos, score,
                 closed_at, created_at, updated_at
          FROM daily_todo_summaries
          WHERE user_id = ? AND log_date = ?`,
    args: [userId, date],
  });
  if (res.rows.length === 0) return null;
  return mapSummaryRow(res.rows[0] as unknown as Record<string, unknown>);
};

export const listDailyTodoSummariesInRange = async (
  userId: string,
  from: string,
  to: string
): Promise<DailyTodoSummaryRow[]> => {
  const res = await turso.execute({
    sql: `SELECT user_id, log_date, total_todos, done_todos, score,
                 closed_at, created_at, updated_at
          FROM daily_todo_summaries
          WHERE user_id = ? AND log_date BETWEEN ? AND ?
          ORDER BY log_date ASC`,
    args: [userId, from, to],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapSummaryRow);
};

export const listDailyTodoLogs = async (
  userId: string,
  date: string
): Promise<DailyTodoLogRow[]> => {
  const res = await turso.execute({
    sql: `SELECT id, user_id, log_date, todo_id, title, description, status,
                 completed, completed_at, scheduled_date, time, due_at,
                 is_important, is_urgent, is_frog, frog_date,
                 estimated_minutes, actual_minutes, position,
                 todo_created_at, todo_updated_at, logged_at, created_at, updated_at
          FROM daily_todo_logs
          WHERE user_id = ? AND log_date = ?
          ORDER BY is_frog DESC, position ASC, todo_created_at ASC, todo_id ASC`,
    args: [userId, date],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapLogRow);
};

export const countTimedLogsInRange = async (
  userId: string,
  from: string,
  to: string
): Promise<Map<string, number>> => {
  const res = await turso.execute({
    sql: `SELECT log_date, COUNT(*) AS timed FROM daily_todo_logs
          WHERE user_id = ? AND log_date BETWEEN ? AND ? AND time IS NOT NULL
          GROUP BY log_date`,
    args: [userId, from, to],
  });
  return new Map(res.rows.map((r) => [String(r.log_date), Number(r.timed)]));
};

export const listTodoSnapshotsForDailyClose = async (
  userId: string,
  date: string
): Promise<DailyTodoSnapshotRow[]> => {
  const res = await turso.execute({
    sql: `SELECT id, user_id, title, description, status, position,
                 is_frog, frog_date, is_important, is_urgent,
                 estimated_minutes, actual_minutes, due_at, scheduled_date,
                 time, completed_at, created_at, updated_at
          FROM todos
          WHERE user_id = ?
            AND scheduled_date = ?
            AND parent_id IS NULL
            AND status != 'archived'
            AND deleted_at IS NULL
          ORDER BY is_frog DESC, position ASC, created_at ASC, id ASC`,
    args: [userId, date],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapSnapshotRow);
};

// scheduled_date of the top-level todo that `todoId` hangs under (itself when top-level).
export const getRootScheduledDate = async (
  userId: string,
  todoId: string
): Promise<string | null> => {
  const res = await turso.execute({
    sql: `WITH RECURSIVE up(id, parent_id, scheduled_date) AS (
            SELECT id, parent_id, scheduled_date FROM todos WHERE id = ? AND user_id = ?
            UNION
            SELECT t.id, t.parent_id, t.scheduled_date FROM todos t
            JOIN up ON t.id = up.parent_id WHERE t.user_id = ?
          )
          SELECT scheduled_date FROM up WHERE parent_id IS NULL LIMIT 1`,
    args: [todoId, userId, userId],
  });
  if (res.rows.length === 0) return null;
  return ((res.rows[0] as unknown as Record<string, unknown>).scheduled_date as string | null) ?? null;
};

// No top-level todos means no log rows and a zero score, regardless of habits.
// The check and insert share a statement so a concurrent close cannot replace a snapshot.
export const closeEmptyTodoDays = async (
  userId: string,
  dates: string[],
  closedAt: string
): Promise<DailyTodoSummaryRow[]> => {
  const res = await turso.execute({
    sql: `INSERT INTO daily_todo_summaries
          (user_id, log_date, total_todos, done_todos, score, closed_at, created_at, updated_at)
          SELECT ?, d.value, 0, 0, 0, ?, ?, ? FROM json_each(?) d
          WHERE NOT EXISTS (
            SELECT 1 FROM todos WHERE user_id = ? AND scheduled_date = d.value
              AND parent_id IS NULL AND status != 'archived' AND deleted_at IS NULL
          )
          ON CONFLICT(user_id, log_date) DO NOTHING RETURNING *`,
    args: [userId, closedAt, closedAt, closedAt, JSON.stringify(dates), userId],
  });
  return res.rows.map(mapSummaryRow);
};

export const insertDailyTodoClose = async (input: {
  userId: string;
  date: string;
  logs: DailyTodoLogInput[];
  totalTodos: number;
  doneTodos: number;
  score: number;
  closedAt: string;
}): Promise<DailyTodoSummaryRow> => {
  const statements: { sql: string; args: (string | number | null)[] }[] = [];
  // 40 rows × 24 values plus two guard parameters fit the 999-variable limit.
  const chunkSize = 40;
  const tuple = `(${Array(24).fill("?").join(", ")})`;
  for (let i = 0; i < input.logs.length; i += chunkSize) {
    const chunk = input.logs.slice(i, i + chunkSize);
    const args = chunk.flatMap((log) => [
      newId(), log.user_id, log.log_date, log.todo_id, log.title, log.description,
      log.status, log.completed, log.completed_at, log.scheduled_date, log.time,
      log.due_at, log.is_important, log.is_urgent, log.is_frog, log.frog_date,
      log.estimated_minutes, log.actual_minutes, log.position, log.todo_created_at,
      log.todo_updated_at, input.closedAt, input.closedAt, input.closedAt,
    ]);
    statements.push({
      sql: `WITH snapshots AS (VALUES ${chunk.map(() => tuple).join(", ")})
            INSERT OR IGNORE INTO daily_todo_logs
            (id, user_id, log_date, todo_id, title, description, status,
             completed, completed_at, scheduled_date, time, due_at,
             is_important, is_urgent, is_frog, frog_date,
             estimated_minutes, actual_minutes, position,
             todo_created_at, todo_updated_at, logged_at, created_at, updated_at)
            SELECT * FROM snapshots WHERE NOT EXISTS (
              SELECT 1 FROM daily_todo_summaries WHERE user_id = ? AND log_date = ?
            )`,
      args: [...args, input.userId, input.date],
    });
  }

  statements.push({
    sql: `INSERT OR IGNORE INTO daily_todo_summaries
          (user_id, log_date, total_todos, done_todos, score,
           closed_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.userId,
      input.date,
      input.totalTodos,
      input.doneTodos,
      input.score,
      input.closedAt,
      input.closedAt,
      input.closedAt,
    ],
  });

  // A concurrent closer may have won. Return the summary committed with its logs.
  statements.push({
    sql: "SELECT * FROM daily_todo_summaries WHERE user_id = ? AND log_date = ?",
    args: [input.userId, input.date],
  });
  const results = await turso.batch(statements, "write");
  return mapSummaryRow(results[results.length - 1].rows[0]);
};

export const listUserIdsWithTodosForDate = async (
  date: string
): Promise<string[]> => {
  const res = await turso.execute({
    sql: `SELECT DISTINCT user_id
          FROM todos
          WHERE scheduled_date = ?
            AND parent_id IS NULL
            AND status != 'archived'
            AND deleted_at IS NULL
          ORDER BY user_id ASC`,
    args: [date],
  });
  return (res.rows as unknown as { user_id: string }[]).map(
    (row) => row.user_id
  );
};

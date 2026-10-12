import { turso } from "../config/db.js";
import { newId } from "../utils/id.js";
import { addDays, dayDiff, nowISO, todayDate } from "../utils/time.js";

export type HabitRow = {
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
  checklist_template_id: string | null;
  current_streak: number;
  longest_streak: number;
  is_archived: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type HabitLogRow = {
  id: string;
  habit_id: string;
  log_date: string;
  completed: number;
  note: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

const HABIT_COLUMNS =
  "id, user_id, title, description, icon, color, frequency_type, target_per_period, " +
  "active_weekdays, start_date, end_date, checklist_template_id, current_streak, " +
  "longest_streak, is_archived, created_at, updated_at, deleted_at";

const LOG_COLUMNS = "id, habit_id, log_date, completed, note, created_at, updated_at, deleted_at";

const mapHabit = (row: Record<string, unknown>): HabitRow => ({
  id: row.id as string,
  user_id: row.user_id as string,
  title: row.title as string,
  description: (row.description as string | null) ?? null,
  icon: (row.icon as string | null) ?? null,
  color: row.color as string,
  frequency_type: row.frequency_type as HabitRow["frequency_type"],
  target_per_period: Number(row.target_per_period),
  active_weekdays: (row.active_weekdays as string | null) ?? null,
  start_date: row.start_date as string,
  end_date: (row.end_date as string | null) ?? null,
  checklist_template_id: (row.checklist_template_id as string | null) ?? null,
  current_streak: Number(row.current_streak),
  longest_streak: Number(row.longest_streak),
  is_archived: Number(row.is_archived),
  created_at: row.created_at as string,
  updated_at: row.updated_at as string,
  deleted_at: (row.deleted_at as string | null) ?? null,
});

const mapLog = (row: Record<string, unknown>): HabitLogRow => ({
  id: row.id as string,
  habit_id: row.habit_id as string,
  log_date: row.log_date as string,
  completed: Number(row.completed),
  note: (row.note as string | null) ?? null,
  created_at: row.created_at as string,
  updated_at: (row.updated_at as string | null) ?? (row.created_at as string),
  deleted_at: (row.deleted_at as string | null) ?? null,
});

export class HabitRepoError extends Error {
  constructor(public code: "not_found" | "archived" | "invalid_range") {
    super(code);
  }
}

// ============================================================
// Habit CRUD
// ============================================================

export type CreateHabitDb = {
  user_id: string;
  title: string;
  description?: string | null;
  icon?: string | null;
  color?: string;
  frequency_type?: HabitRow["frequency_type"];
  target_per_period?: number;
  active_weekdays?: string | null;
  start_date: string;
  end_date?: string | null;
  checklist_template_id?: string | null;
};

export const createHabit = async (input: CreateHabitDb): Promise<HabitRow> => {
  const id = newId();
  const now = nowISO();
  await turso.execute({
    sql: `INSERT INTO habits
          (id, user_id, title, description, icon, color, frequency_type,
           target_per_period, active_weekdays, start_date, end_date,
           checklist_template_id,
           current_streak, longest_streak, is_archived, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
    args: [
      id,
      input.user_id,
      input.title,
      input.description ?? null,
      input.icon ?? null,
      input.color ?? "#4CAF50",
      input.frequency_type ?? "daily",
      input.target_per_period ?? 1,
      input.active_weekdays ?? null,
      input.start_date,
      input.end_date ?? null,
      input.checklist_template_id ?? null,
      now,
      now,
    ],
  });
  const row = await getHabitByIdAny(id);
  if (!row) throw new Error("createHabit: row missing");
  return row;
};

const getHabitByIdAny = async (id: string): Promise<HabitRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${HABIT_COLUMNS} FROM habits WHERE id = ?`,
    args: [id],
  });
  if (res.rows.length === 0) return null;
  return mapHabit(res.rows[0] as unknown as Record<string, unknown>);
};

export const getHabitById = async (
  id: string,
  userId: string
): Promise<HabitRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${HABIT_COLUMNS} FROM habits
          WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    args: [id, userId],
  });
  if (res.rows.length === 0) return null;
  return mapHabit(res.rows[0] as unknown as Record<string, unknown>);
};

export type UpdateHabitPatch = Partial<{
  title: string;
  description: string | null;
  icon: string | null;
  color: string;
  frequency_type: HabitRow["frequency_type"];
  target_per_period: number;
  active_weekdays: string | null;
  start_date: string;
  end_date: string | null;
  checklist_template_id: string | null;
  is_archived: boolean;
}>;

export const updateHabit = async (
  id: string,
  userId: string,
  patch: UpdateHabitPatch
): Promise<HabitRow | null> => {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const push = (s: string, v: string | number | null) => {
    sets.push(s);
    args.push(v);
  };
  if (patch.title !== undefined) push("title = ?", patch.title);
  if (patch.description !== undefined) push("description = ?", patch.description);
  if (patch.icon !== undefined) push("icon = ?", patch.icon);
  if (patch.color !== undefined) push("color = ?", patch.color);
  if (patch.frequency_type !== undefined) push("frequency_type = ?", patch.frequency_type);
  if (patch.target_per_period !== undefined)
    push("target_per_period = ?", patch.target_per_period);
  if (patch.active_weekdays !== undefined)
    push("active_weekdays = ?", patch.active_weekdays);
  if (patch.start_date !== undefined) push("start_date = ?", patch.start_date);
  if (patch.end_date !== undefined) push("end_date = ?", patch.end_date);
  if (patch.checklist_template_id !== undefined)
    push("checklist_template_id = ?", patch.checklist_template_id);
  if (patch.is_archived !== undefined)
    push("is_archived = ?", patch.is_archived ? 1 : 0);

  if (sets.length === 0) return getHabitById(id, userId);
  sets.push("updated_at = ?");
  args.push(nowISO());
  args.push(id, userId);

  const res = await turso.execute({
    sql: `UPDATE habits SET ${sets.join(", ")}
          WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    args,
  });
  if (res.rowsAffected === 0) return null;
  return getHabitById(id, userId);
};

export const softDeleteHabit = async (
  id: string,
  userId: string
): Promise<boolean> => {
  const now = nowISO();
  // §7.2 Cascade soft-delete: habit → habit_logs trong cùng transaction
  const res = await turso.batch(
    [
      {
        sql: `UPDATE habits SET deleted_at = ?, updated_at = ?
              WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        args: [now, now, id, userId],
      },
      {
        sql: `UPDATE habit_logs SET deleted_at = ?, updated_at = ?
              WHERE habit_id = ? AND deleted_at IS NULL`,
        args: [now, now, id],
      },
    ],
    "write"
  );
  return (res[0].rowsAffected ?? 0) > 0;
};

export const listHabitsByUser = async (
  userId: string,
  opts: { include_archived: boolean }
): Promise<HabitRow[]> => {
  const sql = opts.include_archived
    ? `SELECT ${HABIT_COLUMNS} FROM habits
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY is_archived ASC, created_at DESC`
    : `SELECT ${HABIT_COLUMNS} FROM habits
       WHERE user_id = ? AND deleted_at IS NULL AND is_archived = 0
       ORDER BY created_at DESC`;
  const res = await turso.execute({ sql, args: [userId] });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapHabit);
};

/**
 * Habit đang hoạt động (chưa xóa, chưa archive) của `userId` gắn với checklist
 * `templateId` — những habit được tự tick khi một run của checklist đó hoàn thành.
 */
export const listLinkedHabits = async (
  userId: string,
  templateId: string
): Promise<HabitRow[]> => {
  const res = await turso.execute({
    sql: `SELECT ${HABIT_COLUMNS} FROM habits
          WHERE user_id = ? AND checklist_template_id = ?
            AND deleted_at IS NULL AND is_archived = 0`,
    args: [userId, templateId],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapHabit);
};

// ============================================================
// Logs
// ============================================================

export const upsertLog = async (
  habitId: string,
  logDate: string,
  completed: boolean,
  note: string | null
): Promise<HabitLogRow> => {
  const now = nowISO();
  // §3.5 Resurrect: nếu row dead (deleted_at != NULL) → dọn sạch và ghi lại
  // ON CONFLICT luôn set updated_at = now và deleted_at = NULL (resurrect)
  await turso.execute({
    sql: `INSERT INTO habit_logs (id, habit_id, log_date, completed, note, created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(habit_id, log_date) DO UPDATE SET
            completed = excluded.completed,
            note = excluded.note,
            updated_at = excluded.updated_at,
            deleted_at = NULL,
            auto_closed = 0`,
    args: [newId(), habitId, logDate, completed ? 1 : 0, note, now, now],
  });
  const row = await getLog(habitId, logDate);
  if (!row) throw new Error("upsertLog: row missing");
  return row;
};

export const upsertAutoLog = async (
  habitId: string,
  logDate: string,
  completed: boolean
): Promise<HabitLogRow> => {
  const now = nowISO();
  await turso.execute({
    sql: `INSERT INTO habit_logs (id, habit_id, log_date, completed, note, created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)
          ON CONFLICT(habit_id, log_date) DO UPDATE SET
            completed = excluded.completed,
            updated_at = excluded.updated_at,
            deleted_at = NULL,
            auto_closed = 0`,
    args: [newId(), habitId, logDate, completed ? 1 : 0, now, now],
  });
  const row = await getLog(habitId, logDate);
  if (!row) throw new Error("upsertAutoLog: row missing");
  return row;
};

export const getLog = async (
  habitId: string,
  logDate: string
): Promise<HabitLogRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${LOG_COLUMNS} FROM habit_logs
          WHERE habit_id = ? AND log_date = ? AND deleted_at IS NULL`,
    args: [habitId, logDate],
  });
  if (res.rows.length === 0) return null;
  return mapLog(res.rows[0] as unknown as Record<string, unknown>);
};

export const deleteLog = async (
  habitId: string,
  logDate: string
): Promise<boolean> => {
  const now = nowISO();
  const res = await turso.execute({
    sql: `UPDATE habit_logs SET deleted_at = ?, updated_at = ?
          WHERE habit_id = ? AND log_date = ? AND deleted_at IS NULL`,
    args: [now, now, habitId, logDate],
  });
  return res.rowsAffected > 0;
};

export const listLogsInRange = async (
  habitId: string,
  from: string,
  to: string
): Promise<HabitLogRow[]> => {
  const res = await turso.execute({
    sql: `SELECT ${LOG_COLUMNS} FROM habit_logs
          WHERE habit_id = ? AND log_date BETWEEN ? AND ? AND deleted_at IS NULL
          ORDER BY log_date ASC`,
    args: [habitId, from, to],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapLog);
};

export const listRecentLogs = async (
  habitId: string,
  limit: number
): Promise<HabitLogRow[]> => {
  const res = await turso.execute({
    sql: `SELECT ${LOG_COLUMNS} FROM habit_logs
          WHERE habit_id = ? AND deleted_at IS NULL
          ORDER BY log_date DESC
          LIMIT ?`,
    args: [habitId, limit],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapLog);
};

export const listAllLogsInRange = async (
  userId: string,
  from: string,
  to: string
): Promise<HabitLogRow[]> => {
  const res = await turso.execute({
    sql: `SELECT l.id, l.habit_id, l.log_date, l.completed, l.note,
                 l.created_at, l.updated_at, l.deleted_at
          FROM habit_logs l
          JOIN habits h ON h.id = l.habit_id
          WHERE h.user_id = ?
            AND h.deleted_at IS NULL
            AND l.deleted_at IS NULL
            AND l.log_date BETWEEN ? AND ?
          ORDER BY l.log_date ASC`,
    args: [userId, from, to],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapLog);
};

// ============================================================
// Streak compute (gọi sau mỗi upsert/delete log)
// ============================================================

export const recomputeStreaks = async (
  habitId: string
): Promise<{ current: number; longest: number }> => {
  const res = await turso.execute({
    sql: "SELECT log_date, completed FROM habit_logs WHERE habit_id = ? AND deleted_at IS NULL ORDER BY log_date ASC",
    args: [habitId],
  });
  const logs = (res.rows as unknown as Record<string, unknown>[]).map((r) => ({
    date: r.log_date as string,
    completed: Number(r.completed),
  }));

  // longest: scan asc, đếm chuỗi liên tiếp (date diff = 1) và completed=1
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const l of logs) {
    if (l.completed !== 1) {
      run = 0;
      prev = l.date;
      continue;
    }
    run = prev && dayDiff(prev, l.date) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = l.date;
  }

  // current: từ today lùi, đếm liên tiếp completed=1; ngày KHÔNG log = break
  const byDate = new Map(logs.map((l) => [l.date, l.completed]));
  let current = 0;
  let cursor = todayDate();
  while (byDate.get(cursor) === 1) {
    current++;
    cursor = addDays(cursor, -1);
  }

  await turso.execute({
    sql: "UPDATE habits SET current_streak = ?, longest_streak = ?, updated_at = ? WHERE id = ?",
    args: [current, longest, nowISO(), habitId],
  });
  return { current, longest };
};

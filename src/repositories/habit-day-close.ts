import { turso } from "../config/db.js";
import { newId } from "../utils/id.js";

/**
 * Đóng ngày của habit: khi ngày địa phương của một người dùng kết thúc mà habit chưa có
 * log thì ghi log completed = 0 (xem migration 0019). File này chỉ chứa phần SQL; quy tắc
 * "khi nào" nằm ở services/habit-day-close.ts.
 */

export type CloseCandidateUser = {
  user_id: string;
  timezone: string;
  /** Ngày địa phương cuối cùng đã được điền; null = chưa từng đóng ngày nào. */
  closed_through: string | null;
};

/**
 * Người dùng còn hoạt động và có ít nhất một habit chưa xóa. Habit đã archive vẫn tính để
 * cursor tiếp tục tiến: nếu không, bỏ archive sau nhiều tuần sẽ bị "bù" nhầm các ngày cũ.
 */
export const listCloseCandidateUsers = async (): Promise<CloseCandidateUser[]> => {
  const res = await turso.execute({
    sql: `SELECT u.id AS user_id, u.timezone, c.closed_through
          FROM users u
          LEFT JOIN habit_close_cursors c ON c.user_id = u.id
          WHERE u.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM habits h
                        WHERE h.user_id = u.id AND h.deleted_at IS NULL)`,
    args: [],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map((row) => ({
    user_id: row.user_id as string,
    timezone: row.timezone as string,
    closed_through: (row.closed_through as string | null) ?? null,
  }));
};

export const userHasLiveHabit = async (userId: string): Promise<boolean> => {
  const res = await turso.execute({
    sql: "SELECT 1 FROM habits WHERE user_id = ? AND deleted_at IS NULL LIMIT 1",
    args: [userId],
  });
  return res.rows.length > 0;
};

export const getCloseCursor = async (userId: string): Promise<string | null> => {
  const res = await turso.execute({
    sql: "SELECT closed_through FROM habit_close_cursors WHERE user_id = ?",
    args: [userId],
  });
  if (res.rows.length === 0) return null;
  return (res.rows[0] as unknown as Record<string, unknown>).closed_through as string;
};

/**
 * Habit hoạt động ngày `date` (chưa xóa, chưa archive, start_date <= date <= end_date — đúng
 * quy tắc mẫu số của countDayHabits ở dashboard) mà chưa có log SỐNG cho ngày đó.
 * Log đã xóa mềm không tính là "đã có log".
 */
export const listHabitIdsMissingLog = async (
  userId: string,
  date: string
): Promise<string[]> => {
  const res = await turso.execute({
    sql: `SELECT h.id FROM habits h
          WHERE h.user_id = ?
            AND h.deleted_at IS NULL
            AND h.is_archived = 0
            AND h.start_date <= ?
            AND (h.end_date IS NULL OR h.end_date >= ?)
            AND NOT EXISTS (
              SELECT 1 FROM habit_logs l
              WHERE l.habit_id = h.id AND l.log_date = ? AND l.deleted_at IS NULL
            )
          ORDER BY h.id`,
    args: [userId, date, date, date],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(
    (row) => row.id as string
  );
};

// Chèn dòng mới; nếu đã có dòng ĐÃ XÓA MỀM thì hồi sinh thành 0; dòng sống không bao giờ bị đụng
// (mệnh đề WHERE của DO UPDATE), nên chạy lại hay chạy song song với thao tác thật đều an toàn.
const CLOSE_LOG_SQL = `
  INSERT INTO habit_logs
    (id, habit_id, log_date, completed, note, created_at, updated_at, deleted_at, auto_closed)
  VALUES (?, ?, ?, 0, NULL, ?, ?, NULL, 1)
  ON CONFLICT(habit_id, log_date) DO UPDATE SET
    completed = 0,
    note = NULL,
    deleted_at = NULL,
    updated_at = excluded.updated_at,
    auto_closed = 1
  WHERE habit_logs.deleted_at IS NOT NULL`;

// MAX không bao giờ cho cursor lùi lại khi hai lượt quét (job + lazy) chạy cùng lúc.
const CURSOR_SQL = `
  INSERT INTO habit_close_cursors (user_id, closed_through, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    closed_through = MAX(habit_close_cursors.closed_through, excluded.closed_through),
    updated_at = excluded.updated_at`;

/**
 * Điền completed=0 cho mọi habit thiếu log của `date` và đẩy cursor tới `date`, tất cả trong
 * MỘT batch: mỗi ngày hoặc xong trọn vẹn hoặc không có gì, rồi chạy lại là idempotent.
 * Trả về số habit được duyệt (đã chèn hoặc hồi sinh). Cố ý KHÔNG tính lại streak: một dòng 0
 * không đổi kết quả streak, và tính lại sẽ bump habits.updated_at của mọi habit mỗi đêm.
 */
export const closeHabitDay = async (
  userId: string,
  date: string,
  nowIso: string
): Promise<number> => {
  const habitIds = await listHabitIdsMissingLog(userId, date);
  const statements: { sql: string; args: string[] }[] = habitIds.map((habitId) => ({
    sql: CLOSE_LOG_SQL,
    args: [newId(), habitId, date, nowIso, nowIso],
  }));
  statements.push({ sql: CURSOR_SQL, args: [userId, date, nowIso] });
  await turso.batch(statements, "write");
  return habitIds.length;
};

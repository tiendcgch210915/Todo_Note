import { turso } from "../config/db.js";
import { nowISO } from "../utils/time.js";

/** Ngữ cảnh gửi thông báo của một người dùng (đã ghép users + notification_settings). */
export type UserNotificationContext = {
  user_id: string;
  active: boolean;
  timezone: string;
  /** null = chưa từng lưu cài đặt, dùng mặc định. */
  morning_time: string | null;
  evening_time: string | null;
};

const mapContext = (row: Record<string, unknown>): UserNotificationContext => ({
  user_id: row.id as string,
  active: row.deleted_at === null || row.deleted_at === undefined,
  timezone: row.timezone as string,
  morning_time: (row.morning_time as string | null) ?? null,
  evening_time: (row.evening_time as string | null) ?? null,
});

const CONTEXT_SELECT = `SELECT u.id, u.timezone, u.deleted_at, s.morning_time, s.evening_time
                        FROM users u
                        LEFT JOIN notification_settings s ON s.user_id = u.id`;

export const getUserContext = async (
  userId: string
): Promise<UserNotificationContext | null> => {
  const res = await turso.execute({
    sql: `${CONTEXT_SELECT} WHERE u.id = ?`,
    args: [userId],
  });
  if (res.rows.length === 0) return null;
  return mapContext(res.rows[0] as unknown as Record<string, unknown>);
};

/** Người dùng còn hoạt động và có ít nhất một thiết bị, phân trang theo id. */
export const listPlannerUsers = async (
  afterId: string,
  limit: number
): Promise<UserNotificationContext[]> => {
  const res = await turso.execute({
    sql: `${CONTEXT_SELECT}
          WHERE u.deleted_at IS NULL
            AND u.id > ?
            AND EXISTS (SELECT 1 FROM user_devices d WHERE d.user_id = u.id)
          ORDER BY u.id ASC
          LIMIT ?`,
    args: [afterId, limit],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapContext);
};

export const upsertSettings = async (
  userId: string,
  morningTime: string,
  eveningTime: string
): Promise<void> => {
  const now = nowISO();
  await turso.execute({
    sql: `INSERT INTO notification_settings
          (user_id, morning_time, evening_time, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            morning_time = excluded.morning_time,
            evening_time = excluded.evening_time,
            updated_at = excluded.updated_at`,
    args: [userId, morningTime, eveningTime, now, now],
  });
};

import { turso } from "../config/db.js";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../config/notification-policy.js";
import { nowISO } from "../utils/time.js";

/** Ngữ cảnh gửi thông báo của một người dùng (đã ghép users + notification_settings). */
export type UserNotificationContext = {
  user_id: string;
  active: boolean;
  timezone: string;
  /** null = chưa từng lưu cài đặt, dùng mặc định. */
  morning_time: string | null;
  evening_time: string | null;
  review_time: string | null;
  /** null = chưa từng lưu cài đặt, mặc định bật. */
  morning_enabled: boolean | null;
  evening_enabled: boolean | null;
  review_enabled: boolean | null;
};

const toBool = (value: unknown): boolean | null =>
  value === null || value === undefined ? null : Number(value) !== 0;

const mapContext = (row: Record<string, unknown>): UserNotificationContext => ({
  user_id: row.id as string,
  active: row.deleted_at === null || row.deleted_at === undefined,
  timezone: row.timezone as string,
  morning_time: (row.morning_time as string | null) ?? null,
  evening_time: (row.evening_time as string | null) ?? null,
  review_time: (row.review_time as string | null) ?? null,
  morning_enabled: toBool(row.morning_enabled),
  evening_enabled: toBool(row.evening_enabled),
  review_enabled: toBool(row.review_enabled),
});

const CONTEXT_SELECT = `SELECT u.id, u.timezone, u.deleted_at, s.morning_time, s.evening_time,
                               s.review_time, s.morning_enabled, s.evening_enabled,
                               s.review_enabled
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

/** Bật/tắt từng nhóm tổng kết; trường bỏ trống (undefined) = giữ giá trị đã lưu. */
export type DigestToggles = {
  morningEnabled?: boolean | null;
  eveningEnabled?: boolean | null;
  reviewEnabled?: boolean | null;
};

const flag = (value: boolean | null | undefined): number | null =>
  value === null || value === undefined ? null : value ? 1 : 0;

/**
 * `reviewTime` và các cờ bật/tắt bỏ trống (undefined/null) = giữ giá trị đã lưu (hoặc mặc định nếu
 * chưa có dòng), để app bản cũ chưa gửi các trường này không vô tình đặt lại lựa chọn của người dùng.
 */
export const upsertSettings = async (
  userId: string,
  morningTime: string,
  eveningTime: string,
  reviewTime?: string | null,
  toggles: DigestToggles = {}
): Promise<void> => {
  const now = nowISO();
  const morning = flag(toggles.morningEnabled);
  const evening = flag(toggles.eveningEnabled);
  const review = flag(toggles.reviewEnabled);
  await turso.execute({
    sql: `INSERT INTO notification_settings
          (user_id, morning_time, evening_time, review_time,
           morning_enabled, evening_enabled, review_enabled, created_at, updated_at)
          VALUES (?, ?, ?, COALESCE(?, ?), COALESCE(?, 1), COALESCE(?, 1), COALESCE(?, 1), ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            morning_time = excluded.morning_time,
            evening_time = excluded.evening_time,
            review_time = COALESCE(?, notification_settings.review_time),
            morning_enabled = COALESCE(?, notification_settings.morning_enabled),
            evening_enabled = COALESCE(?, notification_settings.evening_enabled),
            review_enabled = COALESCE(?, notification_settings.review_enabled),
            updated_at = excluded.updated_at`,
    args: [
      userId,
      morningTime,
      eveningTime,
      reviewTime ?? null,
      DEFAULT_NOTIFICATION_SETTINGS.reviewTime,
      morning,
      evening,
      review,
      now,
      now,
      reviewTime ?? null,
      morning,
      evening,
      review,
    ],
  });
};

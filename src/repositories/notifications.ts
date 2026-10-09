import { turso } from "../config/db.js";
import { newId } from "../utils/id.js";
import { nowISO } from "../utils/time.js";

export type DeviceKind = "fid" | "token";
export type DevicePlatform = "android";

export type UserDeviceRow = {
  id: string;
  user_id: string;
  registration_id: string;
  kind: DeviceKind;
  platform: DevicePlatform;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

/** What the sender needs to address one device. */
export type DeviceTarget = {
  id: string;
  registration_id: string;
  kind: DeviceKind;
};

export type TodoReminderRow = {
  id: string;
  user_id: string;
  title: string;
  scheduled_date: string;
  time: string;
};

export type NotificationKind = "morning" | "evening" | "todo_reminder";

const DEVICE_COLUMNS =
  "id, user_id, registration_id, kind, platform, last_seen_at, created_at, updated_at";

const DELETE_BATCH_SIZE = 500;

const mapDeviceRow = (row: Record<string, unknown>): UserDeviceRow => ({
  id: row.id as string,
  user_id: row.user_id as string,
  registration_id: row.registration_id as string,
  kind: row.kind as DeviceKind,
  platform: row.platform as DevicePlatform,
  last_seen_at: row.last_seen_at as string,
  created_at: row.created_at as string,
  updated_at: row.updated_at as string,
});

const isUniqueViolation = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE/i.test(message);
};

export const activeUserExists = async (userId: string): Promise<boolean> => {
  const res = await turso.execute({
    sql: "SELECT id FROM users WHERE id = ? AND deleted_at IS NULL",
    args: [userId],
  });
  return res.rows.length > 0;
};

/**
 * Insert or refresh a device registration. Every call bumps `last_seen_at`.
 * A registration id belongs to one user at a time: re-registering it under a
 * different user (shared phone, new login) detaches it from the previous owner.
 */
export const upsertUserDevice = async (
  userId: string,
  input: {
    registrationId: string;
    kind: DeviceKind;
    platform: DevicePlatform;
  }
): Promise<UserDeviceRow> => {
  const id = newId();
  const now = nowISO();
  await turso.batch(
    [
      {
        sql: "DELETE FROM user_devices WHERE registration_id = ? AND user_id <> ?",
        args: [input.registrationId, userId],
      },
      {
        sql: `INSERT INTO user_devices
              (id, user_id, registration_id, kind, platform, last_seen_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, registration_id)
              DO UPDATE SET kind = excluded.kind,
                            platform = excluded.platform,
                            last_seen_at = excluded.last_seen_at,
                            updated_at = excluded.updated_at`,
        args: [
          id,
          userId,
          input.registrationId,
          input.kind,
          input.platform,
          now,
          now,
          now,
        ],
      },
    ],
    "write"
  );

  const res = await turso.execute({
    sql: `SELECT ${DEVICE_COLUMNS} FROM user_devices WHERE user_id = ? AND registration_id = ?`,
    args: [userId, input.registrationId],
  });
  if (res.rows.length === 0) {
    throw new Error("upsertUserDevice: row missing after upsert");
  }
  return mapDeviceRow(res.rows[0] as unknown as Record<string, unknown>);
};

/** Remove one of the user's own registrations; returns how many rows were deleted. */
export const deleteUserDevice = async (
  userId: string,
  registrationId: string
): Promise<number> => {
  const res = await turso.execute({
    sql: "DELETE FROM user_devices WHERE user_id = ? AND registration_id = ?",
    args: [userId, registrationId],
  });
  return res.rowsAffected;
};

export const listActiveUserIds = async (): Promise<string[]> => {
  const res = await turso.execute({
    sql: "SELECT id FROM users WHERE deleted_at IS NULL ORDER BY created_at ASC",
    args: [],
  });
  return (res.rows as unknown as { id: string }[]).map((row) => row.id);
};

export const listDevicesByUser = async (
  userId: string
): Promise<DeviceTarget[]> => {
  const res = await turso.execute({
    sql: `SELECT id, registration_id, kind
          FROM user_devices
          WHERE user_id = ?
          ORDER BY last_seen_at DESC, id ASC`,
    args: [userId],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    registration_id: row.registration_id as string,
    kind: row.kind as DeviceKind,
  }));
};

/** Delete device rows by primary key (what the sender reports back as invalid). */
export const deleteDevicesByIds = async (ids: string[]): Promise<void> => {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  for (let i = 0; i < unique.length; i += DELETE_BATCH_SIZE) {
    const chunk = unique.slice(i, i + DELETE_BATCH_SIZE);
    await turso.execute({
      sql: `DELETE FROM user_devices WHERE id IN (${chunk.map(() => "?").join(", ")})`,
      args: chunk,
    });
  }
};

export const countStaleDevices = async (cutoffISO: string): Promise<number> => {
  const res = await turso.execute({
    sql: "SELECT COUNT(*) AS c FROM user_devices WHERE last_seen_at < ?",
    args: [cutoffISO],
  });
  return Number((res.rows[0] as unknown as Record<string, unknown>).c);
};

/** Delete registrations whose app has not checked in since `cutoffISO`. */
export const deleteStaleDevices = async (cutoffISO: string): Promise<number> => {
  const res = await turso.execute({
    sql: "DELETE FROM user_devices WHERE last_seen_at < ?",
    args: [cutoffISO],
  });
  return res.rowsAffected;
};

export const countImportantUrgentTodosForDate = async (
  userId: string,
  date: string
): Promise<number> => {
  const res = await turso.execute({
    sql: `SELECT COUNT(*) AS c
          FROM todos
          WHERE user_id = ?
            AND scheduled_date = ?
            AND parent_id IS NULL
            AND deleted_at IS NULL
            AND status <> 'done'
            AND status <> 'archived'
            AND is_important = 1
            AND is_urgent = 1`,
    args: [userId, date],
  });
  return Number((res.rows[0] as unknown as Record<string, unknown>).c);
};

export const countRemainingTodosForDate = async (
  userId: string,
  date: string
): Promise<number> => {
  const res = await turso.execute({
    sql: `SELECT COUNT(*) AS c
          FROM todos
          WHERE user_id = ?
            AND scheduled_date = ?
            AND parent_id IS NULL
            AND deleted_at IS NULL
            AND status <> 'done'
            AND status <> 'archived'`,
    args: [userId, date],
  });
  return Number((res.rows[0] as unknown as Record<string, unknown>).c);
};

export const listDueTodoReminders = async (
  date: string,
  hhmm: string
): Promise<TodoReminderRow[]> => {
  const res = await turso.execute({
    sql: `SELECT id, user_id, title, scheduled_date, time
          FROM todos
          WHERE scheduled_date = ?
            AND time = ?
            AND parent_id IS NULL
            AND deleted_at IS NULL
            AND status <> 'done'
            AND status <> 'archived'
          ORDER BY user_id ASC, position ASC, created_at ASC`,
    args: [date, hhmm],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    user_id: row.user_id as string,
    title: row.title as string,
    scheduled_date: row.scheduled_date as string,
    time: row.time as string,
  }));
};

export const claimNotificationDelivery = async (input: {
  userId: string;
  todoId?: string | null;
  kind: NotificationKind;
  dedupeKey: string;
  sentAt?: string;
}): Promise<boolean> => {
  const now = input.sentAt ?? nowISO();
  try {
    await turso.execute({
      sql: `INSERT INTO notification_deliveries
            (id, user_id, todo_id, kind, dedupe_key, sent_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId(),
        input.userId,
        input.todoId ?? null,
        input.kind,
        input.dedupeKey,
        now,
        now,
      ],
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
};

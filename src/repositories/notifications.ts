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

/**
 * Job nhắm vào một thiết bị sắp bị xóa phải bị hủy, KHÔNG được chuyển thành "gửi mọi
 * thiết bị". Câu lệnh này luôn chạy TRƯỚC câu DELETE trong cùng một batch.
 */
const cancelJobsForDevicesWhere = (where: string): string =>
  `UPDATE notification_jobs SET status = 'cancelled'
   WHERE status IN ('pending', 'processing')
     AND target_device_id IN (SELECT id FROM user_devices WHERE ${where})`;

export const activeUserExists = async (userId: string): Promise<boolean> => {
  const res = await turso.execute({
    sql: "SELECT id FROM users WHERE id = ? AND deleted_at IS NULL",
    args: [userId],
  });
  return res.rows.length > 0;
};

export const findDeviceByRegistration = async (
  userId: string,
  registrationId: string
): Promise<UserDeviceRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${DEVICE_COLUMNS} FROM user_devices
          WHERE user_id = ? AND registration_id = ?`,
    args: [userId, registrationId],
  });
  if (res.rows.length === 0) return null;
  return mapDeviceRow(res.rows[0] as unknown as Record<string, unknown>);
};

export const getUserDevice = async (
  userId: string,
  deviceId: string
): Promise<UserDeviceRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${DEVICE_COLUMNS} FROM user_devices WHERE user_id = ? AND id = ?`,
    args: [userId, deviceId],
  });
  if (res.rows.length === 0) return null;
  return mapDeviceRow(res.rows[0] as unknown as Record<string, unknown>);
};

/**
 * Insert or refresh a device registration. Every call bumps `last_seen_at`.
 * A registration id belongs to one user at a time: re-registering it under a
 * different user (shared phone, new login) detaches it from the previous owner.
 *
 * `previousRegistrationId` (FID/token rotation): if it names one of THIS user's
 * rows, that row is renamed in place so its `id` (what jobs and timers point to)
 * survives. If the new registration already exists for the user, jobs/timers are
 * re-pointed to that row and the old row is dropped. Unknown or foreign ids are
 * ignored silently, so the response never reveals whether they exist.
 */
export const upsertUserDevice = async (
  userId: string,
  input: {
    registrationId: string;
    kind: DeviceKind;
    platform: DevicePlatform;
    previousRegistrationId?: string | null;
  }
): Promise<UserDeviceRow> => {
  const id = newId();
  const now = nowISO();

  await turso.batch(
    [
      {
        sql: cancelJobsForDevicesWhere("registration_id = ? AND user_id <> ?"),
        args: [input.registrationId, userId],
      },
      {
        sql: "DELETE FROM user_devices WHERE registration_id = ? AND user_id <> ?",
        args: [input.registrationId, userId],
      },
    ],
    "write"
  );

  const previous = input.previousRegistrationId?.trim();
  if (previous && previous !== input.registrationId) {
    const previousRow = await findDeviceByRegistration(userId, previous);
    if (previousRow) {
      const currentRow = await findDeviceByRegistration(
        userId,
        input.registrationId
      );
      try {
        if (!currentRow) {
          await turso.execute({
            sql: `UPDATE user_devices
                  SET registration_id = ?, kind = ?, platform = ?,
                      last_seen_at = ?, updated_at = ?
                  WHERE id = ? AND user_id = ?`,
            args: [
              input.registrationId,
              input.kind,
              input.platform,
              now,
              now,
              previousRow.id,
              userId,
            ],
          });
        } else {
          await turso.batch(
            [
              {
                sql: `UPDATE notification_jobs SET target_device_id = ?
                      WHERE target_device_id = ? AND status IN ('pending', 'processing')`,
                args: [currentRow.id, previousRow.id],
              },
              {
                sql: "UPDATE todo_timers SET device_id = ? WHERE device_id = ?",
                args: [currentRow.id, previousRow.id],
              },
              {
                sql: "DELETE FROM user_devices WHERE id = ? AND user_id = ?",
                args: [previousRow.id, userId],
              },
            ],
            "write"
          );
        }
      } catch (error) {
        // Another request registered the new id between our read and write; the
        // plain upsert below then just refreshes it.
        if (!isUniqueViolation(error)) throw error;
      }
    }
  }

  await turso.execute({
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
  });

  const row = await findDeviceByRegistration(userId, input.registrationId);
  if (!row) {
    throw new Error("upsertUserDevice: row missing after upsert");
  }
  return row;
};

/** Remove one of the user's own registrations; returns how many rows were deleted. */
export const deleteUserDevice = async (
  userId: string,
  registrationId: string
): Promise<number> => {
  const results = await turso.batch(
    [
      {
        sql: cancelJobsForDevicesWhere("user_id = ? AND registration_id = ?"),
        args: [userId, registrationId],
      },
      {
        sql: "DELETE FROM user_devices WHERE user_id = ? AND registration_id = ?",
        args: [userId, registrationId],
      },
    ],
    "write"
  );
  return results[1].rowsAffected;
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
    const marks = chunk.map(() => "?").join(", ");
    await turso.batch(
      [
        {
          sql: cancelJobsForDevicesWhere(`id IN (${marks})`),
          args: chunk,
        },
        { sql: `DELETE FROM user_devices WHERE id IN (${marks})`, args: chunk },
      ],
      "write"
    );
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
  const results = await turso.batch(
    [
      {
        sql: cancelJobsForDevicesWhere("last_seen_at < ?"),
        args: [cutoffISO],
      },
      {
        sql: "DELETE FROM user_devices WHERE last_seen_at < ?",
        args: [cutoffISO],
      },
    ],
    "write"
  );
  return results[1].rowsAffected;
};

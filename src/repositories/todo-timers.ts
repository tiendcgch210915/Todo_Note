import { turso } from "../config/db.js";
import { nowISO } from "../utils/time.js";

export type TimerStatus = "idle" | "running" | "paused" | "finished";

export type TimerRow = {
  todo_id: string;
  user_id: string;
  status: TimerStatus;
  estimated_seconds: number | null;
  remaining_seconds: number | null;
  ends_at: string | null;
  device_id: string | null;
  last_client_event_at: string | null;
  updated_at: string;
};

const COLUMNS =
  "todo_id, user_id, status, estimated_seconds, remaining_seconds, ends_at, device_id, last_client_event_at, updated_at";

const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const mapTimer = (row: Record<string, unknown>): TimerRow => ({
  todo_id: row.todo_id as string,
  user_id: row.user_id as string,
  status: row.status as TimerStatus,
  estimated_seconds: nullableNumber(row.estimated_seconds),
  remaining_seconds: nullableNumber(row.remaining_seconds),
  ends_at: (row.ends_at as string | null) ?? null,
  device_id: (row.device_id as string | null) ?? null,
  last_client_event_at: (row.last_client_event_at as string | null) ?? null,
  updated_at: row.updated_at as string,
});

export const getTimer = async (todoId: string): Promise<TimerRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${COLUMNS} FROM todo_timers WHERE todo_id = ?`,
    args: [todoId],
  });
  if (res.rows.length === 0) return null;
  return mapTimer(res.rows[0] as unknown as Record<string, unknown>);
};

export const upsertTimer = async (
  row: Omit<TimerRow, "updated_at">
): Promise<void> => {
  await turso.execute({
    sql: `INSERT INTO todo_timers
          (todo_id, user_id, status, estimated_seconds, remaining_seconds,
           ends_at, device_id, last_client_event_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(todo_id) DO UPDATE SET
            user_id = excluded.user_id,
            status = excluded.status,
            estimated_seconds = excluded.estimated_seconds,
            remaining_seconds = excluded.remaining_seconds,
            ends_at = excluded.ends_at,
            device_id = excluded.device_id,
            last_client_event_at = excluded.last_client_event_at,
            updated_at = excluded.updated_at`,
    args: [
      row.todo_id,
      row.user_id,
      row.status,
      row.estimated_seconds,
      row.remaining_seconds,
      row.ends_at,
      row.device_id,
      row.last_client_event_at,
      nowISO(),
    ],
  });
};

export const deleteTimers = async (todoIds: readonly string[]): Promise<void> => {
  for (let i = 0; i < todoIds.length; i += 500) {
    const part = todoIds.slice(i, i + 500);
    await turso.execute({
      sql: `DELETE FROM todo_timers WHERE todo_id IN (${part.map(() => "?").join(", ")})`,
      args: part,
    });
  }
};

/**
 * Đưa timer về `idle` nhưng GIỮ last_client_event_at: một sự kiện cũ gửi lại muộn
 * vẫn bị chặn theo thứ tự.
 */
export const resetTimerIdle = async (todoId: string): Promise<void> => {
  await turso.execute({
    sql: `UPDATE todo_timers
          SET status = 'idle', remaining_seconds = NULL, ends_at = NULL,
              device_id = NULL, updated_at = ?
          WHERE todo_id = ? AND status <> 'idle'`,
    args: [nowISO(), todoId],
  });
};

/** Sau khi gửi thông báo hết giờ: running -> finished (chỉ khi ends_at vẫn là mốc đã gửi). */
export const markTimerFinished = async (
  todoId: string,
  endsAt: string
): Promise<void> => {
  await turso.execute({
    sql: `UPDATE todo_timers
          SET status = 'finished', remaining_seconds = 0, updated_at = ?
          WHERE todo_id = ? AND status = 'running' AND ends_at = ?`,
    args: [nowISO(), todoId, endsAt],
  });
};

/** Dồn timer đang trỏ vào thiết bị cũ sang thiết bị mới (khi hợp nhất đăng ký thiết bị). */
export const repointTimerDevice = async (
  fromDeviceId: string,
  toDeviceId: string
): Promise<void> => {
  await turso.execute({
    sql: "UPDATE todo_timers SET device_id = ? WHERE device_id = ?",
    args: [toDeviceId, fromDeviceId],
  });
};

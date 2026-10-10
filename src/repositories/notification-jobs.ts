import { turso } from "../config/db.js";
import { newId } from "../utils/id.js";
import { nowISO } from "../utils/time.js";
import {
  DIGEST_KINDS,
  EVENT_KINDS,
  NOTIFICATION_KINDS,
  type DigestKind,
  type EventKind,
  type NotificationJobKind,
  type NotificationJobStatus,
} from "../config/notification-policy.js";

export type JobRow = {
  id: string;
  user_id: string;
  kind: NotificationJobKind;
  ref_id: string | null;
  target_device_id: string | null;
  local_date: string | null;
  run_at: string;
  status: NotificationJobStatus;
  attempts: number;
  locked_at: string | null;
  sent_at: string | null;
  created_at: string;
};

const COLUMNS =
  "id, user_id, kind, ref_id, target_device_id, local_date, run_at, status, attempts, locked_at, sent_at, created_at";

const CHUNK = 500;

const sqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(", ");

// Các giá trị này là hằng số trong mã nguồn, không phải dữ liệu người dùng.
const EVENT_KIND_SQL = sqlList(EVENT_KINDS);
const DIGEST_KIND_SQL = sqlList(DIGEST_KINDS);

const placeholders = (n: number): string =>
  Array.from({ length: n }, () => "?").join(", ");

const chunks = <T>(items: readonly T[], size = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const mapJob = (row: Record<string, unknown>): JobRow => ({
  id: row.id as string,
  user_id: row.user_id as string,
  kind: row.kind as NotificationJobKind,
  ref_id: (row.ref_id as string | null) ?? null,
  target_device_id: (row.target_device_id as string | null) ?? null,
  local_date: (row.local_date as string | null) ?? null,
  run_at: row.run_at as string,
  status: row.status as NotificationJobStatus,
  attempts: Number(row.attempts),
  locked_at: (row.locked_at as string | null) ?? null,
  sent_at: (row.sent_at as string | null) ?? null,
  created_at: row.created_at as string,
});

// ── Đọc ──────────────────────────────────────────────────────────────────────

export const getJobById = async (id: string): Promise<JobRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${COLUMNS} FROM notification_jobs WHERE id = ?`,
    args: [id],
  });
  if (res.rows.length === 0) return null;
  return mapJob(res.rows[0] as unknown as Record<string, unknown>);
};

export const getEventJob = async (
  userId: string,
  kind: EventKind,
  refId: string
): Promise<JobRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${COLUMNS} FROM notification_jobs
          WHERE user_id = ? AND kind = ? AND ref_id = ?`,
    args: [userId, kind, refId],
  });
  if (res.rows.length === 0) return null;
  return mapJob(res.rows[0] as unknown as Record<string, unknown>);
};

export const listPendingDigestJobs = async (
  userId: string
): Promise<JobRow[]> => {
  const res = await turso.execute({
    sql: `SELECT ${COLUMNS} FROM notification_jobs
          WHERE user_id = ? AND status = 'pending' AND kind IN (${DIGEST_KIND_SQL})`,
    args: [userId],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapJob);
};

/**
 * Job `pending` đã đến hạn (kể cả job thử lại sau khi đã giãn cách đủ lâu).
 * Chỉ là danh sách ứng viên: quyền xử lý chỉ có sau khi `claimJob` thành công.
 */
export const listDueCandidates = async (
  nowIso: string,
  retryBeforeIso: string,
  maxAttempts: number,
  limit: number
): Promise<JobRow[]> => {
  const res = await turso.execute({
    sql: `SELECT ${COLUMNS} FROM notification_jobs
          WHERE status = 'pending'
            AND run_at <= ?
            AND attempts < ?
            AND (locked_at IS NULL OR locked_at <= ?)
          ORDER BY run_at ASC, id ASC
          LIMIT ?`,
    args: [nowIso, maxAttempts, retryBeforeIso, limit],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapJob);
};

// ── Tạo / sửa ────────────────────────────────────────────────────────────────

/**
 * Tạo hoặc sửa job sự kiện (một job cho mỗi user + kind + ref_id).
 *
 * Khi dòng đã tồn tại:
 *  - run_at và đích KHÔNG đổi và job đã sent/failed/missed/processing -> giữ nguyên trạng thái
 *    (sửa tên todo không được làm nhắc lại lần nữa);
 *  - đổi run_at/đích -> đặt lại `pending` (xóa attempts/locked_at/sent_at), riêng job đang
 *    `processing` thì giữ `processing` và chỉ cập nhật run_at/đích.
 */
export const upsertEventJob = async (input: {
  userId: string;
  kind: EventKind;
  refId: string;
  runAt: string;
  targetDeviceId?: string | null;
  localDate?: string | null;
}): Promise<void> => {
  const keep = `(
      (notification_jobs.run_at = excluded.run_at
        AND COALESCE(notification_jobs.target_device_id, '') = COALESCE(excluded.target_device_id, '')
        AND notification_jobs.status IN ('sent', 'processing', 'failed', 'missed'))
      OR notification_jobs.status = 'processing'
    )`;
  await turso.execute({
    sql: `INSERT INTO notification_jobs
          (id, user_id, kind, ref_id, target_device_id, local_date, run_at,
           status, attempts, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
          ON CONFLICT(user_id, kind, ref_id) WHERE kind IN (${EVENT_KIND_SQL})
          DO UPDATE SET
            status = CASE WHEN ${keep} THEN notification_jobs.status ELSE 'pending' END,
            attempts = CASE WHEN ${keep} THEN notification_jobs.attempts ELSE 0 END,
            locked_at = CASE WHEN ${keep} THEN notification_jobs.locked_at ELSE NULL END,
            sent_at = CASE WHEN ${keep} THEN notification_jobs.sent_at ELSE NULL END,
            run_at = excluded.run_at,
            target_device_id = excluded.target_device_id,
            local_date = excluded.local_date`,
    args: [
      newId(),
      input.userId,
      input.kind,
      input.refId,
      input.targetDeviceId ?? null,
      input.localDate ?? null,
      input.runAt,
      nowISO(),
    ],
  });
};

/**
 * Chỉ thêm khi chưa có dòng nào cho (user, kind, ref_id). Dùng cho bước vá todo cũ:
 * thời điểm đã qua thì ghi luôn `missed` để lần tick sau không xét lại.
 */
export const insertEventJobIfAbsent = async (input: {
  userId: string;
  kind: EventKind;
  refId: string;
  runAt: string;
  status: "pending" | "missed";
  localDate?: string | null;
}): Promise<boolean> => {
  const res = await turso.execute({
    sql: `INSERT INTO notification_jobs
          (id, user_id, kind, ref_id, target_device_id, local_date, run_at,
           status, attempts, created_at)
          VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0, ?)
          ON CONFLICT(user_id, kind, ref_id) WHERE kind IN (${EVENT_KIND_SQL})
          DO NOTHING`,
    args: [
      newId(),
      input.userId,
      input.kind,
      input.refId,
      input.localDate ?? null,
      input.runAt,
      input.status,
      nowISO(),
    ],
  });
  return res.rowsAffected > 0;
};

export type DigestJobInput = {
  userId: string;
  kind: DigestKind;
  localDate: string;
  runAt: string;
};

/** Thêm các job tổng kết còn thiếu; trả số dòng thật sự được tạo (idempotent). */
export const insertDigestJobs = async (
  jobs: DigestJobInput[]
): Promise<number> => {
  let created = 0;
  const now = nowISO();
  for (const part of chunks(jobs, 100)) {
    const results = await turso.batch(
      part.map((job) => ({
        sql: `INSERT INTO notification_jobs
              (id, user_id, kind, ref_id, target_device_id, local_date, run_at,
               status, attempts, created_at)
              VALUES (?, ?, ?, NULL, NULL, ?, ?, 'pending', 0, ?)
              ON CONFLICT(user_id, kind, local_date) WHERE kind IN (${DIGEST_KIND_SQL})
              DO NOTHING`,
        args: [newId(), job.userId, job.kind, job.localDate, job.runAt, now],
      })),
      "write"
    );
    created += results.reduce((sum, r) => sum + r.rowsAffected, 0);
  }
  return created;
};

/**
 * Khóa (user|kind|local_date) của các tổng kết đã có dòng, để planner chỉ ghi phần còn thiếu
 * (trạng thái ổn định = 0 lần ghi, chỉ 1 lần đọc cho mỗi lô người dùng).
 */
export const listExistingDigestKeys = async (
  userIds: readonly string[],
  localDates: readonly string[]
): Promise<Set<string>> => {
  const keys = new Set<string>();
  if (userIds.length === 0 || localDates.length === 0) return keys;
  for (const part of chunks(userIds, 200)) {
    const res = await turso.execute({
      sql: `SELECT user_id, kind, local_date FROM notification_jobs
            WHERE kind IN (${DIGEST_KIND_SQL})
              AND local_date IN (${placeholders(localDates.length)})
              AND user_id IN (${placeholders(part.length)})`,
      args: [...localDates, ...part],
    });
    for (const row of res.rows as unknown as Record<string, unknown>[]) {
      keys.add(`${row.user_id}|${row.kind}|${row.local_date}`);
    }
  }
  return keys;
};

/** Xóa job đã kết thúc từ lâu. Job còn pending/processing không bao giờ bị xóa. */
export const purgeFinishedJobs = async (olderThanIso: string): Promise<number> => {
  const res = await turso.execute({
    sql: `DELETE FROM notification_jobs
          WHERE status IN ('sent', 'cancelled', 'missed', 'failed') AND run_at < ?`,
    args: [olderThanIso],
  });
  return res.rowsAffected;
};

/** Đổi giờ chạy của job `pending` (dùng khi người dùng đổi cài đặt). */
export const updatePendingRunAt = async (
  id: string,
  runAt: string
): Promise<boolean> => {
  const res = await turso.execute({
    sql: "UPDATE notification_jobs SET run_at = ? WHERE id = ? AND status = 'pending'",
    args: [runAt, id],
  });
  return res.rowsAffected > 0;
};

// ── Hủy ──────────────────────────────────────────────────────────────────────

/** Hủy job sự kiện còn pending/processing theo ref_id. Trả số job đã hủy. */
export const cancelEventJobs = async (
  kind: EventKind,
  refIds: readonly string[]
): Promise<number> => {
  let cancelled = 0;
  const ids = [...new Set(refIds)].filter((id) => id.length > 0);
  for (const part of chunks(ids)) {
    const res = await turso.execute({
      sql: `UPDATE notification_jobs SET status = 'cancelled'
            WHERE kind = ? AND status IN ('pending', 'processing')
              AND ref_id IN (${placeholders(part.length)})`,
      args: [kind, ...part],
    });
    cancelled += res.rowsAffected;
  }
  return cancelled;
};

// ── Vòng đời khi xử lý ───────────────────────────────────────────────────────

/**
 * Job `processing` kẹt quá lâu: còn lượt thử thì trả về `pending`, hết lượt thì `failed`.
 */
export const recoverStuckJobs = async (
  stuckBeforeIso: string,
  maxAttempts: number
): Promise<{ requeued: number; failed: number }> => {
  const failed = await turso.execute({
    sql: `UPDATE notification_jobs SET status = 'failed'
          WHERE status = 'processing' AND locked_at < ? AND attempts >= ?`,
    args: [stuckBeforeIso, maxAttempts],
  });
  const requeued = await turso.execute({
    sql: `UPDATE notification_jobs SET status = 'pending'
          WHERE status = 'processing' AND locked_at < ? AND attempts < ?`,
    args: [stuckBeforeIso, maxAttempts],
  });
  return { requeued: requeued.rowsAffected, failed: failed.rowsAffected };
};

/** Đánh `missed` mọi job pending đã chạy muộn hơn ngưỡng của loại đó. */
export const markMissed = async (
  cutoffByKind: Record<NotificationJobKind, string>
): Promise<number> => {
  const results = await turso.batch(
    NOTIFICATION_KINDS.map((kind) => ({
      sql: `UPDATE notification_jobs SET status = 'missed'
            WHERE status = 'pending' AND kind = ? AND run_at < ?`,
      args: [kind, cutoffByKind[kind]],
    })),
    "write"
  );
  return results.reduce((sum, r) => sum + r.rowsAffected, 0);
};

/**
 * Giành quyền xử lý một job: chuyển pending -> processing trong MỘT câu lệnh.
 * Hai tick đồng thời cùng gọi cho một id thì chỉ một bên thấy rowsAffected = 1.
 */
export const claimJob = async (
  id: string,
  nowIso: string
): Promise<boolean> => {
  const res = await turso.execute({
    sql: `UPDATE notification_jobs
          SET status = 'processing', locked_at = ?, attempts = attempts + 1
          WHERE id = ? AND status = 'pending'`,
    args: [nowIso, id],
  });
  return res.rowsAffected === 1;
};

// Các hàm kết thúc chỉ tác động khi job vẫn là `processing` với đúng run_at đã giành:
// nếu giữa chừng run_at bị đổi (người dùng sửa giờ), kết quả cũ không được ghi đè.

export const markSent = async (
  id: string,
  runAt: string,
  sentAtIso: string
): Promise<boolean> => {
  const res = await turso.execute({
    sql: `UPDATE notification_jobs SET status = 'sent', sent_at = ?
          WHERE id = ? AND status = 'processing' AND run_at = ?`,
    args: [sentAtIso, id, runAt],
  });
  return res.rowsAffected > 0;
};

export const markTerminal = async (
  id: string,
  runAt: string,
  status: "cancelled" | "failed" | "missed"
): Promise<boolean> => {
  const res = await turso.execute({
    sql: `UPDATE notification_jobs SET status = ?
          WHERE id = ? AND status = 'processing' AND run_at = ?`,
    args: [status, id, runAt],
  });
  return res.rowsAffected > 0;
};

/** Thử lại sau: giữ run_at, giữ locked_at (mốc của lần thử vừa rồi) để tính giãn cách. */
export const releaseForRetry = async (
  id: string,
  runAt: string
): Promise<boolean> => {
  const res = await turso.execute({
    sql: `UPDATE notification_jobs SET status = 'pending'
          WHERE id = ? AND status = 'processing' AND run_at = ?`,
    args: [id, runAt],
  });
  return res.rowsAffected > 0;
};

// ── Vá todo cũ chưa có job nhắc giờ ─────────────────────────────────────────

export type TodoNeedingReminder = {
  id: string;
  user_id: string;
  scheduled_date: string;
  time: string;
  timezone: string;
};

/**
 * Todo còn hiệu lực, có giờ nhắc, của người dùng có thiết bị, mà CHƯA có dòng job
 * `todo_reminder` nào (todo tạo trước khi có hệ thống job, hoặc hook bị sót).
 * `fromDate` chặn dưới để không quét lại toàn bộ lịch sử.
 */
export const listTodosMissingReminderJobs = async (
  fromDate: string,
  limit: number
): Promise<TodoNeedingReminder[]> => {
  const res = await turso.execute({
    sql: `SELECT t.id, t.user_id, t.scheduled_date, t.time, u.timezone
          FROM todos t
          JOIN users u ON u.id = t.user_id AND u.deleted_at IS NULL
          WHERE t.time IS NOT NULL
            AND t.scheduled_date IS NOT NULL
            AND t.scheduled_date >= ?
            AND t.parent_id IS NULL
            AND t.deleted_at IS NULL
            AND t.status IN ('open', 'in_progress')
            AND EXISTS (SELECT 1 FROM user_devices d WHERE d.user_id = t.user_id)
            AND NOT EXISTS (
              SELECT 1 FROM notification_jobs j
              WHERE j.user_id = t.user_id AND j.kind = 'todo_reminder' AND j.ref_id = t.id
            )
          ORDER BY t.scheduled_date ASC, t.id ASC
          LIMIT ?`,
    args: [fromDate, limit],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    user_id: row.user_id as string,
    scheduled_date: row.scheduled_date as string,
    time: row.time as string,
    timezone: row.timezone as string,
  }));
};

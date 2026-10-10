/**
 * Mọi con số và tên gọi của hệ thống thông báo nằm ở đây để sửa một chỗ.
 *
 * Đơn vị: *_MS là mili-giây. LƯU Ý `TTL_MS`: Admin SDK (Node) nhận `android.ttl`
 * theo mili-giây rồi tự đổi sang chuỗi "3600s" cho HTTP v1; đừng đưa số giây vào.
 */

export const EVENT_KINDS = [
  "todo_reminder",
  "todo_timer_end",
  "checklist_30m",
] as const;

export const DIGEST_KINDS = [
  "digest_morning",
  "digest_todos",
  "digest_habits",
] as const;

export const NOTIFICATION_KINDS = [...EVENT_KINDS, ...DIGEST_KINDS] as const;

export type EventKind = (typeof EVENT_KINDS)[number];
export type DigestKind = (typeof DIGEST_KINDS)[number];
export type NotificationJobKind = (typeof NOTIFICATION_KINDS)[number];

export type NotificationJobStatus =
  | "pending"
  | "processing"
  | "sent"
  | "cancelled"
  | "missed"
  | "failed";

export const isDigestKind = (kind: string): kind is DigestKind =>
  (DIGEST_KINDS as readonly string[]).includes(kind);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Job chạy muộn hơn ngưỡng này (server ngủ/tắt) thì đánh `missed` và KHÔNG gửi. */
export const LATENESS_MS: Record<NotificationJobKind, number> = {
  todo_reminder: 30 * MINUTE,
  todo_timer_end: 5 * MINUTE,
  checklist_30m: 15 * MINUTE,
  digest_morning: 2 * HOUR,
  digest_todos: 2 * HOUR,
  digest_habits: 1 * HOUR,
};

/** Thời gian FCM giữ tin khi thiết bị offline (mili-giây, xem ghi chú đầu file). */
export const TTL_MS: Record<NotificationJobKind, number> = {
  todo_reminder: 3_600_000,
  todo_timer_end: 900_000,
  checklist_30m: 1_800_000,
  digest_morning: 7_200_000,
  digest_todos: 7_200_000,
  digest_habits: 3_600_000,
};

/** Notification channel do app Android tạo; app PHẢI tạo đủ 4 channel này. */
export const CHANNEL_ID: Record<NotificationJobKind, string> = {
  todo_reminder: "todo_reminders",
  todo_timer_end: "todo_timer",
  checklist_30m: "checklist_reminders",
  digest_morning: "daily_digest",
  digest_todos: "daily_digest",
  digest_habits: "daily_digest",
};

/** Giá trị `data.type` gửi cho app. */
export const DATA_TYPE: Record<NotificationJobKind, string> = {
  todo_reminder: "todo",
  todo_timer_end: "todo_timer_end",
  checklist_30m: "checklist",
  digest_morning: "digest_morning",
  digest_todos: "digest_todos",
  digest_habits: "digest_habits",
};

export const DISPATCH = {
  /** Số job tối đa xử lý trong một lần tick. */
  batchSize: 200,
  /** Số job xử lý song song (mỗi job giành quyền riêng nên an toàn). */
  concurrency: 8,
  /** Job `processing` quá lâu (tiến trình chết giữa chừng) được trả về `pending`. */
  stuckAfterMs: 5 * MINUTE,
  /** Số lần thử tối đa cho một job (gồm lần đầu). */
  maxAttempts: 3,
  /**
   * Giãn cách tối thiểu giữa hai lần thử, tính từ `locked_at` của lần thử trước.
   * `run_at` được giữ nguyên để bước kiểm tra "giờ còn khớp" vẫn đúng.
   */
  retrySpacingMs: 2 * MINUTE,
  /** Số todo được vá job nhắc giờ trong một lần tick (todo cũ chưa có job). */
  backfillBatchSize: 200,
  /** Số người dùng xử lý mỗi lô khi lập lịch tổng kết. */
  plannerChunkSize: 200,
} as const;

/**
 * Vòng lặp trong tiến trình (NOTIFY_INPROCESS_TICK=true).
 *  - Vòng NHANH: chỉ gửi job đến hạn (runDispatch), chu kỳ NOTIFY_FAST_LOOP_SECONDS.
 *  - Vòng CHẬM: planner + dọn dẹp (runMaintenance), 60 giây.
 */
export const LOOPS = {
  fastDefaultSeconds: 3,
  fastMinSeconds: 1,
  /** Chặn trên để không vượt giới hạn setInterval (~24,8 ngày) khi gõ nhầm số quá lớn. */
  fastMaxSeconds: 3600,
  maintenanceSeconds: 60,
  /** Lỗi lặp lại của một vòng chỉ được ghi log tối đa một lần trong khoảng này. */
  errorLogIntervalMs: 60_000,
  /** Khi tắt máy, chờ nhịp đang chạy xong tối đa chừng này rồi mới bỏ. */
  stopTimeoutMs: 10_000,
} as const;

/**
 * Chuẩn hóa NOTIFY_FAST_LOOP_SECONDS: trống/không phải số -> mặc định 3; nhỏ hơn 1 -> 1;
 * lớn hơn 3600 -> 3600. Cố ý KHÔNG làm sập server vì gõ nhầm một tham số hiệu năng.
 */
export const normalizeFastLoopSeconds = (raw: unknown): number => {
  if (raw === undefined || raw === null) return LOOPS.fastDefaultSeconds;
  const text = String(raw).trim();
  if (text === "") return LOOPS.fastDefaultSeconds;
  const value = Number(text);
  if (!Number.isFinite(value)) return LOOPS.fastDefaultSeconds;
  return Math.min(LOOPS.fastMaxSeconds, Math.max(LOOPS.fastMinSeconds, value));
};

/** Job đã kết thúc (sent/cancelled/missed/failed) được xóa sau chừng này để bảng không phình mãi. */
export const JOB_RETENTION_MS = 30 * 24 * 60 * MINUTE;

export const TIMER = {
  /** Sự kiện đến muộn hơn ngưỡng này thì trừ độ trễ khỏi thời gian còn lại. */
  lateEventThresholdMs: 60_000,
  /** clientEventAt ở tương lai quá ngưỡng này bị kẹp về giờ server. */
  futureSkewMs: 5 * MINUTE,
  maxSeconds: 7 * 24 * 3600,
} as const;

export const CHECKLIST_REMINDER_AFTER_MS = 30 * MINUTE;

export const DEFAULT_NOTIFICATION_SETTINGS = {
  morningTime: "07:00",
  eveningTime: "17:00",
  timezone: "Asia/Ho_Chi_Minh",
} as const;

/** Giờ thói quen = evening_time + 30 phút, tối đa 23:59. */
export const HABIT_SUMMARY_OFFSET_MINUTES = 30;
export const LAST_MINUTE_OF_DAY = 23 * 60 + 59;

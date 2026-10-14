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
  "digest_review",
] as const;

/**
 * Job theo LẦN XUẤT HIỆN của lịch checklist: mỗi checklist có thể có một job cho mỗi ngày địa
 * phương, nên duy nhất theo (user, kind, ref_id = id checklist, local_date).
 */
export const OCCURRENCE_KINDS = ["checklist_due"] as const;

/**
 * Nhắc LẶP khi người dùng bỏ lỡ giờ hẹn: giờ hẹn + 2h, +4h, ... trong cùng ngày địa phương.
 * Mỗi mốc là MỘT dòng job riêng, duy nhất theo (user, kind, ref_id, run_at): một mốc bị lỡ
 * (server ngủ) không làm đứt các mốc sau.
 */
export const OVERDUE_KINDS = ["todo_overdue", "checklist_overdue"] as const;

export const NOTIFICATION_KINDS = [
  ...EVENT_KINDS,
  ...OCCURRENCE_KINDS,
  ...OVERDUE_KINDS,
  ...DIGEST_KINDS,
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];
export type OccurrenceKind = (typeof OCCURRENCE_KINDS)[number];
export type OverdueKind = (typeof OVERDUE_KINDS)[number];
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
  checklist_due: 30 * MINUTE,
  todo_overdue: 30 * MINUTE,
  checklist_overdue: 30 * MINUTE,
  digest_morning: 2 * HOUR,
  digest_todos: 2 * HOUR,
  digest_habits: 1 * HOUR,
  digest_review: 1 * HOUR,
};

/** Thời gian FCM giữ tin khi thiết bị offline (mili-giây, xem ghi chú đầu file). */
export const TTL_MS: Record<NotificationJobKind, number> = {
  todo_reminder: 3_600_000,
  todo_timer_end: 900_000,
  checklist_30m: 1_800_000,
  checklist_due: 3_600_000,
  todo_overdue: 3_600_000,
  checklist_overdue: 3_600_000,
  digest_morning: 7_200_000,
  digest_todos: 7_200_000,
  digest_habits: 3_600_000,
  digest_review: 3_600_000,
};

/** Notification channel do app Android tạo; app PHẢI tạo đủ 4 channel này. */
export const CHANNEL_ID: Record<NotificationJobKind, string> = {
  todo_reminder: "todo_reminders",
  todo_timer_end: "todo_timer",
  checklist_30m: "checklist_reminders",
  checklist_due: "checklist_reminders",
  todo_overdue: "todo_reminders",
  checklist_overdue: "checklist_reminders",
  digest_morning: "daily_digest",
  digest_todos: "daily_digest",
  digest_habits: "daily_digest",
  digest_review: "daily_digest",
};

/**
 * Giá trị `data.type` gửi cho app. Nhắc lặp dùng lại đúng type của lần nhắc đúng giờ ("todo",
 * "checklist_due") để app mở đúng màn hình mà không cần xử lý thêm loại mới.
 */
export const DATA_TYPE: Record<NotificationJobKind, string> = {
  todo_reminder: "todo",
  todo_timer_end: "todo_timer_end",
  checklist_30m: "checklist",
  checklist_due: "checklist_due",
  todo_overdue: "todo",
  checklist_overdue: "checklist_due",
  digest_morning: "digest_morning",
  digest_todos: "digest_todos",
  digest_habits: "digest_habits",
  digest_review: "digest_review",
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

/** Quy tắc nhắc lặp khi bỏ lỡ giờ hẹn (todo và checklist theo lịch). */
export const OVERDUE = {
  /** Khoảng cách giữa hai lần nhắc: giờ hẹn + 2h, +4h, ... trong cùng ngày địa phương. */
  intervalMs: 2 * HOUR,
  /** Todo ước lượng LỚN HƠN mức này (phút) thì không bao giờ nhắc lặp; đúng bằng vẫn nhắc. */
  maxEstimatedMinutes: 120,
} as const;

export const DEFAULT_NOTIFICATION_SETTINGS = {
  morningTime: "07:00",
  eveningTime: "17:00",
  /** Giờ gửi thông báo rà soát cuối ngày (sửa được qua PUT /notification-settings). */
  reviewTime: "21:30",
  timezone: "Asia/Ho_Chi_Minh",
} as const;

/** Giờ thói quen = evening_time + 30 phút, tối đa 23:59. */
export const HABIT_SUMMARY_OFFSET_MINUTES = 30;
export const LAST_MINUTE_OF_DAY = 23 * 60 + 59;

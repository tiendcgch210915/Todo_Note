/**
 * Nhãn, biểu tượng và câu chữ cố định của thông báo, gom về MỘT chỗ để sửa nhanh.
 * (Con số như ngưỡng trễ, TTL, channel nằm ở notification-policy.ts.)
 *
 * Bố cục: các dòng được nối bằng "\n" (không HTML, không markdown). Mỗi nhãn đã kèm sẵn
 * khoảng trắng cuối để ghép thẳng trước nội dung.
 */

/** Nhãn từng dòng trong thông báo tổng kết. */
export const DIGEST_LABELS = {
  /** Dòng đầu của digest_morning: số liệu todo + thói quen trong MỘT dòng. */
  tasks: "📋 Nhiệm vụ: ",
  /** Dòng đầu của digest_todos. */
  progress: "📋 Tiến độ: ",
  /** Dòng đầu của digest_habits. */
  habits: "📋 Thói quen: ",
  /** digest_morning: dòng câu cổ vũ (câu được đặt trong dấu ngoặc kép cong). */
  motivation: "💪 Động lực: ",
  /** digest_todos / digest_habits: phần khích lệ tách thành dòng riêng. */
  encouragement: "💪 ",
  /** digest_morning: dòng câu triết lý. */
  reflection: "💡 Suy ngẫm: ",
} as const;

/** Dấu ngoặc kép cong bao quanh câu cổ vũ của digest_morning. */
export const QUOTE = { open: "“", close: "”" } as const;

/** Tiêu đề thông báo (todo / checklist) tối đa chừng này ký tự, kể cả dấu "…" khi bị cắt. */
export const PUSH_TITLE_MAX_CHARS = 60;

/** Nội dung nhắc todo theo (quan trọng, khẩn cấp). */
export const TODO_REMINDER_BODY = {
  importantUrgent: "Quan trọng, khẩn cấp → Làm ngay!",
  importantOnly: "Quan trọng → Dành thời gian làm thật tốt.",
  urgentOnly: "Khẩn cấp → Xử lý nhanh rồi chuyển việc.",
  neither: "Việc nhẹ → Làm gọn rồi tiếp tục nhé.",
  /** Chưa phân loại (ít nhất một trong hai là null): không đoán. */
  unknown: "Đến giờ thực hiện",
} as const;

/** Nội dung nhắc checklist theo lịch. */
export const CHECKLIST_DUE_BODY = {
  base: "Đến giờ thực hiện",
  /** Ghép sau `base` khi biết số bước. */
  stepsSeparator: " · ",
  stepsSuffix: " bước",
} as const;

/** Nội dung nhắc checklist đã chạy 30 phút. */
export const CHECKLIST_30M_BODY = {
  prefix: "Đã chạy 30 phút · còn ",
  suffix: " bước chưa tick. Rà lại cho đủ nhé!",
} as const;

/** Tiêu đề thay thế khi todo/checklist không có tiêu đề dùng được. */
export const FALLBACK_TITLE = {
  todo: "Todo",
  checklist: "Checklist",
} as const;

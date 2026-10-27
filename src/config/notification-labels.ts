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
  /** digest_review: dòng số liệu của hôm nay. */
  today: "📋 Hôm nay: ",
  /** digest_review: dòng lời nhắc rà soát + lên kế hoạch. */
  review: "🌙 ",
} as const;

/** Nội dung digest_review (rà soát cuối ngày). Số liệu: x/T todo xong, y/H thói quen. */
export const REVIEW_BODY = {
  /** Ghép sau DIGEST_LABELS.today: "3/5 todo xong · 2/3 thói quen". */
  todosDone: " todo xong",
  habitsDone: " thói quen",
  separator: " · ",
  /** Còn việc chưa xong: rà lại rồi lên kế hoạch. */
  pending: "Rà lại phần chưa xong & lên kế hoạch cho ngày mai để tiến bộ hơn nhé!",
  /** Xong hết mọi thứ của hôm nay. */
  allDone: "Tuyệt vời! Lên kế hoạch cho ngày mai để tiến bộ hơn nữa nhé!",
  /** Hôm nay không có todo hay thói quen nào. */
  empty: "Hôm nay chưa có todo hay thói quen. Lên kế hoạch cho ngày mai nhé!",
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

/**
 * Nhắc LẶP khi bỏ lỡ giờ hẹn (todo_overdue, checklist_overdue). Tiêu đề vẫn là tên todo/checklist,
 * nội dung chỉ nói giờ đã lỡ và việc nên làm: "⏰ Quá giờ 10:00 · Làm ngay hoặc dời lịch!".
 */
export const OVERDUE_BODY = {
  prefix: "⏰ Quá giờ ",
  suffix: " · Làm ngay hoặc dời lịch!",
} as const;

/**
 * Nhắc checklist đang làm dở (checklist_running). Tiêu đề là tên checklist; nội dung chỉ một dòng
 * ngắn: thời gian đã làm hoặc "hôm qua chưa xong", rồi số bước còn lại.
 *   ⏳ Đã làm 2 giờ · còn 3 bước chưa tick
 *   🌅 Hôm qua chưa xong · còn 3 bước chưa tick
 */
export const CHECKLIST_RUNNING_BODY = {
  /** Ghép: prefix + số giờ + hoursSuffix + số bước + stepsSuffix. */
  hourlyPrefix: "⏳ Đã làm ",
  hourlySuffix: " giờ · còn ",
  carryoverPrefix: "🌅 Hôm qua chưa xong · còn ",
  stepsSuffix: " bước chưa tick",
} as const;

/**
 * Tổng kết todo "quan trọng & không khẩn cấp" quá hạn (digest_overdue_*). Số lượng nằm ngay ở
 * tiêu đề để nhìn vào là hiểu, nội dung chỉ là việc cần làm:
 *   ⏰ 3 todo quan trọng quá hạn            (17:00 cùng ngày)
 *   ⏰ 3 todo quan trọng hôm qua chưa xong  (07:00 sáng hôm sau)
 *   Làm ngay hoặc dời lịch!
 */
export const OVERDUE_DIGEST_TEXT = {
  prefix: "⏰ ",
  eveningSuffix: " todo quan trọng quá hạn",
  morningSuffix: " todo quan trọng hôm qua chưa xong",
  body: "Làm ngay hoặc dời lịch!",
} as const;

/** Tiêu đề thay thế khi todo/checklist không có tiêu đề dùng được. */
export const FALLBACK_TITLE = {
  todo: "Todo",
  checklist: "Checklist",
} as const;

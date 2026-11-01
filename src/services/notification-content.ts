/**
 * Dựng nội dung thông báo. Mọi hàm ở đây là HÀM THUẦN (không DB, không đồng hồ): số liệu
 * được truyền vào, kết quả chỉ phụ thuộc đầu vào, nên dễ kiểm thử từng nhánh.
 *
 * Quy ước: hàm trả `null` nghĩa là "không có gì để gửi" (job sẽ được hủy, không gửi).
 * Với ngày D theo múi giờ người dùng: T = số todo của ngày D, Done = số đã xong, R = T - Done,
 * H = số thói quen cần duy trì, x = số đã duy trì.
 *
 * Nhãn, biểu tượng và câu chữ cố định nằm ở config/notification-labels.ts.
 */
import {
  CHECKLIST_DUE_BODY,
  CHECKLIST_RUNNING_BODY,
  DIGEST_LABELS,
  DIGEST_SEPARATOR,
  FALLBACK_TITLE,
  OVERDUE_BODY,
  OVERDUE_DIGEST_TEXT,
  PUSH_TITLE_MAX_CHARS,
  QUOTE,
  REVIEW_BODY,
  TODO_REMINDER_BODY,
} from "../config/notification-labels.js";
import { cheerForDate, philosophyForDate } from "./notification-phrases.js";

export type DigestStats = {
  /** T */
  totalTodos: number;
  /** Done */
  doneTodos: number;
  /** H */
  habitsTotal: number;
  /** x */
  habitsDone: number;
};

export type NotificationText = { title: string; body: string };

const MAX_TITLE_IN_BODY = 80;

const clip = (text: string, max: number): string => {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
};

/**
 * Chuẩn hóa tiêu đề dùng cho thông báo: Unicode NFC, bỏ xuống dòng/tab, thu gọn khoảng trắng,
 * cắt tối đa `max` ký tự (kể cả dấu "…" khi bị cắt). Cắt theo ký tự Unicode nên không làm
 * vỡ emoji; rỗng thì dùng `fallback`.
 */
export const normalizePushTitle = (
  text: string | null | undefined,
  fallback: string,
  max: number = PUSH_TITLE_MAX_CHARS
): string => {
  const collapsed = (text ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  const base = collapsed === "" ? fallback : collapsed;
  const chars = Array.from(base);
  if (chars.length <= max) return base;
  return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
};

const nonNegativeInt = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const normalize = (stats: DigestStats): DigestStats => {
  const totalTodos = nonNegativeInt(stats.totalTodos);
  const habitsTotal = nonNegativeInt(stats.habitsTotal);
  return {
    totalTodos,
    doneTodos: Math.min(nonNegativeInt(stats.doneTodos), totalTodos),
    habitsTotal,
    habitsDone: Math.min(nonNegativeInt(stats.habitsDone), habitsTotal),
  };
};

/** Nối các dòng bằng "\n", bỏ qua dòng không có. */
const lines = (...parts: Array<string | null>): string =>
  parts.filter((part): part is string => part !== null).join("\n");

/**
 * digest_morning: luôn gửi. Hai khối cách nhau MỘT dòng trống:
 *   📋 Hôm nay: <số liệu todo + thói quen, một dòng ngắn: số trước, chữ sau>
 *   (dòng trống)
 *   💪 Động lực: “<câu cổ vũ>”
 *   💡 Suy ngẫm: <câu triết lý>
 * Phần nào bằng 0 thì bỏ khỏi dòng số liệu (không in "0 todo").
 */
export const buildMorningDigest = (
  rawStats: DigestStats,
  localDate: string
): NotificationText => {
  const { totalTodos: t, doneTodos: done, habitsTotal: h } = normalize(rawStats);
  const remaining = t - done;

  let summary: string;
  if (t === 0 && h === 0) {
    summary = `${DIGEST_LABELS.progress}Hôm nay chưa có todo hay thói quen. Thêm một mục tiêu nhỏ nhé!`;
  } else {
    let todos: string | null = null;
    if (t > 0 && done === 0) todos = `${t} todo`;
    else if (t > 0 && done < t) todos = `${t} todo (xong ${done}, còn ${remaining})`;
    else if (t > 0) todos = `xong cả ${t} todo`;
    const habits = h > 0 ? `${h} thói quen` : null;
    summary = `${DIGEST_LABELS.today}${[todos, habits]
      .filter((part): part is string => part !== null)
      .join(DIGEST_SEPARATOR)}`;
  }

  return {
    title: "Chào buổi sáng",
    body: lines(
      summary,
      "",
      `${DIGEST_LABELS.motivation}${QUOTE.open}${cheerForDate(localDate)}${QUOTE.close}`,
      `${DIGEST_LABELS.reflection}${philosophyForDate(localDate)}`
    ),
  };
};

/**
 * digest_todos: bỏ qua (null) nếu hôm nay không có todo nào.
 *   📋 Xong <x>/<T> todo · còn <R> đang chờ     (hoặc "Xong cả <T> todo hôm nay")
 *   💪 <phần khích lệ>      (chỉ khi có)
 */
export const buildTodosDigest = (
  rawStats: DigestStats
): NotificationText | null => {
  const { totalTodos: t, doneTodos: done } = normalize(rawStats);
  if (t === 0) return null;
  const remaining = t - done;

  let progress: string;
  let encouragement: string | null = null;
  if (remaining === 0) {
    progress = `Xong cả ${t} todo hôm nay`;
    encouragement = "Tuyệt vời!";
  } else {
    progress = `Xong ${done}/${t} todo${DIGEST_SEPARATOR}còn ${remaining} đang chờ`;
    if (done === 0) encouragement = "Hãy bắt đầu bằng việc nhỏ nhất!";
  }
  return {
    title: "Tổng kết todo hôm nay",
    body: lines(
      `${DIGEST_LABELS.progress}${progress}`,
      encouragement === null ? null : `${DIGEST_LABELS.encouragement}${encouragement}`
    ),
  };
};

/**
 * digest_habits: bỏ qua (null) nếu hôm nay không có thói quen nào cần duy trì.
 *   📋 Đã duy trì <x>/<H> thói quen     (hoặc "Đã duy trì đủ <H>/<H> thói quen")
 *   💪 <phần khích lệ>      (chỉ khi có)
 */
export const buildHabitsDigest = (
  rawStats: DigestStats
): NotificationText | null => {
  const { habitsTotal: h, habitsDone: x } = normalize(rawStats);
  if (h === 0) return null;

  let progress: string;
  let encouragement: string | null = null;
  if (x === 0) {
    progress = `Đã duy trì 0/${h} thói quen`;
    encouragement = "Vẫn còn thời gian để làm một thói quen nhỏ trước khi hết ngày!";
  } else if (x < h) {
    progress = `Đã duy trì ${x}/${h} thói quen`;
  } else {
    progress = `Đã duy trì đủ ${h}/${h} thói quen`;
    encouragement = "Tuyệt vời!";
  }
  return {
    title: "Tổng kết thói quen",
    body: lines(
      `${DIGEST_LABELS.progress}${progress}`,
      encouragement === null ? null : `${DIGEST_LABELS.encouragement}${encouragement}`
    ),
  };
};

/**
 * digest_review (rà soát cuối ngày): LUÔN gửi, kể cả khi hôm nay trống (đây là lời nhắc thói quen
 * lên kế hoạch). Hai dòng:
 *   📋 Hôm nay: <x>/<T> todo xong · <y>/<H> thói quen     (bỏ phần không có; bỏ cả dòng nếu cả hai = 0)
 *   🌙 <lời nhắc rà soát + lên kế hoạch ngày mai>
 */
export const buildReviewDigest = (rawStats: DigestStats): NotificationText => {
  const { totalTodos: t, doneTodos: done, habitsTotal: h, habitsDone: x } = normalize(rawStats);

  const parts: string[] = [];
  if (t > 0) parts.push(`${done}/${t}${REVIEW_BODY.todosDone}`);
  if (h > 0) parts.push(`${x}/${h}${REVIEW_BODY.habitsDone}`);

  let prompt: string;
  if (t === 0 && h === 0) prompt = REVIEW_BODY.empty;
  else if (done === t && x === h) prompt = REVIEW_BODY.allDone;
  else prompt = REVIEW_BODY.pending;

  return {
    title: "Rà soát cuối ngày",
    body: lines(
      parts.length === 0
        ? null
        : `${DIGEST_LABELS.today}${parts.join(REVIEW_BODY.separator)}`,
      `${DIGEST_LABELS.review}${prompt}`
    ),
  };
};

type Flag = number | boolean | null | undefined;

const toKnownFlag = (value: Flag): boolean | null => {
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  return null;
};

/** Nội dung nhắc todo theo (quan trọng, khẩn cấp); thiếu một trong hai thì không đoán. */
export const todoPriorityBody = (isImportant: Flag, isUrgent: Flag): string => {
  const important = toKnownFlag(isImportant);
  const urgent = toKnownFlag(isUrgent);
  if (important === null || urgent === null) return TODO_REMINDER_BODY.unknown;
  if (important && urgent) return TODO_REMINDER_BODY.importantUrgent;
  if (important) return TODO_REMINDER_BODY.importantOnly;
  if (urgent) return TODO_REMINDER_BODY.urgentOnly;
  return TODO_REMINDER_BODY.neither;
};

/** todo_reminder: tiêu đề = tiêu đề todo; nội dung = mức quan trọng/khẩn cấp. */
export const buildTodoReminder = (
  todoTitle: string,
  isImportant: Flag,
  isUrgent: Flag
): NotificationText => ({
  title: normalizePushTitle(todoTitle, FALLBACK_TITLE.todo),
  body: todoPriorityBody(isImportant, isUrgent),
});

/** Khoảng trễ dễ đọc: "1 giờ", "2 giờ", "45 phút", "1 giờ 30 phút"; tối thiểu 1 phút. */
const formatLate = (lateMinutes: number): string => {
  const total = Math.max(1, nonNegativeInt(lateMinutes));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes}${OVERDUE_BODY.minute}`;
  const hoursText = `${hours}${OVERDUE_BODY.hour}`;
  return minutes === 0 ? hoursText : `${hoursText} ${minutes}${OVERDUE_BODY.minute}`;
};

/**
 * todo_overdue: tiêu đề = tiêu đề todo; `scheduledTime` = giờ đặt của todo (HH:mm); `lateMinutes` = đã
 * trễ bao nhiêu phút tại mốc nhắc này. Mỗi nhắc lặp thay nhắc trước của cùng todo nên nội dung phải
 * tự nói được mức trễ hiện tại: "⏰ Trễ 2 giờ (hẹn 10:00) · Làm ngay hoặc dời lịch!".
 */
export const buildTodoOverdue = (
  todoTitle: string,
  scheduledTime: string,
  lateMinutes: number
): NotificationText => ({
  title: normalizePushTitle(todoTitle, FALLBACK_TITLE.todo),
  body:
    `${OVERDUE_BODY.prefix}${formatLate(lateMinutes)}` +
    `${OVERDUE_BODY.scheduledPrefix}${scheduledTime}${OVERDUE_BODY.suffix}`,
});

/**
 * digest_overdue_evening (17:00): "⏰ {x} todo quan trọng quá hạn" + "Làm ngay hoặc dời lịch!".
 * x = số todo quan trọng & không khẩn cấp của hôm nay đã quá giờ hẹn mà chưa xong; null nếu x = 0.
 */
export const buildOverdueEveningDigest = (count: number): NotificationText | null => {
  const n = nonNegativeInt(count);
  if (n === 0) return null;
  return {
    title: `${OVERDUE_DIGEST_TEXT.prefix}${n}${OVERDUE_DIGEST_TEXT.eveningSuffix}`,
    body: OVERDUE_DIGEST_TEXT.body,
  };
};

/** digest_overdue_morning (07:00): như trên nhưng nói rõ là việc của hôm qua; null nếu x = 0. */
export const buildOverdueMorningDigest = (count: number): NotificationText | null => {
  const n = nonNegativeInt(count);
  if (n === 0) return null;
  return {
    title: `${OVERDUE_DIGEST_TEXT.prefix}${n}${OVERDUE_DIGEST_TEXT.morningSuffix}`,
    body: OVERDUE_DIGEST_TEXT.body,
  };
};

/** N = thời gian ước lượng ban đầu của đếm ngược, làm tròn theo phút (tối thiểu 1). */
export const buildTimerEnd = (
  todoTitle: string,
  estimatedSeconds: number | null
): NotificationText => {
  const name = clip(todoTitle, MAX_TITLE_IN_BODY);
  const tail = "Hãy đánh dấu hoàn thành hoặc bắt đầu lại nếu cần nhé.";
  if (estimatedSeconds === null || !Number.isFinite(estimatedSeconds) || estimatedSeconds <= 0) {
    return {
      title: "Hết giờ đếm ngược",
      body: `“${name}” đã hết giờ đếm ngược. ${tail}`,
    };
  }
  const minutes = Math.max(1, Math.round(estimatedSeconds / 60));
  return {
    title: "Hết giờ đếm ngược",
    body: `“${name}” đã đủ ${minutes} phút. ${tail}`,
  };
};

/** checklist_due: tiêu đề = tiêu đề checklist; nội dung kèm số bước (không có bước thì bỏ phần đó). */
export const buildChecklistDue = (
  checklistTitle: string,
  stepCount: number
): NotificationText => {
  const n = nonNegativeInt(stepCount);
  return {
    title: normalizePushTitle(checklistTitle, FALLBACK_TITLE.checklist),
    body:
      n === 0
        ? CHECKLIST_DUE_BODY.base
        : `${CHECKLIST_DUE_BODY.base}${CHECKLIST_DUE_BODY.stepsSeparator}${n}${CHECKLIST_DUE_BODY.stepsSuffix}`,
  };
};

/**
 * checklist_running, mốc theo giờ: "⏳ Đã làm 2 giờ · còn 3 bước chưa tick". `hours` = số giờ từ lúc
 * bắt đầu tới mốc này. null nếu đã tick hết (n = số bước chưa tick, tính lúc gửi).
 */
export const buildChecklistRunning = (
  checklistTitle: string,
  pendingSteps: number,
  hours: number
): NotificationText | null => {
  const n = nonNegativeInt(pendingSteps);
  if (n === 0) return null;
  const h = Math.max(1, nonNegativeInt(hours));
  return {
    title: normalizePushTitle(checklistTitle, FALLBACK_TITLE.checklist),
    body:
      `${CHECKLIST_RUNNING_BODY.hourlyPrefix}${h}${CHECKLIST_RUNNING_BODY.hourlySuffix}` +
      `${n}${CHECKLIST_RUNNING_BODY.stepsSuffix}`,
  };
};

/**
 * checklist_running, mốc 06:00 sáng hôm sau: "🌅 Hôm qua chưa xong · còn 3 bước chưa tick".
 * null nếu đã tick hết.
 */
export const buildChecklistCarryover = (
  checklistTitle: string,
  pendingSteps: number
): NotificationText | null => {
  const n = nonNegativeInt(pendingSteps);
  if (n === 0) return null;
  return {
    title: normalizePushTitle(checklistTitle, FALLBACK_TITLE.checklist),
    body: `${CHECKLIST_RUNNING_BODY.carryoverPrefix}${n}${CHECKLIST_RUNNING_BODY.stepsSuffix}`,
  };
};

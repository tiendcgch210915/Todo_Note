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
  CHECKLIST_30M_BODY,
  CHECKLIST_DUE_BODY,
  DIGEST_LABELS,
  FALLBACK_TITLE,
  OVERDUE_BODY,
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
 *   📋 Nhiệm vụ: <số liệu todo + thói quen, một dòng>
 *   (dòng trống)
 *   💪 Động lực: “<câu cổ vũ>”
 *   💡 Suy ngẫm: <câu triết lý>
 */
export const buildMorningDigest = (
  rawStats: DigestStats,
  localDate: string
): NotificationText => {
  const { totalTodos: t, doneTodos: done, habitsTotal: h } = normalize(rawStats);
  const remaining = t - done;

  let summary: string;
  if (t === 0 && h === 0) {
    summary =
      "Hôm nay chưa có todo hay thói quen nào. Thử thêm một mục tiêu nhỏ để khởi động ngày mới nhé!";
  } else if (done === 0) {
    summary = `Hôm nay bạn có ${t} todo cần hoàn thành & ${h} thói quen cần duy trì.`;
  } else if (done < t) {
    summary = `Hôm nay bạn có ${t} todo (đã xong ${done}, còn ${remaining}) & ${h} thói quen cần duy trì.`;
  } else {
    summary = `Bạn đã hoàn thành cả ${t} todo hôm nay! Còn ${h} thói quen để duy trì.`;
  }

  return {
    title: "Chào buổi sáng",
    body: lines(
      `${DIGEST_LABELS.tasks}${summary}`,
      "",
      `${DIGEST_LABELS.motivation}${QUOTE.open}${cheerForDate(localDate)}${QUOTE.close}`,
      `${DIGEST_LABELS.reflection}${philosophyForDate(localDate)}`
    ),
  };
};

/**
 * digest_todos: bỏ qua (null) nếu hôm nay không có todo nào.
 *   📋 Tiến độ: <số liệu>
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
  if (done === 0) {
    progress = `Hôm nay chưa có todo nào hoàn thành, còn ${remaining} todo đang chờ bạn.`;
    encouragement = "Hãy bắt đầu bằng việc nhỏ nhất!";
  } else if (remaining > 0) {
    progress = `Bạn đã hoàn thành ${done} todo rồi, còn lại ${remaining} todo nữa vẫn đang chờ bạn.`;
  } else {
    progress = `Bạn đã hoàn thành cả ${done} todo hôm nay.`;
    encouragement = "Tuyệt vời!";
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
 *   📋 Thói quen: <số liệu>
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
    progress = "Hôm nay bạn chưa duy trì thói quen nào.";
    encouragement = "Vẫn còn thời gian để làm một thói quen nhỏ trước khi hết ngày!";
  } else if (x < h) {
    progress = `Hôm nay bạn đã duy trì được ${x}/${h} thói quen.`;
  } else {
    progress = `Bạn đã duy trì đủ ${h}/${h} thói quen hôm nay.`;
    encouragement = "Tuyệt vời!";
  }
  return {
    title: "Tổng kết thói quen",
    body: lines(
      `${DIGEST_LABELS.habits}${progress}`,
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

/** Nội dung nhắc lặp: giờ hẹn đã lỡ (HH:mm) + việc nên làm. */
const overdueBody = (scheduledTime: string): string =>
  `${OVERDUE_BODY.prefix}${scheduledTime}${OVERDUE_BODY.suffix}`;

/** todo_overdue: tiêu đề = tiêu đề todo; `scheduledTime` = giờ đặt của todo (HH:mm). */
export const buildTodoOverdue = (
  todoTitle: string,
  scheduledTime: string
): NotificationText => ({
  title: normalizePushTitle(todoTitle, FALLBACK_TITLE.todo),
  body: overdueBody(scheduledTime),
});

/** checklist_overdue: tiêu đề = tiêu đề checklist; `scheduledTime` = giờ của lần xuất hiện hôm nay. */
export const buildChecklistOverdue = (
  checklistTitle: string,
  scheduledTime: string
): NotificationText => ({
  title: normalizePushTitle(checklistTitle, FALLBACK_TITLE.checklist),
  body: overdueBody(scheduledTime),
});

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

/** checklist_30m: null nếu đã tick hết (n = số bước chưa tick, tính lúc gửi). */
export const buildChecklist30m = (
  checklistTitle: string,
  pendingSteps: number
): NotificationText | null => {
  const n = nonNegativeInt(pendingSteps);
  if (n === 0) return null;
  return {
    title: normalizePushTitle(checklistTitle, FALLBACK_TITLE.checklist),
    body: `${CHECKLIST_30M_BODY.prefix}${n}${CHECKLIST_30M_BODY.suffix}`,
  };
};

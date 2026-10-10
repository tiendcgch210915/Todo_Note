/**
 * Dựng nội dung thông báo. Mọi hàm ở đây là HÀM THUẦN (không DB, không đồng hồ): số liệu
 * được truyền vào, kết quả chỉ phụ thuộc đầu vào, nên dễ kiểm thử từng nhánh.
 *
 * Quy ước: hàm trả `null` nghĩa là "không có gì để gửi" (job sẽ được hủy, không gửi).
 * Với ngày D theo múi giờ người dùng: T = số todo của ngày D, Done = số đã xong, R = T - Done,
 * H = số thói quen cần duy trì, x = số đã duy trì.
 */
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
const MAX_REMINDER_BODY = 200;

const clip = (text: string, max: number): string => {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
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

/** digest_morning: luôn gửi. Số liệu + 1 câu cổ vũ + 1 câu triết lý (chọn theo ngày). */
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
    body: [summary, cheerForDate(localDate), philosophyForDate(localDate)].join("\n"),
  };
};

/** digest_todos: bỏ qua (null) nếu hôm nay không có todo nào. */
export const buildTodosDigest = (
  rawStats: DigestStats
): NotificationText | null => {
  const { totalTodos: t, doneTodos: done } = normalize(rawStats);
  if (t === 0) return null;
  const remaining = t - done;

  let body: string;
  if (done === 0) {
    body = `Hôm nay chưa có todo nào hoàn thành, còn ${remaining} todo đang chờ bạn. Hãy bắt đầu bằng việc nhỏ nhất!`;
  } else if (remaining > 0) {
    body = `Bạn đã hoàn thành ${done} todo rồi, còn lại ${remaining} todo nữa vẫn đang chờ bạn.`;
  } else {
    body = `Tuyệt vời! Bạn đã hoàn thành cả ${done} todo hôm nay.`;
  }
  return { title: "Tổng kết todo hôm nay", body };
};

/** digest_habits: bỏ qua (null) nếu hôm nay không có thói quen nào cần duy trì. */
export const buildHabitsDigest = (
  rawStats: DigestStats
): NotificationText | null => {
  const { habitsTotal: h, habitsDone: x } = normalize(rawStats);
  if (h === 0) return null;

  let body: string;
  if (x === 0) {
    body =
      "Hôm nay bạn chưa duy trì thói quen nào, vẫn còn thời gian để làm một thói quen nhỏ trước khi hết ngày!";
  } else if (x < h) {
    body = `Hôm nay bạn đã duy trì được ${x}/${h} thói quen.`;
  } else {
    body = `Tuyệt vời! Bạn đã duy trì đủ ${h}/${h} thói quen hôm nay.`;
  }
  return { title: "Tổng kết thói quen", body };
};

export const buildTodoReminder = (todoTitle: string): NotificationText => ({
  title: "Đến giờ thực hiện",
  body: clip(todoTitle, MAX_REMINDER_BODY),
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

/** checklist_30m: null nếu đã tick hết (n = số bước chưa tick, tính lúc gửi). */
export const buildChecklist30m = (
  checklistName: string,
  pendingSteps: number
): NotificationText | null => {
  const n = nonNegativeInt(pendingSteps);
  if (n === 0) return null;
  return {
    title: "Checklist đang chạy",
    body: `Checklist “${clip(checklistName, MAX_TITLE_IN_BODY)}” đã chạy 30 phút. Còn ${n} bước chưa tick, hãy kiểm tra lại cho đầy đủ nhé.`,
  };
};

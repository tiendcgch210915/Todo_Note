/**
 * Quy tắc lặp dùng chung cho todo và lịch checklist: cùng từ vựng
 * (`recurrence_type` / `recurrence_interval` / `recurrence_days_of_week` / `recurrence_end_date`)
 * và cùng một thuật toán, để hai nơi không thể lệch nhau.
 *
 * Hàm thuần, chỉ làm số học trên chuỗi ngày `YYYY-MM-DD` (không múi giờ, không đồng hồ).
 * Chuyển nguyên từ `services/todos.ts`; hành vi giữ nguyên.
 */
import { addDays } from "./time.js";

export type RecurrenceType = "daily" | "weekly" | "custom";

export type RecurrenceRule = {
  type: RecurrenceType | null;
  interval: number | null;
  /** Chuỗi "1,3,5", T2 = 1 ... CN = 7. */
  daysOfWeek: string | null;
  /** Ngày cuối cùng (bao gồm) còn được phép xuất hiện. */
  endDate: string | null;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isIsoDate = (value: string): boolean => ISO_DATE_RE.test(value);

const safeInterval = (interval: number | null): number =>
  interval !== null && interval > 0 ? interval : 1;

/** Thứ trong tuần kiểu ISO: T2 = 1 ... CN = 7; null nếu ngày không hợp lệ. */
export const isoWeekdayOf = (date: string): number | null => {
  if (!ISO_DATE_RE.test(date)) return null;
  const d = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getUTCDay();
  return day === 0 ? 7 : day;
};

export const parseWeekdays = (raw: string | null): number[] => {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isInteger(v) && v >= 1 && v <= 7)
    ),
  ].sort((a, b) => a - b);
};

/**
 * `date` có phải một ngày mà quy tắc cho phép xuất hiện không. Chỉ `weekly` có thứ mới lọc theo
 * thứ trong tuần; các dạng còn lại tính từ lần trước nên ngày nào cũng hợp lệ. Cùng cách hiểu với
 * `nextRecurrenceDateAfter` (kể cả `custom`: mỗi N ngày, bỏ qua thứ).
 */
export const ruleAllowsDate = (rule: RecurrenceRule, date: string): boolean => {
  if (!rule.type || !ISO_DATE_RE.test(date)) return false;
  if (rule.type !== "weekly") return true;
  const weekdays = parseWeekdays(rule.daysOfWeek);
  if (weekdays.length === 0) return true;
  const weekday = isoWeekdayOf(date);
  return weekday !== null && weekdays.includes(weekday);
};

/**
 * Ngày hợp lệ ĐẦU TIÊN từ `from` trở đi (gồm cả `from`), hoặc null nếu không còn (quá `endDate`,
 * không có quy tắc, ngày sai định dạng). Dùng để dời một lần xuất hiện đã tạo sẵn khi quy tắc đổi.
 */
export const firstRuleDateOnOrAfter = (
  rule: RecurrenceRule,
  from: string
): string | null => {
  if (!rule.type || !ISO_DATE_RE.test(from)) return null;

  let date = from;
  // Có ít nhất một thứ hợp lệ thì tối đa 7 ngày là gặp; vòng lặp chỉ là chốt chặn.
  for (let i = 0; i < 7 && !ruleAllowsDate(rule, date); i++) {
    date = addDays(date, 1);
  }
  if (!ruleAllowsDate(rule, date)) return null;

  if (rule.endDate && ISO_DATE_RE.test(rule.endDate) && date > rule.endDate) {
    return null;
  }
  return date;
};

/**
 * Lần xuất hiện KẾ TIẾP sau `from` theo quy tắc, hoặc null nếu không còn (hết `endDate`, không có
 * quy tắc, ngày sai định dạng).
 *  - daily / custom: cộng `interval` ngày.
 *  - weekly không có thứ: cộng `interval` tuần (giữ nguyên thứ của `from`).
 *  - weekly có thứ: thứ kế tiếp trong cùng tuần, hết tuần thì nhảy `interval` tuần tới thứ đầu tiên.
 */
export const nextRecurrenceDateAfter = (
  rule: RecurrenceRule,
  from: string
): string | null => {
  if (!rule.type) return null;
  if (!ISO_DATE_RE.test(from)) return null;

  const interval = safeInterval(rule.interval);
  let nextDate: string;
  if (rule.type === "weekly") {
    const weekdays = parseWeekdays(rule.daysOfWeek);
    const currentWeekday = isoWeekdayOf(from);
    if (currentWeekday === null) return null;

    if (weekdays.length === 0) {
      nextDate = addDays(from, interval * 7);
    } else {
      const laterThisWeek = weekdays.find((day) => day > currentWeekday);
      if (laterThisWeek !== undefined) {
        nextDate = addDays(from, laterThisWeek - currentWeekday);
      } else {
        nextDate = addDays(
          from,
          7 - currentWeekday + (interval - 1) * 7 + weekdays[0]
        );
      }
    }
  } else {
    nextDate = addDays(from, interval);
  }

  if (rule.endDate && ISO_DATE_RE.test(rule.endDate) && nextDate > rule.endDate) {
    return null;
  }
  return nextDate;
};

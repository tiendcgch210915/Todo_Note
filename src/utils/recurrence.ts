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

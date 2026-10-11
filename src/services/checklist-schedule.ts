/**
 * Mở rộng lịch checklist thành các lần xuất hiện cụ thể. HÀM THUẦN: chỉ số học trên chuỗi ngày
 * `YYYY-MM-DD` (ngày địa phương của người dùng), không DB, không đồng hồ, không múi giờ.
 * Múi giờ chỉ tham gia ở nơi đổi (ngày, giờ) sang thời điểm UTC (job thông báo) và khi quyết định
 * một run hoàn thành thuộc ngày nào.
 *
 * Quy tắc lặp dùng CHUNG với todo (utils/recurrence.ts): cùng từ vựng, cùng thuật toán. Như gốc
 * chuỗi todo, `start_date` luôn là lần xuất hiện đầu tiên, kể cả khi thứ của nó không nằm trong
 * `recurrence_days_of_week`; các lần sau đi theo `nextRecurrenceDateAfter`.
 */
import { addDays, dayDiff } from "../utils/time.js";
import {
  isIsoDate,
  isoWeekdayOf,
  nextRecurrenceDateAfter,
  parseWeekdays,
  type RecurrenceRule,
  type RecurrenceType,
} from "../utils/recurrence.js";

/** GET /checklists/occurrences nhận khoảng ngày tối đa chừng này (tính cả hai đầu). */
export const MAX_OCCURRENCE_RANGE_DAYS = 62;

/** Chặn vòng lặp khi dữ liệu lạ; một khoảng 62 ngày không bao giờ cần tới mức này. */
const MAX_STEPS = 10_000;

export type ScheduleRule = {
  templateId: string;
  startDate: string;
  /** Giờ mặc định "HH:mm" của các lần xuất hiện. */
  time: string;
  recurrenceType: RecurrenceType | null;
  recurrenceInterval: number | null;
  recurrenceDaysOfWeek: string | null;
  recurrenceEndDate: string | null;
  enabled: boolean;
};

/** Đổi giờ của MỘT ngày cụ thể. */
export type ScheduleOverride = { localDate: string; time: string };

export type ChecklistOccurrence = {
  checklistId: string;
  date: string;
  time: string;
  overridden: boolean;
};

/** Hình dạng tối thiểu của một dòng checklist_schedules (không phụ thuộc repository). */
export type ScheduleRowLike = {
  template_id: string;
  start_date: string;
  time: string;
  recurrence_type: RecurrenceType | null;
  recurrence_interval: number | null;
  recurrence_days_of_week: string | null;
  recurrence_end_date: string | null;
  /** 0 | 1 */
  enabled: number;
};

export const toScheduleRule = (row: ScheduleRowLike): ScheduleRule => ({
  templateId: row.template_id,
  startDate: row.start_date,
  time: row.time,
  recurrenceType: row.recurrence_type,
  recurrenceInterval: row.recurrence_interval,
  recurrenceDaysOfWeek: row.recurrence_days_of_week,
  recurrenceEndDate: row.recurrence_end_date,
  enabled: row.enabled === 1,
});

const ruleOf = (schedule: ScheduleRule): RecurrenceRule => ({
  type: schedule.recurrenceType,
  interval: schedule.recurrenceInterval,
  daysOfWeek: schedule.recurrenceDaysOfWeek,
  endDate: schedule.recurrenceEndDate,
});

const stepInterval = (interval: number | null): number =>
  interval !== null && interval > 0 ? interval : 1;

/**
 * Nhảy gần tới `from` để không phải duyệt từ ngày bắt đầu (planner chạy mỗi phút). Kết quả là
 * một mốc `cursor <= from` mà từ đó thuật toán "ngày kế tiếp" cho ra đúng các lần xuất hiện sau
 * đó. Trả null nếu không cần/không nên nhảy.
 */
const fastForward = (
  schedule: ScheduleRule,
  from: string
): { cursor: string; cursorIsOccurrence: boolean } | null => {
  const interval = stepInterval(schedule.recurrenceInterval);
  const weekdays = parseWeekdays(schedule.recurrenceDaysOfWeek);

  // daily / custom / weekly không chọn thứ: các lần xuất hiện là start + n * bước.
  if (schedule.recurrenceType !== "weekly" || weekdays.length === 0) {
    const step = (schedule.recurrenceType === "weekly" ? 7 : 1) * interval;
    const k = Math.floor(dayDiff(schedule.startDate, from) / step);
    if (k <= 0) return null;
    return { cursor: addDays(schedule.startDate, k * step), cursorIsOccurrence: true };
  }

  // weekly có chọn thứ: các "khối" tuần cách nhau interval tuần, tính từ thứ Hai của tuần chứa
  // start_date. Neo vào Chủ nhật của một khối đã qua: từ đó "ngày kế tiếp" nhảy đúng sang khối sau.
  const weekdayOfStart = isoWeekdayOf(schedule.startDate);
  if (weekdayOfStart === null) return null;
  const period = interval * 7;
  const startMonday = addDays(schedule.startDate, 1 - weekdayOfStart);
  const k = Math.ceil((dayDiff(startMonday, from) - 6) / period) - 1;
  if (k <= 0) return null;
  return { cursor: addDays(startMonday, k * period + 6), cursorIsOccurrence: false };
};

/**
 * Các ngày lịch xuất hiện trong [from, to] (chưa tính ghi đè). Lịch tắt, khoảng ngày sai hoặc
 * lịch có `start_date` sau `recurrence_end_date` thì rỗng.
 */
export const baseOccurrenceDates = (
  schedule: ScheduleRule,
  from: string,
  to: string
): string[] => {
  if (!schedule.enabled) return [];
  if (!isIsoDate(from) || !isIsoDate(to) || !isIsoDate(schedule.startDate)) return [];
  if (from > to || schedule.startDate > to) return [];
  const endDate = schedule.recurrenceEndDate;
  if (endDate && schedule.startDate > endDate) return [];

  const out: string[] = [];
  const visit = (date: string): void => {
    if (date >= from && date <= to && (!endDate || date <= endDate)) out.push(date);
  };

  const rule = ruleOf(schedule);
  if (!rule.type) {
    visit(schedule.startDate); // không lặp: đúng một lần
    return out;
  }

  let cursor = schedule.startDate;
  let cursorIsOccurrence = true;
  if (schedule.startDate < from) {
    const jump = fastForward(schedule, from);
    if (jump) {
      cursor = jump.cursor;
      cursorIsOccurrence = jump.cursorIsOccurrence;
    }
  }
  if (cursorIsOccurrence) visit(cursor);

  for (let guard = 0; guard < MAX_STEPS; guard++) {
    const next = nextRecurrenceDateAfter(rule, cursor);
    if (!next || next > to) break;
    visit(next);
    cursor = next;
  }
  return out;
};

/**
 * Các lần xuất hiện trong [from, to] kèm giờ (đã áp ghi đè theo ngày). Ghi đè chỉ áp cho ngày
 * thuộc quy tắc; ghi đè của ngày không còn thuộc lịch bị bỏ qua (không bị xóa).
 */
export const occurrencesBetween = (
  schedule: ScheduleRule,
  overrides: readonly ScheduleOverride[],
  fromDate: string,
  toDate: string
): ChecklistOccurrence[] => {
  const timeByDate = new Map(overrides.map((o) => [o.localDate, o.time]));
  return baseOccurrenceDates(schedule, fromDate, toDate).map((date) => ({
    checklistId: schedule.templateId,
    date,
    time: timeByDate.get(date) ?? schedule.time,
    overridden: timeByDate.has(date),
  }));
};

/** `date` có thật sự là một lần xuất hiện của lịch (bỏ qua ghi đè) không? */
export const isOccurrenceDate = (schedule: ScheduleRule, date: string): boolean =>
  baseOccurrenceDates(schedule, date, date).length === 1;

/** Ngày YYYY-MM-DD có tồn tại trên lịch không (loại 2026-02-31). */
export const isValidCalendarDate = (value: string): boolean => {
  if (!isIsoDate(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

/** Số ngày trong [from, to] tính cả hai đầu (from <= to). */
export const rangeDays = (from: string, to: string): number => dayDiff(from, to) + 1;

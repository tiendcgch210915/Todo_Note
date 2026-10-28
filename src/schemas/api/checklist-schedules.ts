import { z } from "zod";
import { HHMM_RE } from "../../utils/time.js";
import {
  isValidCalendarDate,
  MAX_OCCURRENCE_RANGE_DAYS,
  rangeDays,
} from "../../services/checklist-schedule.js";
import type { ScheduleFields } from "../../repositories/checklist-schedules.js";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine(isValidCalendarDate, "Not a real calendar date");

const TimeHm = z.string().regex(HHMM_RE, "Expected HH:mm");

// Cùng quy ước với todo: T2 = 1 ... CN = 7, ví dụ '1,3,5'.
const WeekdaysStr = z
  .string()
  .regex(/^[1-7](,[1-7])*$/, "Expected comma-separated weekdays 1-7, e.g. '1,3,5'");

/**
 * Các trường của một lịch. Dùng chung cho PUT /checklists/templates/:id/schedule và cho payload
 * đồng bộ (`checklist_schedule`), nên nhận cả các khóa thừa như id/created_at.
 * Tên trường lặp giống hệt todo (`recurrence_*`).
 */
export const ScheduleFieldsSchema = z
  .object({
    start_date: IsoDate,
    time: TimeHm,
    recurrence_type: z.enum(["daily", "weekly", "custom"]).nullable().optional(),
    recurrence_interval: z.number().int().min(1).max(365).nullable().optional(),
    recurrence_days_of_week: WeekdaysStr.nullable().optional(),
    recurrence_end_date: IsoDate.nullable().optional(),
    enabled: z.boolean().optional(),
    // Tạm dừng [paused_from, paused_until], cả hai đầu tính; luôn đi theo cặp.
    paused_from: IsoDate.nullable().optional(),
    paused_until: IsoDate.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.recurrence_end_date && value.recurrence_end_date < value.start_date) {
      ctx.addIssue({
        code: "custom",
        path: ["recurrence_end_date"],
        message: "recurrence_end_date must not be before start_date",
      });
    }
    const hasFrom = value.paused_from != null;
    const hasUntil = value.paused_until != null;
    if (hasFrom !== hasUntil) {
      ctx.addIssue({
        code: "custom",
        path: [hasFrom ? "paused_until" : "paused_from"],
        message: "paused_from and paused_until must be set together",
      });
    } else if (value.paused_from && value.paused_until && value.paused_until < value.paused_from) {
      ctx.addIssue({
        code: "custom",
        path: ["paused_until"],
        message: "paused_until must not be before paused_from",
      });
    }
  });
export type ScheduleFieldsInput = z.infer<typeof ScheduleFieldsSchema>;

/**
 * Đưa đầu vào về dạng lưu trữ nhất quán:
 *  - không lặp (type null): bỏ interval/thứ, chỉ còn đúng một lần vào start_date. Ngày kết thúc
 *    được GIỮ (null = hết hạn ngay sau start_date, xem effectiveEndDate);
 *  - daily / custom: interval mặc định 1, bỏ thứ;
 *  - weekly: interval mặc định 1, thứ được sắp xếp và khử trùng (rỗng = thứ của start_date).
 *  - tạm dừng: không nhắc tới (cả hai khóa vắng) -> bỏ khóa, repository giữ khoảng đang có; có nhắc
 *    tới thì luôn là cặp (cùng ngày hoặc cùng null = bỏ tạm dừng).
 */
export const normalizeScheduleFields = (input: ScheduleFieldsInput): ScheduleFields => {
  const type = input.recurrence_type ?? null;
  const pauseGiven = input.paused_from !== undefined || input.paused_until !== undefined;
  const base = {
    start_date: input.start_date,
    time: input.time,
    enabled: input.enabled ?? true,
    ...(pauseGiven
      ? { paused_from: input.paused_from ?? null, paused_until: input.paused_until ?? null }
      : {}),
  };
  if (type === null) {
    return {
      ...base,
      recurrence_type: null,
      recurrence_interval: null,
      recurrence_days_of_week: null,
      recurrence_end_date: input.recurrence_end_date ?? null,
    };
  }
  const days =
    type === "weekly" && input.recurrence_days_of_week
      ? [...new Set(input.recurrence_days_of_week.split(",").map(Number))]
          .sort((a, b) => a - b)
          .join(",")
      : null;
  return {
    ...base,
    recurrence_type: type,
    recurrence_interval: input.recurrence_interval ?? 1,
    recurrence_days_of_week: days,
    recurrence_end_date: input.recurrence_end_date ?? null,
  };
};

export const PutChecklistScheduleSchema = ScheduleFieldsSchema.transform(
  normalizeScheduleFields
);

/** Payload đồng bộ của một ghi đè theo ngày (`checklist_schedule_override`). */
export const ScheduleOverrideFieldsSchema = z.object({
  template_id: z.string().min(1),
  local_date: IsoDate,
  time: TimeHm,
});

const MarkStatus = z.enum(["done", "open"]);

/** Payload đồng bộ của một dấu tay theo ngày (`checklist_occurrence_mark`). */
export const OccurrenceMarkFieldsSchema = z.object({
  template_id: z.string().min(1),
  local_date: IsoDate,
  status: MarkStatus,
});

/** Body của PUT /checklists/templates/:id/occurrences/:date/status. */
export const PutOccurrenceStatusSchema = z.object({ status: MarkStatus });

export const OccurrencesQuerySchema = z
  .object({ from: IsoDate, to: IsoDate })
  .superRefine((value, ctx) => {
    if (value.from > value.to) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "to must not be before from" });
    } else if (rangeDays(value.from, value.to) > MAX_OCCURRENCE_RANGE_DAYS) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: `range must not exceed ${MAX_OCCURRENCE_RANGE_DAYS} days`,
      });
    }
  });

export const OccurrenceDateParamSchema = z.object({ date: IsoDate });

/** Giờ ghi đè cho MỘT ngày. */
export const PutOccurrenceSchema = z.object({ time: TimeHm });

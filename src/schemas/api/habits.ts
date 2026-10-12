import { z } from "zod";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const CreateHabitSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  icon: z.string().max(50).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "color must be hex like #aabbcc")
    .optional(),
  frequency_type: z.enum(["daily", "weekly", "custom"]).optional(),
  target_per_period: z.number().int().min(1).max(50).optional(),
  active_weekdays: z
    .string()
    .regex(/^[1-7](,[1-7])*$/, "weekdays must be like 1,3,5")
    .optional(),
  start_date: IsoDate,
  end_date: IsoDate.nullable().optional(),
  // Checklist mà habit được tự tick khi một run của nó hoàn thành. null = bỏ liên kết.
  checklist_template_id: z.uuid().nullable().optional(),
});
export type CreateHabitInput = z.infer<typeof CreateHabitSchema>;

export const UpdateHabitSchema = CreateHabitSchema.partial().extend({
  is_archived: z.boolean().optional(),
});
export type UpdateHabitInput = z.infer<typeof UpdateHabitSchema>;

export const LogHabitSchema = z.object({
  log_date: IsoDate,
  completed: z.boolean().optional().default(true),
  note: z.string().max(1000).optional(),
});
export type LogHabitInput = z.infer<typeof LogHabitSchema>;

export const PatchLogSchema = z.object({
  completed: z.boolean().optional(),
  note: z.string().max(1000).nullable().optional(),
});
export type PatchLogInput = z.infer<typeof PatchLogSchema>;

export const ListHabitsQuerySchema = z.object({
  include_archived: z.coerce.boolean().optional().default(false),
});
export type ListHabitsQueryInput = z.infer<typeof ListHabitsQuerySchema>;

export const CalendarRangeQuerySchema = z
  .object({ from: IsoDate, to: IsoDate })
  .refine((d) => d.from <= d.to, "from must be <= to");
export type CalendarRangeQueryInput = z.infer<typeof CalendarRangeQuerySchema>;

import { z } from "zod";
import { TIMER } from "../../config/notification-policy.js";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const IsoDT = z.iso.datetime();
const TodoTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm");
const Minutes = z.number().int().min(0).max(10_000);
const RecurrenceInterval = z.number().int().min(1).max(365);

// ── Recurrence helpers ────────────────────────────────────────────────────────
// Weekday string: comma-separated 1–7 (Mon=1 … Sun=7), e.g. '1,3,5'
const ActiveWeekdaysStr = z
  .string()
  .regex(/^[1-7](,[1-7])*$/, "Expected comma-separated weekdays 1-7, e.g. '1,3,5'");

export const CreateTodoSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10_000).optional(),
  parent_id: z.uuid().optional(),
  scheduled_date: IsoDate.nullable().optional(),
  time: TodoTime.nullable().optional(),
  status: z.enum(["open", "in_progress", "done", "archived"]).optional(),
  is_frog: z.boolean().optional(),
  frog_date: IsoDate.nullable().optional(),
  is_important: z.boolean().nullable().optional(),
  is_urgent: z.boolean().nullable().optional(),
  estimated_minutes: Minutes.nullable().optional(),
  start_at: IsoDT.nullable().optional(),
  due_at: IsoDT.nullable().optional(),
  trigger_after_todo_id: z.uuid().nullable().optional(),
  habit_id: z.uuid().nullable().optional(),
  position: z.number().int().min(0).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  tag_ids: z.array(z.uuid()).max(20).optional(),
  // ── Recurrence (migration 0006) ─────────────────────────────────────────────
  recurrence_type: z.enum(["daily", "weekly", "custom"]).nullable().optional(),
  recurrence_interval: RecurrenceInterval.nullable().optional(),
  recurrence_days_of_week: ActiveWeekdaysStr.nullable().optional(),
  recurrence_end_date: IsoDate.nullable().optional(),
  recurrence_template_id: z.uuid().nullable().optional(),
});
export type CreateTodoInput = z.infer<typeof CreateTodoSchema>;

export const UpdateTodoSchema = CreateTodoSchema.partial().extend({
  actual_minutes: Minutes.nullable().optional(),
});
export type UpdateTodoInput = z.infer<typeof UpdateTodoSchema>;

export const ListTodosQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  scheduled_date: IsoDate.optional(),
  status: z.enum(["open", "in_progress", "done", "archived"]).optional(),
  is_frog: z.coerce.boolean().optional(),
  parent_id: z.string().optional(), // "null" → top-level only; uuid → children
  q: z.string().trim().min(1).max(200).optional(),
  tag: z.string().trim().min(1).max(64).optional(),
  tag_id: z.uuid().optional(),
  habit_id: z.uuid().optional(),
});
export type ListTodosQueryInput = z.infer<typeof ListTodosQuerySchema>;

export const CompleteTodoSchema = z.object({
  actual_minutes: Minutes.nullable().optional(),
});
export type CompleteTodoInput = z.infer<typeof CompleteTodoSchema>;

export const DeleteTodoQuerySchema = z
  .object({
    scope: z
      .enum(["this", "future", "this_and_future", "all"])
      .optional()
      .default("this"),
  })
  .transform(({ scope }) => ({
    scope: scope === "this_and_future" ? ("future" as const) : scope,
  }));
export type DeleteTodoQueryInput = z.infer<typeof DeleteTodoQuerySchema>;

export const ToggleFrogSchema = z.object({ date: IsoDate });
export type ToggleFrogInput = z.infer<typeof ToggleFrogSchema>;

export const ClassifyEisenhowerSchema = z.object({
  is_important: z.boolean().nullable(),
  is_urgent: z.boolean().nullable(),
});
export type ClassifyEisenhowerInput = z.infer<typeof ClassifyEisenhowerSchema>;

export const MoveToDaySchema = z.object({ date: IsoDate.nullable() });
export type MoveToDayInput = z.infer<typeof MoveToDaySchema>;

export const AttachTagSchema = z.union([
  z.object({ tagId: z.uuid() }),
  z.object({ tag_id: z.uuid() }),
  z.object({
    name: z.string().trim().min(1).max(64),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "color must be hex like #aabbcc")
      .optional(),
  }),
]);
export type AttachTagInput = z.infer<typeof AttachTagSchema>;

export const ReplaceTodoTagsSchema = z.object({
  tag_ids: z.array(z.uuid()).max(20).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
});
export type ReplaceTodoTagsInput = z.infer<typeof ReplaceTodoTagsSchema>;

// ── Đếm ngược (PUT /todos/:id/timer) ─────────────────────────────────────────
// Request camelCase như /devices; phản hồi snake_case như phần còn lại của API.
export const TodoTimerSchema = z
  .object({
    action: z.enum(["start", "pause", "resume", "stop", "finish"]),
    remainingSeconds: z.number().finite().min(0).max(TIMER.maxSeconds).optional(),
    /** Thời gian ước lượng ban đầu; bắt buộc khi start. */
    estimatedSeconds: z.number().finite().positive().max(TIMER.maxSeconds).optional(),
    /** Đăng ký FCM của máy đang đếm; bắt buộc khi start và resume. */
    registrationId: z.string().trim().min(1).max(4096).optional(),
    /** Thời điểm sự kiện xảy ra trên app (ISO 8601, UTC). */
    clientEventAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((value, ctx) => {
    const require = (field: "remainingSeconds" | "estimatedSeconds" | "registrationId") => {
      if (value[field] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required for action "${value.action}"`,
        });
      }
    };
    if (value.action === "start") {
      require("remainingSeconds");
      require("estimatedSeconds");
      require("registrationId");
    } else if (value.action === "resume") {
      require("remainingSeconds");
      require("registrationId");
    } else if (value.action === "pause") {
      require("remainingSeconds");
    }
  });
export type TodoTimerInput = z.infer<typeof TodoTimerSchema>;

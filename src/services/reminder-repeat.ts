/**
 * Nhắc LẠI ngay sau nhắc đúng giờ của một todo: `REMINDER_REPEAT.count` lần (2), cách nhau
 * `REMINDER_REPEAT.intervalMs` (2 phút), tính từ giờ hẹn: +2 phút và +4 phút. Chỉ để chắc người dùng
 * không bỏ lỡ lời nhắc, nên phải DỪNG ngay khi họ đã phản ứng:
 *
 *  - chạm vào thông báo, hoặc đang mở app lúc thông báo đến: app gọi `POST /todos/:id/reminder-ack`
 *    (`acknowledgeReminder`); server không có cách tự biết hai việc này;
 *  - bắt đầu todo: bấm giờ (`todo_timers` không `idle`) hoặc `status = in_progress`;
 *  - todo xong / bị xóa / đổi giờ hay ngày hẹn.
 *
 * Mỗi lần nhắc lại là MỘT dòng job (`todo_reminder_repeat`, duy nhất theo user/kind/ref_id/run_at):
 *  - được tạo SAU KHI nhắc đúng giờ đã gửi (`scheduleReminderRepeats`, gọi từ `afterSent` của tick), nên
 *    không cần planner/backfill: todo không có nhắc đúng giờ thì không có nhắc lại;
 *  - hook (`reconcileReminderRepeats`): todo đổi -> hủy lần nhắc lại không còn khớp giờ hẹn;
 *  - kiểm tra lại ngay trước khi gửi (notification-tick, `repeatIndexOf` + trạng thái + bấm giờ).
 *
 * `acknowledgeReminder` còn GHI SẴN các mốc tương lai ở trạng thái `cancelled`: app có thể báo "đã thấy"
 * trước khi server kịp tạo các dòng nhắc lại (tin đến máy nhanh hơn một câu ghi DB), và dòng đã có thì
 * `scheduleReminderRepeats` không tạo lại.
 *
 * Module này KHÔNG import env/firebase để các service nghiệp vụ dùng được trong test không có cấu hình.
 */
import { REMINDER_REPEAT } from "../config/notification-policy.js";
import * as jobsRepo from "../repositories/notification-jobs.js";
import * as settingsRepo from "../repositories/notification-settings.js";
import * as todosRepo from "../repositories/todos.js";
import { localDateTimeToUtc } from "../utils/time.js";
import { resolveSettings } from "./notification-schedule.js";
import { pushLogger } from "./push-logger.js";

const KIND = "todo_reminder_repeat" as const;

export class ReminderRepeatError extends Error {
  constructor(public code: "not_found") {
    super(code);
  }
}

// ── Hàm thuần ────────────────────────────────────────────────────────────────

/** Các mốc nhắc lại của giờ hẹn `scheduledAt`: +interval, +2·interval, ... (`count` mốc). */
export const repeatSlots = (scheduledAt: Date): Date[] =>
  Array.from(
    { length: REMINDER_REPEAT.count },
    (_, i) => new Date(scheduledAt.getTime() + (i + 1) * REMINDER_REPEAT.intervalMs)
  );

/** `runAt` là lần nhắc lại thứ mấy (1..count) của giờ hẹn `scheduledAt`, hoặc null nếu không phải mốc nào. */
export const repeatIndexOf = (scheduledAt: Date, runAt: Date): number | null => {
  const diff = runAt.getTime() - scheduledAt.getTime();
  if (diff <= 0 || diff % REMINDER_REPEAT.intervalMs !== 0) return null;
  const index = diff / REMINDER_REPEAT.intervalMs;
  return index <= REMINDER_REPEAT.count ? index : null;
};

type RepeatTodoFields = {
  id: string;
  status: string;
  parent_id: string | null;
  scheduled_date: string | null;
};

/** Todo còn thuộc diện nhắc lại: chưa bắt đầu (`open`), là todo cấp trên cùng và có ngày hẹn. */
const wantsRepeats = (todo: RepeatTodoFields): todo is RepeatTodoFields & { scheduled_date: string } =>
  todo.status === "open" && todo.parent_id === null && todo.scheduled_date !== null;

const toIso = (slots: readonly Date[]): string[] => slots.map((slot) => slot.toISOString());

// ── Tạo / giữ / hủy ──────────────────────────────────────────────────────────

/**
 * Gọi sau khi nhắc đúng giờ ĐÃ GỬI: tạo các lần nhắc lại còn ở tương lai (nhắc đúng giờ gửi muộn thì lần
 * nhắc lại đã qua giờ bị bỏ qua). Idempotent, và không bao giờ throw: lỗi ở đây không được làm hỏng
 * việc ghi kết quả của nhắc đúng giờ.
 */
export const scheduleReminderRepeats = async (
  userId: string,
  todo: RepeatTodoFields,
  scheduledAt: Date,
  now: Date = new Date()
): Promise<void> => {
  try {
    if (!wantsRepeats(todo)) return;
    const upcoming = repeatSlots(scheduledAt).filter((slot) => slot.getTime() > now.getTime());
    await jobsRepo.insertSlotJobsIfAbsent(
      { userId, kind: KIND, refId: todo.id, localDate: todo.scheduled_date },
      toIso(upcoming),
      "pending"
    );
  } catch (error) {
    pushLogger.error(
      { op: "reminder_repeat_schedule", errorName: error instanceof Error ? error.name : "unknown" },
      "reminder repeat scheduling failed"
    );
  }
};

/**
 * Hook sau mỗi thay đổi của todo (đã đọc từ DB, còn tồn tại): giữ các lần nhắc lại đang chờ chỉ khi
 * chúng vẫn khớp giờ hẹn hiện tại và todo chưa bắt đầu. Sửa tiêu đề không đổi gì; đổi giờ/ngày hẹn hoặc
 * chuyển `in_progress` thì hủy hết phần còn chờ.
 */
export const reconcileReminderRepeats = async (
  userId: string,
  todo: RepeatTodoFields,
  scheduledAt: Date | null
): Promise<void> => {
  const keep = scheduledAt !== null && wantsRepeats(todo) ? toIso(repeatSlots(scheduledAt)) : [];
  await jobsRepo.cancelSlotJobsExcept(userId, KIND, todo.id, keep);
};

/** Hủy mọi lần nhắc lại đang chờ của các todo (xong, xóa, bắt đầu bấm giờ). */
export const cancelReminderRepeats = (todoIds: readonly string[]): Promise<number> =>
  jobsRepo.cancelEventJobs(KIND, todoIds);

// ── App báo "đã thấy" ────────────────────────────────────────────────────────

export type ReminderAckResult = {
  todo_id: string;
  /** Số lần nhắc lại đang chờ vừa bị hủy. */
  cancelled: number;
};

/**
 * Người dùng đã chạm thông báo của todo, hoặc đang mở app lúc nó đến: hủy các lần nhắc lại còn chờ và
 * ghi sẵn các mốc chưa tạo ở trạng thái `cancelled`. Idempotent (gọi lại: `cancelled = 0`), áp dụng cho
 * mọi thiết bị của người dùng. Todo không tồn tại hoặc của người khác: `not_found`.
 */
export const acknowledgeReminder = async (
  userId: string,
  todoId: string,
  now: Date = new Date()
): Promise<ReminderAckResult> => {
  const todo = await todosRepo.getTodoByIdScoped(todoId, userId);
  if (!todo) throw new ReminderRepeatError("not_found");

  const cancelled = await jobsRepo.cancelSlotJobsExcept(userId, KIND, todo.id, []);

  if (todo.parent_id === null && todo.scheduled_date && todo.time) {
    const ctx = await settingsRepo.getUserContext(userId);
    const { timezone } = resolveSettings(
      ctx ?? { timezone: null, morning_time: null, evening_time: null }
    );
    const upcoming = repeatSlots(
      localDateTimeToUtc(todo.scheduled_date, todo.time, timezone)
    ).filter((slot) => slot.getTime() > now.getTime());
    await jobsRepo.insertSlotJobsIfAbsent(
      { userId, kind: KIND, refId: todo.id, localDate: todo.scheduled_date },
      toIso(upcoming),
      "cancelled"
    );
  }
  return { todo_id: todo.id, cancelled };
};

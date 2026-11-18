/**
 * Thông báo của một todo đã nằm trên máy (thẻ) và việc gỡ nó khi todo đổi GIỜ hoặc NGÀY hẹn
 * (`dismissStaleTodoCard`), hoặc khi người dùng bắt đầu/tiếp tục đếm ngược nó (`dismissTodoCardOnStart`).
 *
 * Server không xóa được thông báo đã hiện trên máy, nên khi đó ta gửi một tin
 * CHỈ CÓ data (`type: "dismiss"`, kèm `tag`) để app hủy thông báo theo thẻ (xem `dismissNotification`).
 * Các thông báo SAU đó (nhắc lặp theo lịch mới) vẫn hiện bình thường: nhắc lặp chỉ là job tới hạn nên
 * không bị ảnh hưởng ở đây, và mốc tính từ giờ hẹn mới (xem `reconcileTodoOverdue`).
 *
 * Module này KHÔNG import firebase/env ở mức trên cùng (như overdue-nudges / notification-triggers) để
 * các service nghiệp vụ dùng được trong test không có cấu hình; phần gửi được nạp khi thật sự cần.
 */
import {
  DISMISS,
  LATENESS_MS,
  notificationTag,
  type NotificationJobKind,
} from "../config/notification-policy.js";
import * as jobsRepo from "../repositories/notification-jobs.js";
import * as settingsRepo from "../repositories/notification-settings.js";
import * as todosRepo from "../repositories/todos.js";
import { localDateTimeToUtc } from "../utils/time.js";
import { resolveSettings } from "./notification-schedule.js";
import { isOverdueSlot, todoOverdueIntervalMs } from "./overdue-nudges.js";
import { pushLogger } from "./push-logger.js";

type TodoSchedule = {
  scheduled_date: string | null;
  time: string | null;
  parent_id: string | null;
};

/**
 * Khóa lịch nhắc của todo: "<ngày hẹn>T<giờ hẹn>" theo giờ địa phương, hoặc null nếu todo không nhắc
 * theo giờ (thiếu ngày/giờ, hoặc là todo con). Ghi vào job lúc gửi (`markSent`) và so lại khi todo đổi.
 */
export const todoCardKey = (todo: TodoSchedule): string | null =>
  todo.scheduled_date && todo.time && todo.parent_id === null
    ? `${todo.scheduled_date}T${todo.time}`
    : null;

/**
 * Thẻ thông báo của một todo. Todo thuộc chuỗi lặp dùng id GỐC chuỗi (xem `notificationTag`), nên mọi
 * chỗ gửi và gỡ thông báo của todo phải đi qua hàm này để cùng một thẻ.
 */
export const todoTag = (
  kind: NotificationJobKind,
  todo: { id: string; recurrence_template_id: string | null }
): string => notificationTag(kind, todo.recurrence_template_id ?? todo.id);

/**
 * Job đang chờ này có THẬT SỰ sắp hiện một thông báo thay thẻ của todo không? Chỉ khi nó còn khớp lịch HIỆN
 * TẠI của todo, theo đúng các điều kiện bước kiểm tra trước khi gửi (`prepare` trong notification-tick) áp:
 *  - nhắc giờ: cùng ngày hẹn và `run_at` không sớm hơn giờ hẹn (muộn hơn là được: có thể đang bị giữ ở hàng đợi);
 *  - nhắc lặp: cùng ngày hẹn và `run_at` đúng là một mốc nhắc của giờ hẹn hiện tại, theo nhịp hiện tại.
 * Job của lịch cũ (job lẽ ra đã bị hủy nhưng hook lỗi hay chưa kịp chạy) rồi cũng bị `prepare` hủy mà không gửi
 * gì, nên không được tính: nếu tính thì tin gỡ bị bỏ và thẻ cũ nằm lại mãi.
 */
const replacesCard = (
  job: jobsRepo.CardJobDue,
  todo: todosRepo.TodoRow,
  timezone: string
): boolean => {
  if (!todo.scheduled_date || !todo.time) return false;
  if (job.local_date !== null && job.local_date !== todo.scheduled_date) return false;
  const appointment = localDateTimeToUtc(todo.scheduled_date, todo.time, timezone);
  const runAt = new Date(job.run_at);
  if (job.kind === "todo_reminder") return runAt.getTime() >= appointment.getTime();

  const intervalMs = todoOverdueIntervalMs(todo);
  return (
    job.local_date !== null &&
    intervalMs !== null &&
    isOverdueSlot(appointment, runAt, job.local_date, timezone, intervalMs)
  );
};

export type DismissOutcome =
  /** Không có thông báo cũ nào cần gỡ. */
  | "none"
  /** Có thông báo cũ, nhưng thông báo kế tiếp đến ngay nên nó tự thay thẻ cũ: không gửi tin gỡ. */
  | "replaced"
  /** Đã (đang) gửi tin gỡ trong nền. */
  | "dismissed";

const inFlight = new Set<Promise<unknown>>();

/** Chờ các tin gỡ đang gửi trong nền xong (test, và khi tắt máy chủ). */
export const flushDismissals = async (): Promise<void> => {
  await Promise.allSettled([...inFlight]);
};

const sendInBackground = (task: () => Promise<unknown>): void => {
  const promise: Promise<unknown> = task()
    .catch((error: unknown) => {
      pushLogger.error(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "dismiss push failed"
      );
    })
    .finally(() => inFlight.delete(promise));
  inFlight.add(promise);
};

/**
 * Gọi sau MỌI thay đổi của một todo (sau khi job đã được tính lại): nếu một thông báo đã gửi theo lịch
 * CŨ có thể còn nằm trên máy thì gỡ nó.
 *
 *  - "Lịch cũ" = khóa lịch đã ghi lúc gửi khác khóa lịch hiện tại, tức người dùng đã đổi ngày hoặc giờ
 *    hẹn (kể cả bỏ giờ hẹn). Sửa tiêu đề hay đổi nhóm quan trọng/khẩn cấp không đổi khóa nên không gỡ gì.
 *  - Chỉ xét todo còn làm dở: hoàn thành / cất / xóa không thuộc phạm vi này.
 *  - Mỗi thông báo cũ chỉ gỡ một lần (khóa được xóa ngay khi giành quyền, nên gọi lại là "none").
 *  - Thông báo kế tiếp của todo đến hạn trong `DISMISS.replaceWithinMs` thì không gửi tin gỡ: thông báo
 *    đó cùng thẻ nên tự thay thẻ cũ, và tin gỡ đến muộn có thể xóa nhầm nó. Chỉ job còn khớp lịch HIỆN TẠI mới
 *    tính là "thông báo kế tiếp" (`replacesCard`): job của lịch cũ sẽ bị hủy khi đến hạn, không thay thẻ nào.
 *  - Nhắc lại +5 phút (`todo_reminder_repeat`) không cần xét ở đây: nó chỉ được tạo SAU KHI nhắc đúng giờ của lịch
 *    đó đã gửi, và mọi lần đổi lịch đã hủy nó (`reconcileReminderRepeats`), nên không bao giờ đang chờ lúc này.
 *
 * Việc gửi chạy trong nền (không làm chậm request); dùng `flushDismissals()` để chờ nó.
 */
export const dismissStaleTodoCard = async (
  userId: string,
  todoId: string,
  now: Date = new Date()
): Promise<DismissOutcome> => {
  const todo = await todosRepo.getTodoByIdScoped(todoId, userId);
  if (!todo || (todo.status !== "open" && todo.status !== "in_progress")) return "none";

  const cleared = await jobsRepo.clearStaleCardKeys(userId, todo.id, todoCardKey(todo) ?? "");
  if (cleared === 0) return "none";

  const nowMs = now.getTime();
  const lateness = Math.max(LATENESS_MS.todo_reminder, LATENESS_MS.todo_overdue);
  const upcoming = await jobsRepo.listCardJobsDueBetween(
    userId,
    todo.id,
    new Date(nowMs - lateness).toISOString(),
    new Date(nowMs + DISMISS.replaceWithinMs).toISOString()
  );
  if (upcoming.length > 0) {
    const ctx = await settingsRepo.getUserContext(userId);
    const { timezone } = resolveSettings(
      ctx ?? { timezone: null, morning_time: null, evening_time: null }
    );
    if (upcoming.some((job) => replacesCard(job, todo, timezone))) return "replaced";
  }

  dismissInBackground(userId, todo, now);
  return "dismissed";
};

/**
 * Gỡ thẻ của todo khỏi MỌI máy của người dùng, trong nền. Thẻ tính bằng `todoTag` (chuỗi lặp dùng id GỐC chuỗi),
 * không bao giờ ghép tay. Không bao giờ throw: lỗi gửi chỉ được log (xem `sendInBackground`).
 */
const dismissInBackground = (
  userId: string,
  todo: { id: string; recurrence_template_id: string | null },
  now: Date
): void => {
  const tag = todoTag("todo_reminder", todo);
  sendInBackground(async () => {
    const { dismissNotification } = await import("./notifications.js");
    await dismissNotification(userId, { tag, id: todo.id }, now);
  });
};

/**
 * Người dùng BẮT ĐẦU hoặc TIẾP TỤC đếm ngược một todo: thông báo nhắc đã nằm trên máy (nhắc đúng giờ, nhắc lại,
 * nhắc lặp) hết ý nghĩa vì họ đang làm rồi, nên gỡ nó. Server chỉ dừng được các nhắc SẮP TỚI, còn thẻ đã hiện thì
 * phải nhờ app hủy (cùng tin chỉ có data với `dismissStaleTodoCard`, không có định dạng mới). App tự hủy thẻ trên
 * máy đang bấm; tin này lo các máy KHÁC và thẻ hiện giữa lúc bấm và lúc server nhận được sự kiện. Gửi cả máy đang
 * bấm cũng vô hại.
 *
 *  - Todo con không có thẻ riêng: "none".
 *  - Đồng hồ còn lại <= `DISMISS.replaceWithinMs` (và > 0, tức là có job `todo_timer_end`): thông báo hết giờ cùng
 *    thẻ nên tự thay thẻ cũ, và tin gỡ đến muộn có thể xóa nhầm nó: "replaced". Còn lại <= 0 thì không có job hết
 *    giờ nào thay thẻ cả (đồng hồ ghi `finished` ngay), nên vẫn gỡ.
 *  - Gửi trong nền, KHÔNG chờ: không làm chậm `PUT /todos/:id/timer`, không bao giờ throw; dùng `flushDismissals()`
 *    để chờ trong test. Chạy thử (`NOTIFY_DRY_RUN`) chỉ log (xem `dismissNotification`).
 *
 * Chỉ gọi khi sự kiện ĐÃ được áp dụng (không phải sự kiện cũ bị bỏ qua, không phải lỗi thiết bị/todo đã xong).
 * `remainingSeconds` là thời gian còn lại SAU khi đã trừ độ trễ của sự kiện, đúng giá trị dùng để hẹn job hết giờ.
 */
export const dismissTodoCardOnStart = (
  userId: string,
  todo: { id: string; parent_id: string | null; recurrence_template_id: string | null },
  remainingSeconds: number,
  now: Date = new Date()
): DismissOutcome => {
  if (todo.parent_id !== null) return "none";
  if (remainingSeconds > 0 && remainingSeconds * 1000 <= DISMISS.replaceWithinMs) return "replaced";

  dismissInBackground(userId, todo, now);
  return "dismissed";
};

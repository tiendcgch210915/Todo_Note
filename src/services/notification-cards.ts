/**
 * Thông báo của một todo đã nằm trên máy (thẻ) và việc gỡ nó khi todo đổi GIỜ hoặc NGÀY hẹn.
 *
 * Server không xóa được thông báo đã hiện trên máy, nên khi lịch của todo đổi ta gửi một tin
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
import * as todosRepo from "../repositories/todos.js";
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
 *    đó cùng thẻ nên tự thay thẻ cũ, và tin gỡ đến muộn có thể xóa nhầm nó.
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
  if (
    await jobsRepo.hasCardJobDueBetween(
      userId,
      todo.id,
      new Date(nowMs - lateness).toISOString(),
      new Date(nowMs + DISMISS.replaceWithinMs).toISOString()
    )
  ) {
    return "replaced";
  }

  const tag = todoTag("todo_reminder", todo);
  sendInBackground(async () => {
    const { dismissNotification } = await import("./notifications.js");
    await dismissNotification(userId, { tag, id: todo.id }, now);
  });
  return "dismissed";
};

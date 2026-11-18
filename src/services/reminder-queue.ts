/**
 * HÀNG ĐỢI NHẮC GIỜ của todo (kind `todo_reminder`), theo từng người dùng.
 *
 * Trước đây mỗi nhắc giờ là một job độc lập đến đúng giờ hẹn là gửi. Giờ nhắc đi qua hàng đợi này, nên
 * `run_at` của job là giờ GỬI THẬT, có thể muộn hơn giờ hẹn của todo (giờ hẹn luôn tính lại từ chính todo:
 * ngày + giờ + múi giờ). Hai quy tắc:
 *
 *  1. ĐANG ĐẾM NGƯỢC thì không nhắc todo khác. Khi người dùng bấm "bắt đầu" một todo có đếm ngược
 *     (`todo_timers.status = running`, hết giờ ở `ends_at`), mọi nhắc giờ KHÁC có giờ hẹn rơi trước hoặc đúng lúc
 *     đếm ngược kết thúc bị giữ lại và chỉ gửi sau `ends_at + 2 phút`. Ví dụ đếm ngược 14:03 + 60 phút = 15:03:
 *     todo hẹn 14:30 được nhắc lúc 15:05, todo hẹn 15:30 không bị ảnh hưởng. Đếm ngược dừng sớm (dừng, hoàn
 *     thành todo đó, xóa) thì nhắc đang giữ được thả sau 2 phút kể từ lúc dừng. Đồng hồ tạm dừng hay đã hết giờ
 *     không giữ gì cả. Todo đang đếm ngược không bị chính đồng hồ của nó GIỮ nhắc (hàng đợi không dời nó); còn nếu đồng
 *     hồ ấy vẫn chưa `idle` khi nhắc đến hạn thì nhắc bị HỦY lúc gửi (`prepare` trong notification-tick).
 *  2. KHÔNG HAI NHẮC CHỒNG LÊN NHAU. Nhắc rơi vào cùng mốc với (hoặc sớm hơn) một nhắc đã xếp trước nó thì đi
 *     sau nhắc đó 2 phút. Thứ tự: giờ hẹn sớm hơn trước; cùng giờ hẹn thì theo nhóm (quan trọng & khẩn cấp ->
 *     khẩn cấp, không quan trọng -> quan trọng, không khẩn cấp -> còn lại; chưa phân loại tính là "không");
 *     cùng nhóm thì todo tạo trước đi trước. Ví dụ đếm ngược 14:06 + 90 phút = 15:36 và hai todo hẹn 14:30,
 *     15:30: nhắc lúc 15:38 rồi 15:40.
 *
 * Chỉ nhắc ĐANG CHỜ mới được dời (`moveTodoReminder`); việc tạo/hủy job vẫn là của `notification-triggers`
 * (`rearmTodoJobs`) và bước vá của planner. Hàng đợi chạy lại sau mọi thay đổi có thể đổi kết quả: todo đổi
 * (`onTodoChanged`), todo bị xóa, mọi sự kiện đồng hồ (`applyTimerEvent`), và mỗi phút ở bước dọn dẹp (lưới an
 * toàn cho dữ liệu cũ và hook lỡ tay). Kết quả chỉ phụ thuộc trạng thái hiện tại nên chạy lại không đổi gì
 * (không trôi giờ).
 *
 * Cùng quy tắc 1, các nhắc phụ của todo khác (`todo_reminder_repeat`, `todo_overdue`) bị BỎ (không dời) nếu đến
 * hạn lúc người dùng đang đếm ngược: xem `isBusyWithAnotherTodo`, dùng ở notification-tick.
 *
 * Module này KHÔNG import env/firebase để các service nghiệp vụ dùng được trong test không có cấu hình.
 */
import {
  LATENESS_MS,
  REMINDER_QUEUE,
} from "../config/notification-policy.js";
import * as jobsRepo from "../repositories/notification-jobs.js";
import * as settingsRepo from "../repositories/notification-settings.js";
import * as timersRepo from "../repositories/todo-timers.js";
import { localDateTimeToUtc } from "../utils/time.js";
import { resolveSettings } from "./notification-schedule.js";
import { pushLogger } from "./push-logger.js";

// ── Hàm thuần ────────────────────────────────────────────────────────────────

type Flag = number | boolean | null | undefined;

const isTrue = (value: Flag): boolean => value === 1 || value === true;

/**
 * Thứ tự ưu tiên khi cùng giờ hẹn (nhỏ = nhắc trước):
 * 0 quan trọng & khẩn cấp, 1 khẩn cấp & không quan trọng, 2 quan trọng & không khẩn cấp, 3 còn lại.
 * Cờ chưa đặt (null) tính là "không".
 */
export const reminderPriority = (isImportant: Flag, isUrgent: Flag): 0 | 1 | 2 | 3 => {
  if (isTrue(isImportant)) return isTrue(isUrgent) ? 0 : 2;
  return isTrue(isUrgent) ? 1 : 3;
};

export type QueueItem = {
  todoId: string;
  /** Giờ hẹn của todo (UTC, mili-giây). */
  baseMs: number;
  /** `reminderPriority`. */
  rank: number;
  /** Lúc tạo todo (ISO): hòa nhau thì todo tạo trước đi trước. */
  createdAt: string;
  /** `run_at` hiện tại của job đang chờ (UTC, mili-giây). */
  runAtMs: number;
};

/** Một đồng hồ đang chạy của `todoId`, hết giờ ở `endsAtMs`. */
export type BusyTimer = { todoId: string; endsAtMs: number };

export type QueueAction =
  | { todoId: string; action: "keep" }
  | { todoId: string; action: "move"; runAtMs: number }
  | { todoId: string; action: "cancel" };

const byQueueOrder = (a: QueueItem, b: QueueItem): number => {
  if (a.baseMs !== b.baseMs) return a.baseMs - b.baseMs;
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.todoId < b.todoId ? -1 : a.todoId > b.todoId ? 1 : 0;
};

/**
 * Tính giờ gửi cho từng nhắc đang chờ. Hàm thuần; trả đúng một hành động cho mỗi phần tử, theo thứ tự hàng đợi.
 *
 * Với mỗi nhắc, theo thứ tự:
 *  - `earliest`: giờ hẹn, hoặc `kết thúc đếm ngược + gap` nếu giờ hẹn rơi trước/đúng lúc đếm ngược (của todo
 *    khác) kết thúc;
 *  - `slot`: `earliest`, trừ khi nó trùng hoặc sớm hơn mốc cuối đã xếp (`cursor`) thì là `cursor + gap`;
 *  - `slot` còn ở tương lai: đặt `run_at = slot` (không đổi thì `keep`);
 *  - `slot` đã qua nghĩa là nhắc không còn bị giữ: nếu job đang hẹn xa hơn `now + gap` thì THẢ sớm về `now + gap`
 *    (đếm ngược vừa dừng sớm), ngược lại giữ nguyên (đã đến hạn, hoặc sắp tới nơi). Riêng todo vừa bị sửa
 *    (`changedTodoId`) mà giờ hẹn đã qua và không bị giữ thì HỦY: giờ hẹn vừa bị đổi về quá khứ, hoặc là nhắc
 *    đến hạn chưa gửi của một todo vừa sửa (hành vi cũ).
 *
 * `seedMs` là mốc của nhắc vừa đi (đã gửi/đang gửi): nhắc đang chờ xếp sau nó chứ không chồng lên.
 */
export const planReminderQueue = (input: {
  items: readonly QueueItem[];
  timers: readonly BusyTimer[];
  nowMs: number;
  seedMs?: number | null;
  changedTodoId?: string | null;
}): QueueAction[] => {
  const { nowMs, timers } = input;
  const gap = REMINDER_QUEUE.gapMs;
  let cursor = input.seedMs ?? Number.NEGATIVE_INFINITY;
  const actions: QueueAction[] = [];

  for (const item of [...input.items].sort(byQueueOrder)) {
    // Đếm ngược của CHÍNH todo này không giữ nhắc của nó.
    let busyEnd = Number.NEGATIVE_INFINITY;
    for (const timer of timers) {
      if (timer.todoId !== item.todoId && timer.endsAtMs > nowMs) {
        busyEnd = Math.max(busyEnd, timer.endsAtMs);
      }
    }
    const earliest = item.baseMs <= busyEnd ? busyEnd + gap : item.baseMs;
    const slot = earliest <= cursor ? cursor + gap : earliest;

    let final: number;
    if (slot > nowMs) {
      final = slot;
      actions.push(
        slot === item.runAtMs
          ? { todoId: item.todoId, action: "keep" }
          : { todoId: item.todoId, action: "move", runAtMs: slot }
      );
    } else if (item.todoId === input.changedTodoId) {
      actions.push({ todoId: item.todoId, action: "cancel" });
      continue;
    } else if (item.runAtMs > nowMs + gap) {
      final = nowMs + gap;
      actions.push({ todoId: item.todoId, action: "move", runAtMs: final });
    } else {
      final = item.runAtMs;
      actions.push({ todoId: item.todoId, action: "keep" });
    }
    cursor = Math.max(cursor, final);
  }
  return actions;
};

// ── Xếp hàng cho một người dùng ──────────────────────────────────────────────

export type RequeueResult = { moved: number; cancelled: number };

const NOTHING: RequeueResult = { moved: 0, cancelled: 0 };

/**
 * Đọc nhắc đang chờ + đồng hồ đang chạy của một người dùng, tính lại giờ gửi và ghi phần thay đổi.
 * `changedTodoId` = todo vừa được sửa (xem `planReminderQueue`). Có thể throw: dùng `requeueTodoReminders`
 * ở chỗ không được phép làm hỏng việc ghi của người dùng.
 */
export const reconcileReminderQueue = async (
  userId: string,
  now: Date = new Date(),
  changedTodoId: string | null = null
): Promise<RequeueResult> => {
  const nowMs = now.getTime();
  const loaded = await jobsRepo.listPendingTodoReminders(
    userId,
    new Date(nowMs - LATENESS_MS.todo_reminder).toISOString(),
    new Date(nowMs + REMINDER_QUEUE.horizonMs).toISOString()
  );
  if (loaded.length === 0) return NOTHING;

  const ctx = await settingsRepo.getUserContext(userId);
  const { timezone } = resolveSettings(
    ctx ?? { timezone: null, morning_time: null, evening_time: null }
  );
  const baseOf = (row: jobsRepo.QueuedReminder): number =>
    localDateTimeToUtc(row.scheduled_date, row.time, timezone).getTime();

  // Chỉ xếp job còn khớp todo: cùng ngày hẹn, và `run_at` không sớm hơn giờ hẹn hiện tại. Job lệch (giờ hẹn bị
  // dời về sau mà hook không chạy) để yên: bước kiểm tra trước khi gửi hủy nó, như trước đây. Dời nó ở đây sẽ
  // để lại `local_date` sai trong nội dung thông báo.
  const pending = loaded.filter(
    (row) =>
      (row.job_local_date === null || row.job_local_date === row.scheduled_date) &&
      Date.parse(row.run_at) >= baseOf(row)
  );
  if (pending.length === 0) return NOTHING;

  const [running, seed] = await Promise.all([
    timersRepo.listRunningTimers(userId, now.toISOString()),
    jobsRepo.latestTodoReminderRunAt(
      userId,
      new Date(nowMs - REMINDER_QUEUE.gapMs).toISOString()
    ),
  ]);

  const byTodo = new Map(pending.map((row) => [row.todo_id, row]));
  const actions = planReminderQueue({
    items: pending.map((row) => ({
      todoId: row.todo_id,
      baseMs: baseOf(row),
      rank: reminderPriority(row.is_important, row.is_urgent),
      createdAt: row.todo_created_at,
      runAtMs: Date.parse(row.run_at),
    })),
    timers: running.map((timer) => ({
      todoId: timer.todo_id,
      endsAtMs: Date.parse(timer.ends_at),
    })),
    nowMs,
    seedMs: seed === null ? null : Date.parse(seed),
    changedTodoId,
  });

  const result = { moved: 0, cancelled: 0 };
  for (const action of actions) {
    const row = byTodo.get(action.todoId);
    if (!row || action.action === "keep") continue;
    if (action.action === "cancel") {
      result.cancelled += await jobsRepo.cancelEventJobs("todo_reminder", [row.todo_id]);
      continue;
    }
    const moved = await jobsRepo.moveTodoReminder(
      row.job_id,
      row.run_at,
      new Date(action.runAtMs).toISOString()
    );
    if (moved) result.moved++;
  }
  return result;
};

/** `reconcileReminderQueue` che lỗi: log rồi nuốt (lỗi ở đây không được làm hỏng thao tác của người dùng). */
export const requeueTodoReminders = async (
  userId: string,
  now: Date = new Date(),
  changedTodoId: string | null = null
): Promise<RequeueResult> => {
  try {
    const result = await reconcileReminderQueue(userId, now, changedTodoId);
    if (result.moved > 0 || result.cancelled > 0) {
      pushLogger.info({ op: "reminder_queue", ...result }, "todo reminders re-queued");
    }
    return result;
  } catch (error) {
    pushLogger.error(
      {
        op: "reminder_queue",
        errorName: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      "reminder queue failed"
    );
    return NOTHING;
  }
};

/**
 * Lưới an toàn chạy mỗi phút (bước dọn dẹp của tick): xếp lại hàng đợi cho mọi người dùng có nhắc giờ sắp tới.
 * Bắt được dữ liệu có trước tính năng và hook bị lỡ. Mỗi người dùng độc lập: một người lỗi không chặn người khác.
 * Trả số nhắc đã dời.
 */
export const reconcileAllReminderQueues = async (now: Date = new Date()): Promise<number> => {
  const nowMs = now.getTime();
  const users = await jobsRepo.listUsersWithPendingTodoReminders(
    new Date(nowMs - LATENESS_MS.todo_reminder).toISOString(),
    new Date(nowMs + REMINDER_QUEUE.horizonMs).toISOString()
  );
  let moved = 0;
  for (const userId of users) {
    moved += (await requeueTodoReminders(userId, now)).moved;
  }
  return moved;
};

// ── Đang bận với todo khác? ──────────────────────────────────────────────────

/**
 * Người dùng đang đếm ngược MỘT TODO KHÁC `todoId` (đồng hồ đang chạy và chưa hết giờ)? Thông báo phụ của
 * `todoId` (nhắc lại +5 phút, nhắc lặp quá hạn) đến hạn lúc này thì bị bỏ để không làm phiền lúc họ đang làm.
 */
export const isBusyWithAnotherTodo = async (
  userId: string,
  todoId: string,
  now: Date = new Date()
): Promise<boolean> => {
  const running = await timersRepo.listRunningTimers(userId, now.toISOString());
  return running.some((timer) => timer.todo_id !== todoId);
};

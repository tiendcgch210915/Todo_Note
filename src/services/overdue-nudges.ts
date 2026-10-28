/**
 * Nhắc LẶP khi người dùng bỏ lỡ giờ hẹn của một todo, cho tới hết ngày địa phương đó, miễn là todo
 * vẫn chưa xong. Nhịp nhắc phụ thuộc todo thuộc nhóm nào (xem `todoOverdueIntervalMs`):
 *  - quan trọng & khẩn cấp: giờ hẹn + 1h, +2h, ...;
 *  - khẩn cấp (không quan trọng) hoặc chưa phân loại: giờ hẹn + 2h, +4h, ...;
 *  - quan trọng (không khẩn cấp): KHÔNG nhắc theo từng todo, đã có tổng kết 17:00 và 07:00 sáng
 *    hôm sau (digest_overdue_*);
 *  - không quan trọng, không khẩn cấp: chỉ nhắc đúng giờ hẹn.
 *
 * Module này KHÔNG import env/firebase để các service nghiệp vụ dùng được trong test không có cấu hình.
 *
 * Mỗi mốc là MỘT dòng job (`todo_overdue`, unique theo user/kind/ref_id/run_at):
 *  - hook (`reconcileTodoOverdue`): todo đổi -> hủy mốc thừa, upsert mốc còn hợp lệ;
 *  - planner (`backfillTodoOverdue`): vá todo chưa có dòng nào (todo có trước tính năng);
 *  - kiểm tra lại ngay trước khi gửi (`todoWantsOverdue` + `isOverdueSlot` trong notification-tick).
 *
 * Các hàm thuần ở đầu file (`overdueSlots`, `isOverdueSlot`) chỉ còn todo dùng: checklist không nhắc lặp.
 */
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  DISPATCH,
  LATENESS_MS,
  OVERDUE,
  type OverdueKind,
} from "../config/notification-policy.js";
import * as jobsRepo from "../repositories/notification-jobs.js";
import * as settingsRepo from "../repositories/notification-settings.js";
import * as sourcesRepo from "../repositories/notification-sources.js";
import * as todosRepo from "../repositories/todos.js";
import { addDays, isValidTimeZone, localDateOf, localDateTimeToUtc } from "../utils/time.js";
import { resolveSettings } from "./notification-schedule.js";

// ── Hàm thuần ────────────────────────────────────────────────────────────────

/** Một ngày không có quá chừng này mốc (24h / 1h = 24; dư một mốc cho ngày đổi giờ 25 tiếng). */
const MAX_SLOTS_PER_DAY = 25;

type Flag = number | boolean | null | undefined;

const isFalse = (value: Flag): boolean => value === 0 || value === false;
const isTrue = (value: Flag): boolean => value === 1 || value === true;

export type OverdueTodoFields = {
  status: string;
  parent_id: string | null;
  time: string | null;
  scheduled_date: string | null;
  estimated_minutes: number | null;
  is_important: Flag;
  is_urgent: Flag;
};

/**
 * Nhịp nhắc lặp (ms) theo nhóm (quan trọng, khẩn cấp), hoặc null nếu nhóm đó không nhắc lặp theo
 * từng todo:
 *
 * | quan trọng | khẩn cấp | nhắc                                                         |
 * | ---------- | -------- | ------------------------------------------------------------ |
 * | có         | có       | mỗi 1 giờ                                                    |
 * | có         | không    | không nhắc từng todo (tổng kết 17:00 + 07:00 sáng hôm sau)   |
 * | không      | có       | mỗi 2 giờ                                                    |
 * | không      | không    | không nhắc lặp (chỉ nhắc đúng giờ hẹn)                       |
 *
 * Chưa phân loại (ít nhất một cờ là null) thì không đoán: giữ nhịp mặc định 2 giờ như trước đây.
 */
export const overdueIntervalForFlags = (
  isImportant: Flag,
  isUrgent: Flag
): number | null => {
  if (isTrue(isImportant) && isTrue(isUrgent)) return OVERDUE.importantUrgentIntervalMs;
  if (isTrue(isImportant) && isFalse(isUrgent)) return null;
  if (isFalse(isImportant) && isFalse(isUrgent)) return null;
  return OVERDUE.intervalMs;
};

/**
 * Nhịp nhắc lặp (ms) của một todo, hoặc null nếu todo không được nhắc lặp theo từng todo. Điều kiện
 * chung: còn làm dở (open/in_progress), là todo cấp trên cùng, có ngày và giờ hẹn, và ước lượng
 * KHÔNG quá 2 giờ (trên 2h thì không bao giờ nhắc lặp; chưa ước lượng thì nhắc). Rồi theo nhóm:
 * xem `overdueIntervalForFlags`.
 */
export const todoOverdueIntervalMs = (todo: OverdueTodoFields): number | null => {
  if (todo.status !== "open" && todo.status !== "in_progress") return null;
  if (todo.parent_id !== null) return null;
  if (!todo.time || !todo.scheduled_date) return null;
  if (
    todo.estimated_minutes !== null &&
    todo.estimated_minutes > OVERDUE.maxEstimatedMinutes
  ) {
    return null;
  }
  return overdueIntervalForFlags(todo.is_important, todo.is_urgent);
};

/** Todo có thuộc diện nhắc lặp theo từng todo không (xem `todoOverdueIntervalMs`). */
export const todoWantsOverdue = <T extends OverdueTodoFields>(
  todo: T
): todo is T & { time: string; scheduled_date: string } =>
  todoOverdueIntervalMs(todo) !== null;

/**
 * Mọi mốc nhắc của ngày địa phương `date`: `scheduledAt` + k·`intervalMs` (k >= 1) còn rơi trong cùng
 * ngày đó. Hết ngày là hết nhắc (giờ hẹn 23:00 thì không có mốc nào). Mặc định 2 giờ.
 */
export const overdueSlots = (
  scheduledAt: Date,
  date: string,
  timezone: string,
  intervalMs: number = OVERDUE.intervalMs
): Date[] => {
  const slots: Date[] = [];
  for (let k = 1; k <= MAX_SLOTS_PER_DAY; k++) {
    const at = new Date(scheduledAt.getTime() + k * intervalMs);
    if (localDateOf(at, timezone) !== date) break;
    slots.push(at);
  }
  return slots;
};

/** Bỏ các mốc đã quá ngưỡng trễ: gửi muộn còn tệ hơn không gửi. Mốc tương lai được giữ. */
export const creatableOverdueSlots = (
  slots: readonly Date[],
  kind: OverdueKind,
  now: Date
): Date[] => slots.filter((slot) => now.getTime() - slot.getTime() <= LATENESS_MS[kind]);

/** `runAt` có đúng là một mốc nhắc lặp của giờ hẹn `scheduledAt` trong ngày `date` không? */
export const isOverdueSlot = (
  scheduledAt: Date,
  runAt: Date,
  date: string,
  timezone: string,
  intervalMs: number = OVERDUE.intervalMs
): boolean => {
  const diff = runAt.getTime() - scheduledAt.getTime();
  return (
    diff >= intervalMs &&
    diff % intervalMs === 0 &&
    localDateOf(runAt, timezone) === date
  );
};

// ── Hook: tính lại mốc nhắc của MỘT todo ─────────────────────────────────────

/**
 * Gọi sau mọi thay đổi của todo (đã đọc từ DB, còn tồn tại). Todo không thuộc diện nhắc lặp
 * (xong, đổi sang loại không quan trọng/khẩn cấp, ước lượng quá lớn, mất giờ hẹn...) thì hủy hết
 * mốc đang chờ.
 */
export const reconcileTodoOverdue = async (
  userId: string,
  todo: todosRepo.TodoRow,
  timezone: string,
  now: Date = new Date()
): Promise<void> => {
  const intervalMs = todoOverdueIntervalMs(todo);
  if (intervalMs === null || !todo.time || !todo.scheduled_date) {
    await jobsRepo.cancelSlotJobsExcept(userId, "todo_overdue", todo.id, []);
    return;
  }
  const scheduledAt = localDateTimeToUtc(todo.scheduled_date, todo.time, timezone);
  const slots = creatableOverdueSlots(
    overdueSlots(scheduledAt, todo.scheduled_date, timezone, intervalMs),
    "todo_overdue",
    now
  ).map((slot) => slot.toISOString());

  // Hủy phần thừa trước, rồi upsert phần cần: không có lúc nào mốc hợp lệ bị hủy tạm.
  await jobsRepo.cancelSlotJobsExcept(userId, "todo_overdue", todo.id, slots);
  for (const runAt of slots) {
    await jobsRepo.upsertSlotJob({
      userId,
      kind: "todo_overdue",
      refId: todo.id,
      localDate: todo.scheduled_date,
      runAt,
    });
  }
};

/** Đổi múi giờ: giờ hẹn đổi sang UTC khác nên tính lại mốc của mọi todo có giờ sắp tới. */
export const reconcileAllTodoOverdue = async (
  userId: string,
  now: Date = new Date()
): Promise<void> => {
  const ctx = await settingsRepo.getUserContext(userId);
  if (!ctx || !ctx.active) return;
  const { timezone } = resolveSettings(ctx);
  const fromDate = addDays(localDateOf(now, timezone), -1);
  for (const id of await sourcesRepo.listTimedTodoIds(userId, fromDate)) {
    const todo = await todosRepo.getTodoByIdScoped(id, userId);
    if (todo) await reconcileTodoOverdue(userId, todo, timezone, now);
  }
};

// ── Planner: vá todo chưa có mốc nào ─────────────────────────────────────────

/**
 * Lưới an toàn: tạo mốc nhắc lặp cho todo thuộc diện nhưng chưa có dòng nào (todo có trước tính
 * năng, hoặc một đường ghi bị sót hook). Nếu không còn mốc nào tạo được (đã quá ngưỡng trễ) thì
 * ghi một dòng `missed` làm dấu để lần quét sau không xét lại todo đó mãi.
 */
export const backfillTodoOverdue = async (now: Date = new Date()): Promise<number> => {
  // Ngày địa phương nhỏ nhất của mọi múi giờ là (ngày UTC - 1).
  const fromDate = addDays(now.toISOString().slice(0, 10), -1);
  const todos = await jobsRepo.listTodosMissingOverdueJobs(fromDate, DISPATCH.backfillBatchSize);
  let created = 0;
  for (const todo of todos) {
    const timezone = isValidTimeZone(todo.timezone)
      ? todo.timezone
      : DEFAULT_NOTIFICATION_SETTINGS.timezone;
    const scheduledAt = localDateTimeToUtc(todo.scheduled_date, todo.time, timezone);
    const intervalMs = overdueIntervalForFlags(todo.is_important, todo.is_urgent);
    // Nhóm không nhắc lặp theo từng todo (câu truy vấn đã loại sẵn): không có mốc nào để vá.
    if (intervalMs === null) continue;
    const all = overdueSlots(scheduledAt, todo.scheduled_date, timezone, intervalMs);
    const slots = creatableOverdueSlots(all, "todo_overdue", now);

    if (slots.length === 0) {
      await jobsRepo.insertSlotJobIfAbsent({
        userId: todo.user_id,
        kind: "todo_overdue",
        refId: todo.id,
        localDate: todo.scheduled_date,
        runAt: (all[all.length - 1] ?? scheduledAt).toISOString(),
        status: "missed",
      });
      continue;
    }
    for (const slot of slots) {
      const inserted = await jobsRepo.insertSlotJobIfAbsent({
        userId: todo.user_id,
        kind: "todo_overdue",
        refId: todo.id,
        localDate: todo.scheduled_date,
        runAt: slot.toISOString(),
        status: "pending",
      });
      if (inserted) created++;
    }
  }
  return created;
};

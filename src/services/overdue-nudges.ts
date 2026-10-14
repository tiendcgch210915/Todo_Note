/**
 * Nhắc LẶP khi người dùng bỏ lỡ giờ hẹn của một todo: giờ hẹn + 2h, +4h, ... cho tới hết ngày
 * địa phương đó, miễn là todo vẫn chưa xong. Module này KHÔNG import env/firebase để các service
 * nghiệp vụ dùng được trong test không có cấu hình.
 *
 * Mỗi mốc là MỘT dòng job (`todo_overdue`, unique theo user/kind/ref_id/run_at):
 *  - hook (`reconcileTodoOverdue`): todo đổi -> hủy mốc thừa, upsert mốc còn hợp lệ;
 *  - planner (`backfillTodoOverdue`): vá todo chưa có dòng nào (todo có trước tính năng);
 *  - kiểm tra lại ngay trước khi gửi (`todoWantsOverdue` + `isOverdueSlot` trong notification-tick).
 *
 * Phần dùng chung cho checklist (`overdueSlots`, `isOverdueSlot`) là hàm thuần ở đầu file.
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

/** Một ngày không có quá chừng này mốc (24h / 2h = 12; dư một mốc cho ngày đổi giờ 25 tiếng). */
const MAX_SLOTS_PER_DAY = 13;

type Flag = number | boolean | null | undefined;

const isFalse = (value: Flag): boolean => value === 0 || value === false;

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
 * Todo có thuộc diện nhắc lặp không. Cần ĐỒNG THỜI:
 *  - còn làm dở (open/in_progress), là todo cấp trên cùng, có ngày và giờ hẹn;
 *  - ước lượng KHÔNG quá 2 giờ (trên 2h thì không bao giờ nhắc lặp; chưa ước lượng thì nhắc);
 *  - không phải loại "không quan trọng, không khẩn cấp". Chỉ khi CẢ HAI cờ đều là false mới bỏ;
 *    chưa phân loại (null) thì không đoán, vẫn nhắc.
 */
export const todoWantsOverdue = <T extends OverdueTodoFields>(
  todo: T
): todo is T & { time: string; scheduled_date: string } => {
  if (todo.status !== "open" && todo.status !== "in_progress") return false;
  if (todo.parent_id !== null) return false;
  if (!todo.time || !todo.scheduled_date) return false;
  if (
    todo.estimated_minutes !== null &&
    todo.estimated_minutes > OVERDUE.maxEstimatedMinutes
  ) {
    return false;
  }
  if (isFalse(todo.is_important) && isFalse(todo.is_urgent)) return false;
  return true;
};

/**
 * Mọi mốc nhắc của ngày địa phương `date`: `scheduledAt` + 2h·k (k >= 1) còn rơi trong cùng ngày
 * đó. Hết ngày là hết nhắc (giờ hẹn 23:00 thì không có mốc nào).
 */
export const overdueSlots = (
  scheduledAt: Date,
  date: string,
  timezone: string
): Date[] => {
  const slots: Date[] = [];
  for (let k = 1; k <= MAX_SLOTS_PER_DAY; k++) {
    const at = new Date(scheduledAt.getTime() + k * OVERDUE.intervalMs);
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
  timezone: string
): boolean => {
  const diff = runAt.getTime() - scheduledAt.getTime();
  return (
    diff >= OVERDUE.intervalMs &&
    diff % OVERDUE.intervalMs === 0 &&
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
  if (!todoWantsOverdue(todo)) {
    await jobsRepo.cancelSlotJobsExcept(userId, "todo_overdue", todo.id, []);
    return;
  }
  const scheduledAt = localDateTimeToUtc(todo.scheduled_date, todo.time, timezone);
  const slots = creatableOverdueSlots(
    overdueSlots(scheduledAt, todo.scheduled_date, timezone),
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
    const all = overdueSlots(scheduledAt, todo.scheduled_date, timezone);
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

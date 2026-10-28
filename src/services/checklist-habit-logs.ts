import * as habitsRepo from "../repositories/habits.js";
import * as usersRepo from "../repositories/users.js";
import type { RunRow } from "../repositories/checklist-runs.js";
import { effectiveTimeZone, localDateOf } from "../utils/time.js";
import { pushLogger } from "./push-logger.js";

type CompletedRun = Pick<
  RunRow,
  "template_id" | "status" | "started_at" | "completed_at" | "updated_at" | "deleted_at"
>;

const parseInstant = (iso: string | null): Date | null => {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
};

/**
 * Một run của checklist vừa hoàn thành → mọi habit đang hoạt động gắn với checklist đó
 * được tick hoàn thành cho NGÀY ĐỊA PHƯƠNG (theo `users.timezone`) của `started_at`: bắt đầu
 * 23:30 và xong 00:30 vẫn tính cho ngày bắt đầu, giống quy tắc "xong của ngày" ở
 * `checklist-occurrence-done.ts`.
 *
 * Quy tắc giống todo-habit-logs: chỉ chạy ở sự kiện hoàn thành; đổi/xóa/bỏ hoàn thành run
 * sau đó không sửa log đã ghi; `note` của log được giữ; log ngày đã bị job nửa đêm đóng
 * (completed=0, auto_closed=1) được nâng lên completed=1.
 */
export const autoLogHabitsForCompletedRun = async (
  userId: string,
  run: CompletedRun
): Promise<habitsRepo.HabitLogRow[]> => {
  if (run.status !== "completed" || run.deleted_at) return [];
  const at =
    parseInstant(run.started_at) ??
    parseInstant(run.completed_at) ??
    parseInstant(run.updated_at);
  if (!at) return [];

  const habits = await habitsRepo.listLinkedHabits(userId, run.template_id);
  if (habits.length === 0) return [];

  const user = await usersRepo.getUserById(userId);
  const logDate = localDateOf(at, effectiveTimeZone(user?.timezone));

  const logs: habitsRepo.HabitLogRow[] = [];
  for (const habit of habits) {
    logs.push(await habitsRepo.upsertAutoLog(habit.id, logDate, true));
    await habitsRepo.recomputeStreaks(habit.id);
  }
  return logs;
};

/**
 * Người dùng đánh dấu tay "Đã xong" cho ngày `date` của checklist → mọi habit đang hoạt động gắn
 * với checklist đó được tick cho đúng ngày ấy (như khi một lần chạy hoàn thành). Đánh dấu ngược lại
 * ("Chưa hoàn thành") KHÔNG gỡ log đã ghi, cùng quy tắc với run: log là lịch sử, không tự rút lại.
 */
export const autoLogHabitsForMarkedDay = async (
  userId: string,
  templateId: string,
  date: string
): Promise<habitsRepo.HabitLogRow[]> => {
  const habits = await habitsRepo.listLinkedHabits(userId, templateId);
  const logs: habitsRepo.HabitLogRow[] = [];
  for (const habit of habits) {
    logs.push(await habitsRepo.upsertAutoLog(habit.id, date, true));
    await habitsRepo.recomputeStreaks(habit.id);
  }
  return logs;
};

export const autoLogHabitsForMarkedDaySafely = async (
  userId: string,
  templateId: string,
  date: string
): Promise<void> => {
  try {
    await autoLogHabitsForMarkedDay(userId, templateId, date);
  } catch (error) {
    pushLogger.error(
      {
        op: "checklist_mark_habit_log",
        errorName: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      "checklist day mark habit auto-log failed"
    );
  }
};

/**
 * Bản không bao giờ ném lỗi cho hai nơi gọi (REST và sync). Run đã được lưu là completed;
 * nếu hook ném lỗi thì sync push 500 cả lô, và khi client gửi lại `before.status` đã là
 * completed nên hook không bao giờ chạy lại. Lỗi chỉ được ghi log.
 */
export const autoLogHabitsForCompletedRunSafely = async (
  userId: string,
  run: CompletedRun
): Promise<void> => {
  try {
    await autoLogHabitsForCompletedRun(userId, run);
  } catch (error) {
    pushLogger.error(
      {
        op: "checklist_run_habit_log",
        errorName: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      "checklist run habit auto-log failed"
    );
  }
};

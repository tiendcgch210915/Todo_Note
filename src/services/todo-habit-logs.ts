import * as habitsRepo from "../repositories/habits.js";
import * as todosRepo from "../repositories/todos.js";
import * as usersRepo from "../repositories/users.js";
import { effectiveTimeZone } from "../utils/time.js";
import { isDoneOn } from "./checklist-occurrence-done.js";

const isDoneOnSchedule = (todo: todosRepo.TodoRow): boolean => {
  if (todo.status !== "done" || !todo.completed_at || !todo.scheduled_date) {
    return false;
  }
  return todo.completed_at.slice(0, 10) <= todo.scheduled_date;
};

// Habit gắn cả todo lẫn checklist: hai cách tick cùng hợp lệ, nên todo làm trễ không được hạ
// một ngày mà checklist của habit đã hoàn thành xuống "chưa xong".
const hasCompletedChecklistRunOn = async (
  userId: string,
  templateId: string,
  date: string
): Promise<boolean> => {
  const user = await usersRepo.getUserById(userId);
  return isDoneOn(userId, templateId, date, effectiveTimeZone(user?.timezone));
};

/**
 * Một todo gắn habit vừa hoàn thành → ghi log tự động cho ngày của todo (xong hết todo của ngày
 * đúng hạn thì tick, chưa thì giữ chỗ bằng 0).
 *
 * Tự động không bao giờ sửa trạng thái người dùng đã đặt cho ngày đó (đánh dấu bỏ lỡ trước, tick
 * tay): `upsertAutoLog` bỏ qua dòng ấy và trả về nguyên bản; chỉ người dùng đổi được. Trả về log
 * hiện có của ngày đó, dù có được ghi hay không.
 */
export const autoLogHabitForCompletedTodo = async (
  userId: string,
  todo: todosRepo.TodoRow
): Promise<habitsRepo.HabitLogRow | null> => {
  if (todo.status !== "done" || !todo.habit_id || !todo.scheduled_date) {
    return null;
  }

  const habit = await habitsRepo.getHabitById(todo.habit_id, userId);
  if (!habit) return null;

  const linkedTodos = await todosRepo.listTodosByHabitDate(
    userId,
    todo.habit_id,
    todo.scheduled_date
  );
  if (linkedTodos.length === 0) return null;

  let completed = linkedTodos.every(isDoneOnSchedule);
  if (!completed && habit.checklist_template_id) {
    completed = await hasCompletedChecklistRunOn(
      userId,
      habit.checklist_template_id,
      todo.scheduled_date
    );
  }
  const { log, written } = await habitsRepo.upsertAutoLog(
    todo.habit_id,
    todo.scheduled_date,
    completed
  );
  if (written) await habitsRepo.recomputeStreaks(todo.habit_id);
  return log;
};

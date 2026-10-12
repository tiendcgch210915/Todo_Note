import * as habitsRepo from "../repositories/habits.js";
import * as todosRepo from "../repositories/todos.js";
import * as schedulesRepo from "../repositories/checklist-schedules.js";
import * as usersRepo from "../repositories/users.js";
import { addDays, effectiveTimeZone, localDateTimeToUtc } from "../utils/time.js";

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
  const timeZone = effectiveTimeZone(user?.timezone);
  const runs = await schedulesRepo.listCompletedRuns(
    [userId],
    localDateTimeToUtc(date, "00:00", timeZone).toISOString(),
    localDateTimeToUtc(addDays(date, 1), "00:00", timeZone).toISOString(),
    [templateId]
  );
  return runs.length > 0;
};

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
  const log = await habitsRepo.upsertAutoLog(
    todo.habit_id,
    todo.scheduled_date,
    completed
  );
  await habitsRepo.recomputeStreaks(todo.habit_id);
  return log;
};

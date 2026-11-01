import * as dailyRepo from "../repositories/daily-todo-logs.js";
import * as dashRepo from "../repositories/dashboard.js";
import { addDays, daysInRange, nowISO } from "../utils/time.js";
import { getVietnamNowParts } from "../utils/vietnam-time.js";
import { computeScore, isCompletedForScore } from "./dashboard-scoring.js";
import type { TodoRow } from "../repositories/todos.js";

export type DailyTodoLog = dailyRepo.DailyTodoLogRow;
export type DailyTodoSummary = dailyRepo.DailyTodoSummaryRow;

export const vietnamToday = (now: Date = new Date()): string =>
  getVietnamNowParts(now).date;

export const isClosedTodoDate = (
  date: string,
  now: Date = new Date()
): boolean => date < vietnamToday(now);

const toLogStatus = (
  status: TodoRow["status"],
  completed: boolean
): TodoRow["status"] => {
  if (completed) return "done";
  if (status === "in_progress") return "in_progress";
  return "open";
};

export const closeUserTodoDay = async (
  userId: string,
  date: string,
  closedAt = nowISO()
): Promise<DailyTodoSummary> => {
  const existing = await dailyRepo.getDailyTodoSummary(userId, date);
  return existing ?? createDailySnapshot(userId, date, closedAt);
};

const createDailySnapshot = async (
  userId: string,
  date: string,
  closedAt: string
): Promise<DailyTodoSummary> => {
  const [snapshots, habits] = await Promise.all([
    dailyRepo.listTodoSnapshotsForDailyClose(userId, date),
    dashRepo.countDayHabits(userId, date),
  ]);
  const subtaskTrees = await dashRepo.listSubtaskTrees(
    userId,
    snapshots.map((todo) => todo.id)
  );
  const logs = snapshots.map((todo) => {
    const completed = isCompletedForScore(todo, date);
    return {
      user_id: userId,
      log_date: date,
      todo_id: todo.id,
      title: todo.title,
      description: todo.description,
      status: toLogStatus(todo.status, completed),
      completed: completed ? 1 : 0,
      completed_at: completed ? todo.completed_at : null,
      scheduled_date: todo.scheduled_date,
      time: todo.time,
      due_at: todo.due_at,
      is_important: todo.is_important,
      is_urgent: todo.is_urgent,
      is_frog: todo.is_frog,
      frog_date: todo.frog_date,
      estimated_minutes: todo.estimated_minutes,
      actual_minutes: completed ? todo.actual_minutes : null,
      position: todo.position,
      todo_created_at: todo.created_at,
      todo_updated_at: todo.updated_at,
    };
  });
  const doneTodos = logs.filter((log) => log.completed === 1).length;
  const score = computeScore(
    logs.map((log) => ({ ...log, subtasks: subtaskTrees.get(log.todo_id) ?? [] })),
    date,
    habits
  );

  return dailyRepo.insertDailyTodoClose({
    userId,
    date,
    logs,
    totalTodos: logs.length,
    doneTodos,
    score,
    closedAt,
  });
};

export const ensureUserTodoDayClosed = async (
  userId: string,
  date: string,
  now: Date = new Date()
): Promise<DailyTodoSummary | null> => {
  if (!isClosedTodoDate(date, now)) return null;
  return closeUserTodoDay(userId, date);
};

export const getClosedTodoSummaries = async (
  userId: string,
  from: string,
  to: string,
  now: Date = new Date()
): Promise<DailyTodoSummary[]> => {
  const today = vietnamToday(now);
  const closeTo = to < today ? to : addDays(today, -1);
  if (from > closeTo) return [];
  const summaries = await dailyRepo.listDailyTodoSummariesInRange(userId, from, closeTo);
  const existing = new Set(summaries.map((summary) => summary.log_date));
  const missing = daysInRange(from, closeTo).filter((date) => !existing.has(date));
  if (missing.length > 1) {
    for (const summary of await dailyRepo.closeEmptyTodoDays(userId, missing, nowISO())) {
      summaries.push(summary);
      existing.add(summary.log_date);
    }
  }
  for (const date of missing) {
    if (!existing.has(date)) summaries.push(await createDailySnapshot(userId, date, nowISO()));
  }
  return summaries;
};

export const ensurePastTodoDayClosedForMutation = async (
  userId: string,
  date: string | null | undefined,
  now: Date = new Date()
): Promise<void> => {
  if (!date || !isClosedTodoDate(date, now)) return;
  await closeUserTodoDay(userId, date);
};

// A subtask counts toward the day of the top-level todo it hangs under, whatever its own
// scheduled_date says, so a subtask mutation must freeze that day's score as well.
export const ensureTodoDayClosedForMutation = async (
  userId: string,
  todo: {
    scheduled_date: string | null | undefined;
    parent_id: string | null | undefined;
  },
  now: Date = new Date()
): Promise<void> => {
  await ensurePastTodoDayClosedForMutation(userId, todo.scheduled_date, now);
  if (!todo.parent_id) return;
  const rootDate = await dailyRepo.getRootScheduledDate(userId, todo.parent_id);
  await ensurePastTodoDayClosedForMutation(userId, rootDate, now);
};

export const listDailyTodoLogs = dailyRepo.listDailyTodoLogs;
export const getDailyTodoSummary = dailyRepo.getDailyTodoSummary;
export const countTimedLogsInRange = dailyRepo.countTimedLogsInRange;

export const closeAllUsersWithTodosForDate = async (
  date: string
): Promise<{ users: number }> => {
  const userIds = await dailyRepo.listUserIdsWithTodosForDate(date);
  for (const userId of userIds) {
    await closeUserTodoDay(userId, date);
  }
  return { users: userIds.length };
};

import * as dailyRepo from "../repositories/daily-todo-logs.js";
import * as dashRepo from "../repositories/dashboard.js";
import { addDays, daysInRange, nowISO } from "../utils/time.js";
import { getVietnamNowParts } from "../utils/vietnam-time.js";
import {
  computeScore,
  isCompletedForScore,
  type ScorableTodo,
} from "./dashboard-scoring.js";
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

const toScorable = (
  todo: dailyRepo.DailyTodoSnapshotRow
): ScorableTodo => ({
  status: todo.status,
  completed_at: todo.completed_at,
  is_important: todo.is_important,
  is_urgent: todo.is_urgent,
  is_frog: todo.is_frog,
  frog_date: todo.frog_date,
});

export const closeUserTodoDay = async (
  userId: string,
  date: string,
  closedAt = nowISO()
): Promise<DailyTodoSummary> => {
  const existing = await dailyRepo.getDailyTodoSummary(userId, date);
  if (existing) return existing;

  const [snapshots, habits] = await Promise.all([
    dailyRepo.listTodoSnapshotsForDailyClose(userId, date),
    dashRepo.countDayHabits(userId, date),
  ]);
  const logs = snapshots.map((todo) => {
    const completed = isCompletedForScore(toScorable(todo), date);
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
    logs.map((log) => ({
      status: log.status,
      completed_at: log.completed_at,
      is_important: log.is_important,
      is_urgent: log.is_urgent,
      is_frog: log.is_frog,
      frog_date: log.frog_date,
    })),
    date,
    habits
  );

  await dailyRepo.insertDailyTodoClose({
    userId,
    date,
    logs,
    totalTodos: logs.length,
    doneTodos,
    score,
    closedAt,
  });

  return (
    (await dailyRepo.getDailyTodoSummary(userId, date)) ?? {
      user_id: userId,
      log_date: date,
      total_todos: logs.length,
      done_todos: doneTodos,
      score,
      closed_at: closedAt,
      created_at: closedAt,
      updated_at: closedAt,
    }
  );
};

export const ensureUserTodoDayClosed = async (
  userId: string,
  date: string,
  now: Date = new Date()
): Promise<DailyTodoSummary | null> => {
  if (!isClosedTodoDate(date, now)) return null;
  return closeUserTodoDay(userId, date);
};

export const ensureUserTodoDaysClosed = async (
  userId: string,
  from: string,
  to: string,
  now: Date = new Date()
): Promise<void> => {
  const today = vietnamToday(now);
  const closeTo = to < today ? to : addDays(today, -1);
  if (from > closeTo) return;
  for (const date of daysInRange(from, closeTo)) {
    await closeUserTodoDay(userId, date);
  }
};

export const ensurePastTodoDayClosedForMutation = async (
  userId: string,
  date: string | null | undefined,
  now: Date = new Date()
): Promise<void> => {
  if (!date || !isClosedTodoDate(date, now)) return;
  await closeUserTodoDay(userId, date);
};

export const listDailyTodoLogs = dailyRepo.listDailyTodoLogs;
export const getDailyTodoSummary = dailyRepo.getDailyTodoSummary;
export const listDailyTodoSummariesInRange =
  dailyRepo.listDailyTodoSummariesInRange;

export const closeAllUsersWithTodosForDate = async (
  date: string
): Promise<{ users: number }> => {
  const userIds = await dailyRepo.listUserIdsWithTodosForDate(date);
  for (const userId of userIds) {
    await closeUserTodoDay(userId, date);
  }
  return { users: userIds.length };
};

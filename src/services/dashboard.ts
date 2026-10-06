import * as dashRepo from "../repositories/dashboard.js";
import * as usersRepo from "../repositories/users.js";
import * as dailyTodoLogs from "./daily-todo-logs.js";
import {
  listDayTopLevel,
  listTagsForTodoIds,
  type DayTopLevelRow,
} from "../repositories/todos.js";
import {
  addDays,
  daysInRange,
  DEFAULT_TIME_ZONE,
  getLocalNowParts,
  isoWeekday,
  startOfIsoWeek,
} from "../utils/time.js";
import type { TagRow } from "../repositories/tags.js";
import {
  computeScore,
  quadrantOf,
  type Quadrant,
} from "./dashboard-scoring.js";
import type {
  TodayQueryInput,
  CalendarDayDetailQueryInput,
  CalendarOverviewQueryInput,
  EisenhowerQueryInput,
} from "../schemas/api/dashboard.js";

// ============================================================
// GET /today
// ============================================================

export type TodayStats = {
  date: string;
  score: number;
  todos: { total: number; done: number };
  eisenhower_counts: {
    q1: number;
    q2: number;
    q3: number;
    q4: number;
  };
  habits_today: { total: number; completed: number };
  frog: { id: string; title: string; status: string } | null;
};

export const getTodayStats = async (
  userId: string,
  query: TodayQueryInput,
  now: Date = new Date()
): Promise<TodayStats> => {
  const date = query.date ?? dailyTodoLogs.vietnamToday(now);
  const isClosedDay = dailyTodoLogs.isClosedTodoDate(date, now);
  const [habits, liveFrog] = await Promise.all([
    dashRepo.countDayHabits(userId, date),
    isClosedDay ? Promise.resolve(null) : dashRepo.getFrogForDay(userId, date),
  ]);

  const counts = { q1: 0, q2: 0, q3: 0, q4: 0 };

  if (isClosedDay) {
    const summary = await dailyTodoLogs.ensureUserTodoDayClosed(
      userId,
      date,
      now
    );
    const logs = await dailyTodoLogs.listDailyTodoLogs(userId, date);
    for (const t of logs) {
      if (t.completed === 1) continue;
      counts[quadrantOf(t.is_important, t.is_urgent)]++;
    }
    const frogLog = logs.find((t) => t.is_frog === 1 && t.frog_date === date);
    return {
      date,
      score: summary?.score ?? 0,
      todos: {
        total: summary?.total_todos ?? logs.length,
        done: summary?.done_todos ?? logs.filter((t) => t.completed === 1).length,
      },
      eisenhower_counts: counts,
      habits_today: habits,
      frog: frogLog
        ? { id: frogLog.todo_id, title: frogLog.title, status: frogLog.status }
        : null,
    };
  }

  const todos = await dashRepo.listDayTopLevelStats(userId, date);
  const score = computeScore(todos, date, habits);

  for (const t of todos) {
    if (t.status === "done") continue;
    counts[quadrantOf(t.is_important, t.is_urgent)]++;
  }

  return {
    date,
    score,
    todos: {
      total: todos.length,
      done: todos.filter((t) => t.status === "done").length,
    },
    eisenhower_counts: counts,
    habits_today: habits,
    frog: liveFrog,
  };
};

// ============================================================
// GET /eisenhower
// ============================================================

export type EisenhowerTodo = {
  id: string;
  title: string;
  status: string;
  scheduled_date: string | null;
  time: string | null;
  is_important: boolean;
  is_urgent: boolean;
  is_frog: boolean;
  frog_date: string | null;
  quadrant: Quadrant;
  tags: TagRow[];
  tag_ids: string[];
};

export type EisenhowerByQuadrant = {
  q1: EisenhowerTodo[];
  q2: EisenhowerTodo[];
  q3: EisenhowerTodo[];
  q4: EisenhowerTodo[];
};

const toEisenhowerTodo = (
  t: dashRepo.DayTodoStat,
  tags: TagRow[] = []
): EisenhowerTodo => {
  const quadrant = quadrantOf(t.is_important, t.is_urgent);
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    scheduled_date: t.scheduled_date,
    time: t.time,
    is_important: t.is_important === 1,
    is_urgent: t.is_urgent === 1,
    is_frog: t.is_frog === 1,
    frog_date: t.frog_date,
    quadrant,
    tags,
    tag_ids: tags.map((tag) => tag.id),
  };
};

const toLoggedEisenhowerTodo = (
  t: dailyTodoLogs.DailyTodoLog
): EisenhowerTodo => {
  const quadrant = quadrantOf(t.is_important, t.is_urgent);
  return {
    id: t.todo_id,
    title: t.title,
    status: t.status,
    scheduled_date: t.log_date,
    time: t.time,
    is_important: t.is_important === 1,
    is_urgent: t.is_urgent === 1,
    is_frog: t.is_frog === 1,
    frog_date: t.frog_date,
    quadrant,
    tags: [],
    tag_ids: [],
  };
};

export const getEisenhower = async (
  userId: string,
  query: EisenhowerQueryInput,
  now: Date = new Date()
): Promise<{
  date: string;
  counts: TodayStats["eisenhower_counts"];
  by_quadrant: EisenhowerByQuadrant;
}> => {
  const date = query.date ?? dailyTodoLogs.vietnamToday(now);
  const by_quadrant: EisenhowerByQuadrant = {
    q1: [],
    q2: [],
    q3: [],
    q4: [],
  };
  const counts = { q1: 0, q2: 0, q3: 0, q4: 0 };

  if (dailyTodoLogs.isClosedTodoDate(date, now)) {
    await dailyTodoLogs.ensureUserTodoDayClosed(userId, date, now);
    const logs = await dailyTodoLogs.listDailyTodoLogs(userId, date);
    for (const t of logs) {
      if (t.completed === 1) continue;
      const q = quadrantOf(t.is_important, t.is_urgent);
      by_quadrant[q].push(toLoggedEisenhowerTodo(t));
      counts[q]++;
    }
    return { date, counts, by_quadrant };
  }

  const todos = await dashRepo.listDayTopLevelStats(userId, date);
  const tagMap = await listTagsForTodoIds(todos.map((todo) => todo.id));
  for (const t of todos) {
    if (t.status === "done") continue;
    const q = quadrantOf(t.is_important, t.is_urgent);
    by_quadrant[q].push(toEisenhowerTodo(t, tagMap.get(t.id) ?? []));
    counts[q]++;
  }
  return { date, counts, by_quadrant };
};

// ============================================================
// GET /calendar/day
// ============================================================

const WEEKDAY_LABELS_VI: Record<number, string> = {
  1: "T2",
  2: "T3",
  3: "T4",
  4: "T5",
  5: "T6",
  6: "T7",
  7: "CN",
};

const todoTimeToMinutes = (time: string): number => {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
};

const hourMarkLabel = (minuteOfDay: number): string => {
  const hour = Math.floor(minuteOfDay / 60) % 24;
  return `${String(hour).padStart(2, "0")}:00`;
};

export type CalendarTimelineTodo = {
  id: string;
  source: "live" | "daily_log";
  is_daily_log: boolean;
  log_id: string | null;
  todo_id: string;
  locked_completed: boolean | null;
  user_id: string;
  parent_id: string | null;
  title: string;
  description: string | null;
  status: "open" | "in_progress" | "done" | "archived";
  position: number;
  scheduled_date: string | null;
  time: string | null;
  minutes_since_midnight: number | null;
  estimated_minutes: number | null;
  actual_minutes: number | null;
  start_at: string | null;
  due_at: string | null;
  completed_at: string | null;
  is_frog: boolean;
  frog_date: string | null;
  is_important: boolean | null;
  is_urgent: boolean | null;
  trigger_after_todo_id: string | null;
  habit_id: string | null;
  recurrence_type: "daily" | "weekly" | "custom" | null;
  recurrence_interval: number | null;
  recurrence_days_of_week: string | null;
  recurrence_end_date: string | null;
  recurrence_template_id: string | null;
  has_subtasks: boolean;
  tags: TagRow[];
  tag_ids: string[];
  created_at: string;
  updated_at: string;
};

export type CalendarWeekDay = {
  date: string;
  iso_weekday: number;
  weekday_label: string;
  day_of_month: number;
  month: number;
  is_selected: boolean;
  is_today: boolean;
  total_todos: number;
  timed_todos: number;
  done_todos: number;
};

export type CalendarDayDetail = {
  date: string;
  timezone: string;
  week: {
    starts_on: "monday";
    from: string;
    to: string;
    days: CalendarWeekDay[];
  };
  timeline: {
    start_minute: 0;
    end_minute: 1440;
    slot_minutes: 60;
    hour_marks: { minute: number; label: string }[];
  };
  current_time_indicator: {
    visible: boolean;
    server_time: string;
    current_date: string;
    current_time: string;
    minutes_since_midnight: number;
    line_minutes_since_midnight: number | null;
    hidden_hour_mark_minute: number | null;
    hidden_hour_label: string | null;
  };
  timed_todos: CalendarTimelineTodo[];
  untimed_todos: CalendarTimelineTodo[];
  totals: {
    total_todos: number;
    timed_todos: number;
    untimed_todos: number;
    done_todos: number;
  };
};

const toCalendarTimelineTodo = (
  todo: DayTopLevelRow
): CalendarTimelineTodo => ({
  id: todo.id,
  source: "live",
  is_daily_log: false,
  log_id: null,
  todo_id: todo.id,
  locked_completed: null,
  user_id: todo.user_id,
  parent_id: todo.parent_id,
  title: todo.title,
  description: todo.description,
  status: todo.status,
  position: todo.position,
  scheduled_date: todo.scheduled_date,
  time: todo.time,
  minutes_since_midnight: todo.time ? todoTimeToMinutes(todo.time) : null,
  estimated_minutes: todo.estimated_minutes,
  actual_minutes: todo.actual_minutes,
  start_at: todo.start_at,
  due_at: todo.due_at,
  completed_at: todo.completed_at,
  is_frog: todo.is_frog === 1,
  frog_date: todo.frog_date,
  is_important:
    todo.is_important === null ? null : todo.is_important === 1,
  is_urgent: todo.is_urgent === null ? null : todo.is_urgent === 1,
  trigger_after_todo_id: todo.trigger_after_todo_id,
  habit_id: todo.habit_id,
  recurrence_type: todo.recurrence_type,
  recurrence_interval: todo.recurrence_interval,
  recurrence_days_of_week: todo.recurrence_days_of_week,
  recurrence_end_date: todo.recurrence_end_date,
  recurrence_template_id: todo.recurrence_template_id,
  has_subtasks: todo.has_subtasks === 1,
  tags: todo.tags,
  tag_ids: todo.tag_ids,
  created_at: todo.created_at,
  updated_at: todo.updated_at,
});

const toLoggedCalendarTimelineTodo = (
  todo: dailyTodoLogs.DailyTodoLog
): CalendarTimelineTodo => ({
  id: todo.todo_id,
  source: "daily_log",
  is_daily_log: true,
  log_id: todo.id,
  todo_id: todo.todo_id,
  locked_completed: todo.completed === 1,
  user_id: todo.user_id,
  parent_id: null,
  title: todo.title,
  description: todo.description,
  status: todo.status,
  position: todo.position,
  scheduled_date: todo.log_date,
  time: todo.time,
  minutes_since_midnight: todo.time ? todoTimeToMinutes(todo.time) : null,
  estimated_minutes: todo.estimated_minutes,
  actual_minutes: todo.actual_minutes,
  start_at: null,
  due_at: todo.due_at,
  completed_at: todo.completed_at,
  is_frog: todo.is_frog === 1,
  frog_date: todo.frog_date,
  is_important:
    todo.is_important === null ? null : todo.is_important === 1,
  is_urgent: todo.is_urgent === null ? null : todo.is_urgent === 1,
  trigger_after_todo_id: null,
  habit_id: null,
  recurrence_type: null,
  recurrence_interval: null,
  recurrence_days_of_week: null,
  recurrence_end_date: null,
  recurrence_template_id: null,
  has_subtasks: false,
  tags: [],
  tag_ids: [],
  created_at: todo.todo_created_at,
  updated_at: todo.todo_updated_at,
});

const compareCalendarTodos = (
  a: CalendarTimelineTodo,
  b: CalendarTimelineTodo
): number =>
  Number(b.is_frog) - Number(a.is_frog) ||
  a.position - b.position ||
  a.created_at.localeCompare(b.created_at) ||
  a.id.localeCompare(b.id);

const compareTimedCalendarTodos = (
  a: CalendarTimelineTodo,
  b: CalendarTimelineTodo
): number =>
  (a.minutes_since_midnight ?? 0) - (b.minutes_since_midnight ?? 0) ||
  compareCalendarTodos(a, b);

export const getCalendarDayDetail = async (
  userId: string,
  query: CalendarDayDetailQueryInput,
  now: Date = new Date()
): Promise<CalendarDayDetail> => {
  const date = query.date;
  const weekFrom = startOfIsoWeek(date);
  const weekTo = addDays(weekFrom, 6);
  const today = dailyTodoLogs.vietnamToday(now);
  const closedThrough = addDays(today, -1);

  await dailyTodoLogs.ensureUserTodoDaysClosed(userId, weekFrom, weekTo, now);

  const liveWeekFrom = weekFrom < today ? today : weekFrom;
  const closedSummaryFrom = weekFrom;
  const closedSummaryTo = weekTo < today ? weekTo : closedThrough;
  const isSelectedClosed = dailyTodoLogs.isClosedTodoDate(date, now);

  const [dayRows, dayLogRows, weekTodos, weekSummaries, user] =
    await Promise.all([
      isSelectedClosed ? Promise.resolve([]) : listDayTopLevel(userId, date),
      isSelectedClosed
        ? dailyTodoLogs.listDailyTodoLogs(userId, date)
        : Promise.resolve([]),
      liveWeekFrom <= weekTo
        ? dashRepo.rawTodosInRange(userId, liveWeekFrom, weekTo)
        : Promise.resolve([]),
      closedSummaryFrom <= closedSummaryTo
        ? dailyTodoLogs.listDailyTodoSummariesInRange(
            userId,
            closedSummaryFrom,
            closedSummaryTo
          )
        : Promise.resolve([]),
      usersRepo.getUserById(userId),
    ]);

  const nowParts = getLocalNowParts(user?.timezone ?? DEFAULT_TIME_ZONE, now);
  const currentMinutes = nowParts.hour * 60 + nowParts.minute;
  const visibleCurrentLine = date === nowParts.date;
  const hiddenHourMarkMinute = Math.round(currentMinutes / 60) * 60;

  const todos = isSelectedClosed
    ? dayLogRows.map(toLoggedCalendarTimelineTodo)
    : dayRows
        .filter((todo) => todo.status !== "archived")
        .map(toCalendarTimelineTodo);
  const timedTodos = todos
    .filter((todo) => todo.time !== null)
    .sort(compareTimedCalendarTodos);
  const untimedTodos = todos
    .filter((todo) => todo.time === null)
    .sort(compareCalendarTodos);

  const weekCounts: Record<
    string,
    { total_todos: number; timed_todos: number; done_todos: number }
  > = {};
  for (const d of daysInRange(weekFrom, weekTo)) {
    weekCounts[d] = { total_todos: 0, timed_todos: 0, done_todos: 0 };
  }
  for (const summary of weekSummaries) {
    if (!weekCounts[summary.log_date]) continue;
    const logs = await dailyTodoLogs.listDailyTodoLogs(userId, summary.log_date);
    weekCounts[summary.log_date] = {
      total_todos: summary.total_todos,
      timed_todos: logs.filter((todo) => todo.time !== null).length,
      done_todos: summary.done_todos,
    };
  }
  for (const todo of weekTodos) {
    if (!todo.scheduled_date || !weekCounts[todo.scheduled_date]) continue;
    weekCounts[todo.scheduled_date].total_todos++;
    if (todo.time !== null) weekCounts[todo.scheduled_date].timed_todos++;
    if (todo.status === "done") weekCounts[todo.scheduled_date].done_todos++;
  }

  const weekDays = daysInRange(weekFrom, weekTo).map((d) => {
    const [, month, day] = d.split("-").map(Number);
    const weekday = isoWeekday(d);
    return {
      date: d,
      iso_weekday: weekday,
      weekday_label: WEEKDAY_LABELS_VI[weekday],
      day_of_month: day,
      month,
      is_selected: d === date,
      is_today: d === nowParts.date,
      ...weekCounts[d],
    };
  });

  return {
    date,
    timezone: nowParts.timezone,
    week: {
      starts_on: "monday",
      from: weekFrom,
      to: weekTo,
      days: weekDays,
    },
    timeline: {
      start_minute: 0,
      end_minute: 1440,
      slot_minutes: 60,
      hour_marks: Array.from({ length: 25 }, (_, index) => ({
        minute: index * 60,
        label: hourMarkLabel(index * 60),
      })),
    },
    current_time_indicator: {
      visible: visibleCurrentLine,
      server_time: now.toISOString(),
      current_date: nowParts.date,
      current_time: nowParts.hhmm,
      minutes_since_midnight: currentMinutes,
      line_minutes_since_midnight: visibleCurrentLine ? currentMinutes : null,
      hidden_hour_mark_minute: visibleCurrentLine ? hiddenHourMarkMinute : null,
      hidden_hour_label: visibleCurrentLine
        ? hourMarkLabel(hiddenHourMarkMinute)
        : null,
    },
    timed_todos: timedTodos,
    untimed_todos: untimedTodos,
    totals: {
      total_todos: todos.length,
      timed_todos: timedTodos.length,
      untimed_todos: untimedTodos.length,
      done_todos: todos.filter((todo) => todo.status === "done").length,
    },
  };
};

// ============================================================
// GET /calendar
// ============================================================

export type CalendarDay = {
  total_todos: number;
  done_todos: number;
  score?: number; // chỉ có khi date <= today
  habits_total: number;
  habits_completed: number;
};

export type CalendarOverview = {
  from: string;
  to: string;
  days: Record<string, CalendarDay>;
};

export const getCalendarOverview = async (
  userId: string,
  query: CalendarOverviewQueryInput,
  now: Date = new Date()
): Promise<CalendarOverview> => {
  const today = dailyTodoLogs.vietnamToday(now);
  const closedThrough = addDays(today, -1);
  const days: Record<string, CalendarDay> = {};
  for (const d of daysInRange(query.from, query.to)) {
    days[d] = {
      total_todos: 0,
      done_todos: 0,
      habits_total: 0,
      habits_completed: 0,
    };
  }

  await dailyTodoLogs.ensureUserTodoDaysClosed(
    userId,
    query.from,
    query.to,
    now
  );

  const liveFrom = query.from < today ? today : query.from;
  const summaryTo = query.to < today ? query.to : closedThrough;
  const [todos, habits, logs] = await Promise.all([
    liveFrom <= query.to
      ? dashRepo.rawTodosInRange(userId, liveFrom, query.to)
      : Promise.resolve([]),
    dashRepo.activeHabitsInRange(userId, query.from, query.to),
    dashRepo.allLogsInRange(userId, query.from, query.to),
  ]);
  const dailySummaries =
    query.from <= summaryTo
      ? await dailyTodoLogs.listDailyTodoSummariesInRange(
          userId,
          query.from,
          summaryTo
        )
      : [];

  // Closed todo days are immutable snapshots.
  for (const summary of dailySummaries) {
    if (!days[summary.log_date]) continue;
    days[summary.log_date].total_todos = summary.total_todos;
    days[summary.log_date].done_todos = summary.done_todos;
    days[summary.log_date].score = summary.score;
  }

  // Live todos for today/future.
  const todosByDay: Record<string, dashRepo.DayTodoStat[]> = {};
  for (const t of todos) {
    if (!t.scheduled_date || !days[t.scheduled_date]) continue;
    (todosByDay[t.scheduled_date] ??= []).push(t);
    days[t.scheduled_date].total_todos++;
    if (t.status === "done") days[t.scheduled_date].done_todos++;
  }
  // Habits active per day
  for (const d of Object.keys(days)) {
    days[d].habits_total = habits.filter(
      (h) => h.start_date <= d && (h.end_date === null || h.end_date >= d)
    ).length;
  }

  // Habits completed per day
  const completedByDay: Record<string, Set<string>> = {};
  for (const l of logs) {
    if (l.completed === 1) {
      (completedByDay[l.log_date] ??= new Set()).add(l.habit_id);
    }
  }
  for (const [d, s] of Object.entries(completedByDay)) {
    if (days[d]) days[d].habits_completed = s.size;
  }

  for (const d of Object.keys(days)) {
    if (d === today) {
      days[d].score = computeScore(todosByDay[d] ?? [], d, {
        total: days[d].habits_total,
        completed: days[d].habits_completed,
      });
    }
  }

  return { from: query.from, to: query.to, days };
};

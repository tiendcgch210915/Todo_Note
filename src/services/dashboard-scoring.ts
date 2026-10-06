import { vietnamDateFromISO } from "../utils/vietnam-time.js";

export const TODO_WEIGHT_SCORE = 80;
export const FROG_BONUS_SCORE = 10;
export const HABIT_SCORE = 30;
export const MIN_TODOS_FOR_SCORE = 3;

export type Quadrant = "q1" | "q2" | "q3" | "q4";

export type ScorableTodo = {
  status: string;
  completed_at: string | null;
  is_important: number | null;
  is_urgent: number | null;
  is_frog: number;
  frog_date: string | null;
};

export const quadrantOf = (
  imp: number | null,
  urg: number | null
): Quadrant => {
  // Dashboard/mobile contract is a strict 4-cell Eisenhower matrix.
  // Old/unclassified rows are treated as Q4 instead of producing a fifth bucket.
  if (imp === null || urg === null) return "q4";
  if (imp === 1 && urg === 1) return "q1";
  if (imp === 1 && urg === 0) return "q2";
  if (imp === 0 && urg === 1) return "q3";
  return "q4";
};

export const isFrogForDate = (t: ScorableTodo, date: string): boolean =>
  t.is_frog === 1 && t.frog_date === date;

export const isScoredTodo = (t: ScorableTodo, date: string): boolean =>
  todoWeight(t, date) > 0;

export const isCompletedForScore = (
  t: ScorableTodo,
  date: string
): boolean => {
  if (t.status !== "done") return false;
  if (!t.completed_at) return false;
  const completedDate = vietnamDateFromISO(t.completed_at);
  return completedDate !== null && completedDate <= date;
};

const todoWeight = (t: ScorableTodo, date: string): number => {
  const regularWeight =
    (t.is_important === 1 ? 1 : 0) + (t.is_urgent === 1 ? 1 : 0);
  return isFrogForDate(t, date) ? Math.max(regularWeight, 2) : regularWeight;
};

const computeTodoScore = (
  todos: ScorableTodo[],
  date: string
): number => {
  const scoredTodos = todos.filter((t) => isScoredTodo(t, date));
  if (scoredTodos.length === 0) return 0;

  const totalWeight = scoredTodos.reduce(
    (sum, todo) => sum + todoWeight(todo, date),
    0
  );
  if (totalWeight === 0) return 0;

  const completedWeight = scoredTodos.reduce(
    (sum, todo) =>
      sum + (isCompletedForScore(todo, date) ? todoWeight(todo, date) : 0),
    0
  );
  const frogBonus = scoredTodos.some(
    (todo) => isFrogForDate(todo, date) && isCompletedForScore(todo, date)
  )
    ? FROG_BONUS_SCORE
    : 0;

  return (TODO_WEIGHT_SCORE * completedWeight) / totalWeight + frogBonus;
};

const computeHabitScore = (habits?: {
  total: number;
  completed: number;
}): number => {
  if (!habits || habits.total <= 0) return 0;
  return (HABIT_SCORE * habits.completed) / habits.total;
};

export const computeScore = (
  todos: ScorableTodo[],
  date: string,
  habits?: { total: number; completed: number }
): number => {
  const completedTodos = todos.filter((todo) =>
    isCompletedForScore(todo, date)
  ).length;
  if (
    todos.length < MIN_TODOS_FOR_SCORE ||
    completedTodos < MIN_TODOS_FOR_SCORE
  ) {
    return 0;
  }
  return Math.round(computeTodoScore(todos, date) + computeHabitScore(habits));
};

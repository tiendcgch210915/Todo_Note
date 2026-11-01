import { vietnamDateFromISO } from "../utils/vietnam-time.js";

export const TODO_WEIGHT_SCORE = 80;
export const FROG_BONUS_SCORE = 10;
export const HABIT_SCORE = 30;
export const MIN_TODOS_FOR_SCORE = 3;

export type Quadrant = "q1" | "q2" | "q3" | "q4";

export type ScorableSubtask = {
  status: string;
  completed_at: string | null;
  subtasks?: ScorableSubtask[];
};

export type ScorableTodo = ScorableSubtask & {
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
  t: Pick<ScorableSubtask, "status" | "completed_at">,
  date: string
): boolean => {
  if (t.status !== "done") return false;
  if (!t.completed_at) return false;
  const completedDate = vietnamDateFromISO(t.completed_at);
  return completedDate !== null && completedDate <= date;
};

// Share (0..1) of a todo's weight earned on `date`: all of it once the todo itself is completed,
// otherwise the fraction of its leaf subtasks (those with no subtasks of their own, at any depth)
// that are done, so 1 of 3 subtasks done earns a third. This is the same count the mobile app
// shows as the todo's percentage (`SubtaskProgress`), which keeps score and display consistent.
export const completionShare = (t: ScorableSubtask, date: string): number => {
  if (isCompletedForScore(t, date)) return 1;
  let done = 0;
  let total = 0;
  const countLeaves = (subtasks: ScorableSubtask[]): void => {
    for (const subtask of subtasks) {
      if (subtask.subtasks && subtask.subtasks.length > 0) {
        countLeaves(subtask.subtasks);
      } else {
        total++;
        if (isCompletedForScore(subtask, date)) done++;
      }
    }
  };
  countLeaves(t.subtasks ?? []);
  return total === 0 ? 0 : done / total;
};

const todoWeight = (t: ScorableTodo, date: string): number => {
  const regularWeight =
    (t.is_important === 1 ? 1 : 0) + (t.is_urgent === 1 ? 1 : 0);
  return isFrogForDate(t, date) ? Math.max(regularWeight, 2) : regularWeight;
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
  if (todos.length < MIN_TODOS_FOR_SCORE) return 0;
  let completedTodos = 0;
  let totalWeight = 0;
  let completedWeight = 0;
  let frogBonus = 0;
  for (const todo of todos) {
    const weight = todoWeight(todo, date);
    totalWeight += weight;
    completedWeight += weight * completionShare(todo, date);
    // Only fully completed todos count toward the minimum and earn the frog bonus.
    if (isCompletedForScore(todo, date)) {
      completedTodos++;
      if (isFrogForDate(todo, date)) frogBonus = FROG_BONUS_SCORE;
    }
  }
  if (completedTodos < MIN_TODOS_FOR_SCORE) return 0;
  const todoScore = totalWeight ? (TODO_WEIGHT_SCORE * completedWeight) / totalWeight : 0;
  return Math.round(todoScore + frogBonus + computeHabitScore(habits));
};

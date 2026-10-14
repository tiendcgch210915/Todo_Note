import * as habitsRepo from "../repositories/habits.js";
import { getTemplateForUser } from "../repositories/checklist-templates.js";
import { dayDiff } from "../utils/time.js";
import type {
  CreateHabitInput,
  UpdateHabitInput,
  LogHabitInput,
  PatchLogInput,
  CalendarRangeQueryInput,
} from "../schemas/api/habits.js";

export class ServiceError extends Error {
  constructor(
    public code: "not_found" | "archived" | "invalid_range" | "invalid_checklist"
  ) {
    super(code);
  }
}

const MAX_RANGE_DAYS = 90;

// Checklist gắn vào habit phải còn sống và người dùng thấy được (của mình hoặc mẫu hệ thống).
const assertChecklistVisible = async (
  userId: string,
  templateId: string | null | undefined
): Promise<void> => {
  if (!templateId) return;
  const template = await getTemplateForUser(templateId, userId);
  if (!template) throw new ServiceError("invalid_checklist");
};

export const createHabit = async (
  userId: string,
  input: CreateHabitInput
): Promise<habitsRepo.HabitRow> => {
  await assertChecklistVisible(userId, input.checklist_template_id);
  return habitsRepo.createHabit({
    user_id: userId,
    title: input.title,
    description: input.description ?? null,
    icon: input.icon ?? null,
    color: input.color,
    frequency_type: input.frequency_type,
    target_per_period: input.target_per_period,
    active_weekdays: input.active_weekdays ?? null,
    start_date: input.start_date,
    end_date: input.end_date ?? null,
    checklist_template_id: input.checklist_template_id ?? null,
  });
};

export const listHabits = async (
  userId: string,
  opts: { include_archived: boolean }
): Promise<habitsRepo.HabitRow[]> => {
  return habitsRepo.listHabitsByUser(userId, opts);
};

export const getHabitDetail = async (
  userId: string,
  id: string
): Promise<{
  habit: habitsRepo.HabitRow;
  recent_logs: habitsRepo.HabitLogRow[];
}> => {
  const habit = await habitsRepo.getHabitById(id, userId);
  if (!habit) throw new ServiceError("not_found");
  const recent_logs = await habitsRepo.listRecentLogs(id, 30);
  return { habit, recent_logs };
};

export const updateHabit = async (
  userId: string,
  id: string,
  patch: UpdateHabitInput
): Promise<habitsRepo.HabitRow> => {
  await assertChecklistVisible(userId, patch.checklist_template_id);
  const row = await habitsRepo.updateHabit(id, userId, patch);
  if (!row) throw new ServiceError("not_found");
  return row;
};

export const deleteHabit = async (userId: string, id: string): Promise<void> => {
  const ok = await habitsRepo.softDeleteHabit(id, userId);
  if (!ok) throw new ServiceError("not_found");
};

export const archiveHabit = async (
  userId: string,
  id: string
): Promise<habitsRepo.HabitRow> => {
  const row = await habitsRepo.updateHabit(id, userId, { is_archived: true });
  if (!row) throw new ServiceError("not_found");
  return row;
};

export const unarchiveHabit = async (
  userId: string,
  id: string
): Promise<habitsRepo.HabitRow> => {
  const row = await habitsRepo.updateHabit(id, userId, { is_archived: false });
  if (!row) throw new ServiceError("not_found");
  return row;
};

export const logHabit = async (
  userId: string,
  habitId: string,
  input: LogHabitInput
): Promise<{
  log: habitsRepo.HabitLogRow;
  streaks: { current: number; longest: number };
}> => {
  const habit = await habitsRepo.getHabitById(habitId, userId);
  if (!habit) throw new ServiceError("not_found");
  if (habit.is_archived === 1) throw new ServiceError("archived");

  const log = await habitsRepo.upsertLog(
    habitId,
    input.log_date,
    input.completed,
    input.note ?? null
  );
  const streaks = await habitsRepo.recomputeStreaks(habitId);
  return { log, streaks };
};

export const patchLog = async (
  userId: string,
  habitId: string,
  logDate: string,
  patch: PatchLogInput
): Promise<{
  log: habitsRepo.HabitLogRow;
  streaks: { current: number; longest: number };
}> => {
  const habit = await habitsRepo.getHabitById(habitId, userId);
  if (!habit) throw new ServiceError("not_found");
  if (habit.is_archived === 1) throw new ServiceError("archived");

  const existing = await habitsRepo.getLog(habitId, logDate);
  if (!existing) throw new ServiceError("not_found");

  const log = await habitsRepo.upsertLog(
    habitId,
    logDate,
    patch.completed ?? existing.completed === 1,
    patch.note !== undefined ? patch.note : existing.note
  );
  const streaks = await habitsRepo.recomputeStreaks(habitId);
  return { log, streaks };
};

export const removeLog = async (
  userId: string,
  habitId: string,
  logDate: string
): Promise<{ streaks: { current: number; longest: number } }> => {
  const habit = await habitsRepo.getHabitById(habitId, userId);
  if (!habit) throw new ServiceError("not_found");
  const ok = await habitsRepo.deleteLog(habitId, logDate);
  if (!ok) throw new ServiceError("not_found");
  const streaks = await habitsRepo.recomputeStreaks(habitId);
  return { streaks };
};

const assertRangeOk = (from: string, to: string) => {
  const diff = dayDiff(from, to);
  if (diff < 0 || diff > MAX_RANGE_DAYS) {
    throw new ServiceError("invalid_range");
  }
};

export const getHabitLogs = async (
  userId: string,
  habitId: string,
  query: CalendarRangeQueryInput
): Promise<habitsRepo.HabitLogRow[]> => {
  const habit = await habitsRepo.getHabitById(habitId, userId);
  if (!habit) throw new ServiceError("not_found");
  assertRangeOk(query.from, query.to);
  return habitsRepo.listLogsInRange(habitId, query.from, query.to);
};

export const getCalendar = async (
  userId: string,
  query: CalendarRangeQueryInput
): Promise<{
  from: string;
  to: string;
  by_date: Record<string, Record<string, number>>;
}> => {
  assertRangeOk(query.from, query.to);
  const logs = await habitsRepo.listAllLogsInRange(userId, query.from, query.to);
  const by_date: Record<string, Record<string, number>> = {};
  for (const l of logs) {
    if (!by_date[l.log_date]) by_date[l.log_date] = {};
    by_date[l.log_date][l.habit_id] = l.completed;
  }
  return { from: query.from, to: query.to, by_date };
};

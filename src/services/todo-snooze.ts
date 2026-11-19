/**
 * Snooze a todo's reminder, like an alarm clock: `POST /api/v1/todos/:id/snooze { minutes }` moves the
 * reminder time (`todos.scheduled_date` + `todos.time`) `minutes` later, keeps every device in step through the
 * normal sync, and removes the notification that is on the phones right now.
 *
 * Where the time lands. The new time is `minutes` after the LATER of (a) the todo's current reminder time and
 * (b) the current minute, in the user's time zone:
 *   - tapped on the on-time reminder: 15:00 todo + 30 min -> 15:30 (the example this feature was specified with);
 *   - tapped late (a nudge two hours on, a card that sat in the tray): "N minutes from now", not "N minutes after
 *     a time that has long passed" (that would land in the past and never ring again);
 *   - snoozed before it is due (from the todo screen): the reminder is pushed N minutes past its current time.
 * The time has minute resolution (`HH:mm`), so seconds are dropped: tapping at 15:00:40 for 30 minutes gives 15:30.
 * Past midnight the date rolls over (23:50 + 30 min -> 00:20 the next day); a snooze of an overdue todo moves it to
 * today, which is what "do it later today" means.
 *
 * What it reuses instead of re-implementing. The write goes through `updateTodo` (the REST edit path), so the
 * past-day lock, frog handling, the sync stamp (`sync_stamps`, which is what makes the other devices pull the new
 * time) and `onTodoChanged` (re-arms `todo_reminder`, the +5 min repeat and the overdue nudges around the NEW time,
 * and re-queues same-time reminders) all apply as they do for any other time edit. Two things differ:
 *   - the edit is scoped to THIS occurrence (`time_scope: "this"`): snoozing today's run of a recurring todo never
 *     changes the series' usual time (no scope prompt, unlike a hand edit);
 *   - the card is removed unconditionally (`dismiss.force`): the user asked for it, so neither "no delivered card
 *     recorded" nor "the next notification is due within 4 minutes" may skip it. Its TTL is cut to just under the
 *     time to the new reminder so a late-delivered dismiss cannot remove the notification that replaces it.
 */
import * as settingsRepo from "../repositories/notification-settings.js";
import * as todosRepo from "../repositories/todos.js";
import type { SnoozeTodoInput } from "../schemas/api/todos.js";
import { getLocalNowParts, localDateTimeToUtc } from "../utils/time.js";
import { snoozeDismissTtlMs } from "./notification-cards.js";
import { resolveSettings } from "./notification-schedule.js";
import { ServiceError, updateTodo } from "./todos.js";

export class SnoozeError extends Error {
  constructor(
    public code:
      /** Done or archived: there is nothing left to remind about (the app should drop the card). */
      | "todo_completed"
      /** No reminder time to move: no date or time, or a subtask. */
      | "no_reminder"
  ) {
    super(code);
  }
}

export type SnoozeTarget = {
  /** New local date, `YYYY-MM-DD`. */
  date: string;
  /** New local time, `HH:mm`. */
  time: string;
  /** The same moment as a UTC instant (when the reminder is due, before any queueing). */
  remindAt: Date;
};

/**
 * The reminder time after a snooze (see the file header for the rule). Pure: `appointment` is the current
 * reminder as a UTC instant, `now` the clock, `timezone` the user's IANA zone.
 */
export const computeSnoozeTarget = (
  appointment: Date,
  now: Date,
  minutes: number,
  timezone: string
): SnoozeTarget => {
  const currentMinute = Math.floor(now.getTime() / 60_000) * 60_000;
  const base = Math.max(appointment.getTime(), currentMinute);
  const local = getLocalNowParts(timezone, new Date(base + minutes * 60_000));
  return {
    date: local.date,
    time: local.hhmm,
    remindAt: localDateTimeToUtc(local.date, local.hhmm, timezone),
  };
};

export type SnoozeResult = {
  todo: todosRepo.TodoWithTags;
  minutes: number;
  /** When the reminder is due again (UTC). A reminder held behind another todo's countdown can arrive later. */
  remind_at: string;
  /** The reminder time before the snooze, e.g. to offer "undo" with a `PATCH` (`time_scope: "this"`). */
  previous: { scheduled_date: string; time: string };
};

/**
 * Another live occurrence of the same series already sits on the date a snooze would roll over to. The series keeps
 * one live top-level occurrence per day, so this is refused instead of creating a second one.
 */
const assertDateFreeInSeries = async (
  userId: string,
  todo: todosRepo.TodoRow,
  date: string
): Promise<void> => {
  if (todo.recurrence_type === null && todo.recurrence_template_id === null) return;
  const seriesId = todo.recurrence_template_id ?? todo.id;
  const holder = await todosRepo.findRecurringOccurrenceByDate(userId, seriesId, date);
  if (holder && holder.id !== todo.id) throw new ServiceError("duplicate");
};

/**
 * Snooze `id` by `input.minutes`. Throws `ServiceError("not_found")` (unknown, foreign or deleted), `SnoozeError`
 * (done/archived, or no reminder time) and `ServiceError("duplicate")` (a recurring todo whose snooze would roll over
 * to a day another occurrence already holds). `now` is only for tests.
 */
export const snoozeTodo = async (
  userId: string,
  id: string,
  input: SnoozeTodoInput,
  now: Date = new Date()
): Promise<SnoozeResult> => {
  const before = await todosRepo.getTodoByIdScoped(id, userId);
  if (!before) throw new ServiceError("not_found");
  if (before.status !== "open" && before.status !== "in_progress") {
    throw new SnoozeError("todo_completed");
  }
  if (before.parent_id !== null || !before.scheduled_date || !before.time) {
    throw new SnoozeError("no_reminder");
  }

  // The same zone the reminder jobs are planned in (`rearmTodoJobs`), so the time computed here is the time they use.
  const ctx = await settingsRepo.getUserContext(userId);
  const { timezone } = resolveSettings(
    ctx ?? { timezone: null, morning_time: null, evening_time: null }
  );
  const appointment = localDateTimeToUtc(before.scheduled_date, before.time, timezone);
  const target = computeSnoozeTarget(appointment, now, input.minutes, timezone);

  const dateChanges = target.date !== before.scheduled_date;
  if (dateChanges) await assertDateFreeInSeries(userId, before, target.date);

  const todo = await updateTodo(
    userId,
    id,
    {
      ...(dateChanges ? { scheduled_date: target.date } : {}),
      time: target.time,
      time_scope: "this",
    },
    {
      now,
      dismiss: { force: true, ttlMs: snoozeDismissTtlMs(target.remindAt.getTime() - now.getTime()) },
    }
  );

  return {
    todo,
    minutes: input.minutes,
    remind_at: target.remindAt.toISOString(),
    previous: { scheduled_date: before.scheduled_date, time: before.time },
  };
};

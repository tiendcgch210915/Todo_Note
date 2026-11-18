import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";
process.env.JWT_SECRET = "test-jwt-secret-123";
process.env.JWT_ADMIN_SECRET = "test-admin-secret-123";
process.env.COOKIE_SECRET = "test-cookie-secret-123456789012345";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD_HASH = `$2b$12$${"a".repeat(53)}`;
process.env.GOOGLE_APPLICATION_CREDENTIALS = "./does-not-exist-service-account.json";

const { turso } = await import("../src/config/db.js");
const habitsRepo = await import("../src/repositories/habits.js");
const { closeHabitDay } = await import("../src/repositories/habit-day-close.js");
const habitsService = await import("../src/services/habits.js");
const todosService = await import("../src/services/todos.js");
const checklistsService = await import("../src/services/checklists.js");
const { autoLogHabitsForCompletedRun } = await import("../src/services/checklist-habit-logs.js");
const { processPush } = await import("../src/services/sync.service.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

/**
 * The rule under test: automation (a linked todo or checklist finishing) never changes a habit
 * status the user set, whichever way it points ("marked missed in advance" is the case that
 * prompted it). Only the user changes it. Automation may still fill a day nobody has set and
 * raise a placeholder zero (the midnight job's, or "not all todos done yet") to done.
 *
 * Every path that reaches `upsertAutoLog` has its own test, and each one carries a control (a
 * second day nobody set that IS ticked) so a test cannot pass just because the event never ran.
 */

const { USER_ID } = fx;
const OLD = "2026-01-01T00:00:00.000Z";
const HABIT = "habit-main";
const OTHER_HABIT = "habit-other";
const TEMPLATE = "tst-template";

// Todos: far-future days. The user marks MISSED_DAY in advance; completing early is "on time".
const MISSED_DAY = "2099-01-01";
const OPEN_DAY = "2099-01-02";
// Checklists: the day of a run is the local day it STARTED, so runs start at noon (Ho Chi Minh).
const RUN_MISSED_DAY = "2026-06-19";
const RUN_OPEN_DAY = "2026-06-20";
const runStart = (day: string): string => `${day}T05:00:00.000Z`;

// (completed, auto_closed): who wrote the status. auto_closed = 1 means "no user intent".
const USER_MISSED = { completed: 0, auto_closed: 0 };
const AUTO_ZERO = { completed: 0, auto_closed: 1 };
const AUTO_TICK = { completed: 1, auto_closed: 1 };

type LogRow = {
  completed: number;
  note: string | null;
  updated_at: string;
  auto_closed: number;
  deleted_at: string | null;
};

const rowOf = async (habitId: string, date: string): Promise<LogRow | null> => {
  const res = await turso.execute({
    sql: `SELECT completed, note, updated_at, auto_closed, deleted_at
          FROM habit_logs WHERE habit_id = ? AND log_date = ?`,
    args: [habitId, date],
  });
  const row = res.rows[0] as unknown as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    completed: Number(row.completed),
    note: (row.note as string | null) ?? null,
    updated_at: row.updated_at as string,
    auto_closed: Number(row.auto_closed),
    deleted_at: (row.deleted_at as string | null) ?? null,
  };
};

/** (completed, auto_closed) of the LIVE log of that day, or null. */
const stateOf = async (habitId: string, date: string) => {
  const row = await rowOf(habitId, date);
  if (!row || row.deleted_at !== null) return null;
  return { completed: row.completed, auto_closed: row.auto_closed };
};

const habitRow = async (id: string) => {
  const res = await turso.execute({
    sql: "SELECT current_streak, longest_streak, updated_at FROM habits WHERE id = ?",
    args: [id],
  });
  const row = res.rows[0] as unknown as Record<string, unknown>;
  return {
    longest_streak: Number(row.longest_streak),
    updated_at: row.updated_at as string,
  };
};

/** The user marks the day the way the app does (POST /habits/:id/logs, or the pushed habit_log). */
const markMissed = (habitId: string, date: string, note?: string) =>
  habitsService.logHabit(USER_ID, habitId, {
    log_date: date,
    completed: false,
    ...(note === undefined ? {} : { note }),
  });

const linkedTodo = async (id: string, habitId: string, scheduledDate: string): Promise<void> => {
  await fx.insertTodo(turso, { id, scheduledDate });
  await turso.execute({ sql: "UPDATE todos SET habit_id = ? WHERE id = ?", args: [habitId, id] });
};

const linkToChecklist = async (habitId: string): Promise<void> => {
  await turso.execute({
    sql: "UPDATE habits SET checklist_template_id = ? WHERE id = ?",
    args: [TEMPLATE, habitId],
  });
};

before(async () => {
  await applyAllMigrations(turso);
});

beforeEach(async () => {
  for (const table of [
    "notification_jobs",
    "todo_timers",
    "notification_settings",
    "user_devices",
    "checklist_occurrence_marks",
    "checklist_schedule_overrides",
    "checklist_schedules",
    "habit_close_cursors",
    "habit_logs",
    "habits",
    "checklist_run_items",
    "checklist_runs",
    "checklist_template_items",
    "daily_todo_logs",
    "daily_todo_summaries",
    "todo_tags",
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await turso.execute(
    "DELETE FROM checklist_templates WHERE user_id <> '00000000-0000-0000-0000-000000000001'"
  );
  await turso.execute(
    "UPDATE todos SET parent_id = NULL, trigger_after_todo_id = NULL, recurrence_template_id = NULL"
  );
  await turso.execute("DELETE FROM todos");
  await turso.execute(`DELETE FROM users WHERE id = '${USER_ID}'`);

  await fx.insertUser(turso, USER_ID);
  await fx.insertTemplateWithItems(turso, { id: TEMPLATE, itemCount: 2 });
  await fx.insertHabit(turso, { id: HABIT });
  await fx.insertHabit(turso, { id: OTHER_HABIT });
});

// ── the rule, at the repository ──────────────────────────────────────────────

test("upsertAutoLog fills a day nobody has set, as an automatic row", async () => {
  const zero = await habitsRepo.upsertAutoLog(HABIT, "2026-06-01", false);
  assert.equal(zero.written, true);
  assert.deepEqual(await stateOf(HABIT, "2026-06-01"), AUTO_ZERO);

  const tick = await habitsRepo.upsertAutoLog(HABIT, "2026-06-02", true);
  assert.equal(tick.written, true);
  assert.deepEqual(await stateOf(HABIT, "2026-06-02"), AUTO_TICK);
});

test("upsertAutoLog never touches a log the user set, whichever way either one points", async () => {
  for (const [userDone, autoDone] of [
    [false, true],
    [true, false],
    [false, false],
    [true, true],
  ] as const) {
    const day = `2026-07-${userDone ? 1 : 2}${autoDone ? 1 : 2}`;
    const label = `user=${userDone ? "done" : "missed"} auto=${autoDone ? "done" : "missed"}`;
    const mine = await habitsRepo.upsertLog(HABIT, day, userDone, "my note");

    const attempt = await habitsRepo.upsertAutoLog(HABIT, day, autoDone);

    assert.equal(attempt.written, false, label);
    assert.deepEqual(
      await stateOf(HABIT, day),
      { completed: userDone ? 1 : 0, auto_closed: 0 },
      label
    );
    assert.equal(attempt.log.note, "my note", label);
    assert.equal(attempt.log.updated_at, mine.updated_at, label);
  }
});

test("an automatic zero is only raised to done, an automatic tick is never lowered", async () => {
  const day = "2026-06-03";
  assert.equal((await habitsRepo.upsertAutoLog(HABIT, day, false)).written, true);
  assert.equal(
    (await habitsRepo.upsertAutoLog(HABIT, day, false)).written,
    false,
    "0 over 0 changes nothing, so nothing is written"
  );

  assert.equal((await habitsRepo.upsertAutoLog(HABIT, day, true)).written, true);
  assert.deepEqual(await stateOf(HABIT, day), AUTO_TICK);

  assert.equal((await habitsRepo.upsertAutoLog(HABIT, day, false)).written, false);
  assert.deepEqual(await stateOf(HABIT, day), AUTO_TICK, "automation does not take a tick back");
});

test("a write by the user takes an automatic row over for good", async () => {
  const day = "2026-06-04";
  await habitsRepo.upsertAutoLog(HABIT, day, true);

  await habitsRepo.upsertLog(HABIT, day, false, null);
  assert.deepEqual(await stateOf(HABIT, day), USER_MISSED);

  assert.equal((await habitsRepo.upsertAutoLog(HABIT, day, true)).written, false);
  assert.deepEqual(await stateOf(HABIT, day), USER_MISSED);
});

test("a log the user removed hands the day back to automation", async () => {
  const day = "2026-06-05";
  await habitsRepo.upsertLog(HABIT, day, false, null);
  await habitsRepo.deleteLog(HABIT, day);
  assert.equal(await habitsRepo.getLog(HABIT, day), null);

  assert.equal((await habitsRepo.upsertAutoLog(HABIT, day, true)).written, true);
  assert.deepEqual(await stateOf(HABIT, day), AUTO_TICK);
});

test("the zero the midnight job wrote counts as automatic, one the user wrote does not", async () => {
  const day = "2026-06-06";
  await habitsRepo.upsertLog(OTHER_HABIT, day, false, null);

  assert.equal(
    await closeHabitDay(USER_ID, day, "2026-06-07T00:00:00.000Z"),
    1,
    "only the habit without a log is closed"
  );
  assert.deepEqual(await stateOf(HABIT, day), AUTO_ZERO);
  assert.deepEqual(await stateOf(OTHER_HABIT, day), USER_MISSED);

  assert.equal((await habitsRepo.upsertAutoLog(HABIT, day, true)).written, true);
  assert.equal((await habitsRepo.upsertAutoLog(OTHER_HABIT, day, true)).written, false);
  assert.deepEqual(await stateOf(HABIT, day), AUTO_TICK);
  assert.deepEqual(await stateOf(OTHER_HABIT, day), USER_MISSED);
});

// ── linked todos ─────────────────────────────────────────────────────────────

test("todo (REST): completing the todo of a day marked missed in advance leaves it missed", async () => {
  await linkedTodo("todo-skip", HABIT, MISSED_DAY);
  await linkedTodo("todo-open", HABIT, OPEN_DAY);
  const marked = await markMissed(HABIT, MISSED_DAY, "travelling");
  await turso.execute({ sql: "UPDATE habits SET updated_at = ? WHERE id = ?", args: [OLD, HABIT] });

  await todosService.completeTodo(USER_ID, "todo-skip", {});

  assert.deepEqual(await stateOf(HABIT, MISSED_DAY), USER_MISSED);
  const row = await rowOf(HABIT, MISSED_DAY);
  assert.equal(row?.note, "travelling");
  assert.equal(row?.updated_at, marked.log.updated_at, "the user's row was not even rewritten");
  assert.deepEqual(
    await habitRow(HABIT),
    { longest_streak: 0, updated_at: OLD },
    "nothing was written, so the streaks were not recomputed either"
  );

  // Control: the same event on a day nobody set still ticks it (and recomputes the streaks).
  await todosService.completeTodo(USER_ID, "todo-open", {});
  assert.deepEqual(await stateOf(HABIT, OPEN_DAY), AUTO_TICK);
  assert.equal((await habitRow(HABIT)).longest_streak, 1);
});

test("todo (REST): a status the user flipped after an automatic tick is theirs from then on", async () => {
  await linkedTodo("todo-1", HABIT, OPEN_DAY);
  await todosService.completeTodo(USER_ID, "todo-1", {});
  assert.deepEqual(await stateOf(HABIT, OPEN_DAY), AUTO_TICK);

  await habitsService.patchLog(USER_ID, HABIT, OPEN_DAY, { completed: false });
  assert.deepEqual(await stateOf(HABIT, OPEN_DAY), USER_MISSED);

  await linkedTodo("todo-2", HABIT, OPEN_DAY);
  await todosService.completeTodo(USER_ID, "todo-2", {});
  assert.deepEqual(await stateOf(HABIT, OPEN_DAY), USER_MISSED);
});

test("todo (REST): removing the log hands the day back, so the next completion ticks it", async () => {
  await linkedTodo("todo-1", HABIT, MISSED_DAY);
  await markMissed(HABIT, MISSED_DAY);
  await habitsService.removeLog(USER_ID, HABIT, MISSED_DAY);

  await todosService.completeTodo(USER_ID, "todo-1", {});

  assert.deepEqual(await stateOf(HABIT, MISSED_DAY), AUTO_TICK);
});

const logPush = (id: string, date: string, completed: boolean) => ({
  op: "create",
  type: "habit_log",
  payload: {
    id,
    habit_id: HABIT,
    log_date: date,
    completed,
    note: null,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
  },
});

const todoDonePush = (id: string) => ({
  op: "update",
  type: "todo",
  payload: {
    id,
    updated_at: "2026-06-02T00:00:00.000Z",
    status: "done",
    completed_at: "2026-06-02T00:00:00.000Z",
  },
});

test("todo (sync): a missed log and the completion of its todo pushed together leave the day missed", async () => {
  await linkedTodo("todo-skip", HABIT, MISSED_DAY);
  await linkedTodo("todo-open", HABIT, OPEN_DAY);

  const results = await processPush(USER_ID, [
    logPush("log-skip", MISSED_DAY, false),
    todoDonePush("todo-skip"),
    todoDonePush("todo-open"),
  ] as never);

  assert.deepEqual(
    results.map((r) => r.status),
    ["applied", "applied", "applied"]
  );
  assert.deepEqual(await stateOf(HABIT, MISSED_DAY), USER_MISSED);
  assert.deepEqual(await stateOf(HABIT, OPEN_DAY), AUTO_TICK, "control");
});

test("todo (sync): a missed log pushed AFTER the completion reached the server still wins", async () => {
  await linkedTodo("todo-first", HABIT, MISSED_DAY);
  // The completion arrives first (another device, or the app pushed it first) and ticks the day.
  await todosService.completeTodo(USER_ID, "todo-first", {});
  assert.deepEqual(await stateOf(HABIT, MISSED_DAY), AUTO_TICK);

  // The user's earlier "missed" mark (another id for the same habit + day) now arrives.
  const [result] = await processPush(USER_ID, [logPush("phone-log", MISSED_DAY, false)] as never);

  assert.equal(result.status, "conflict", "the phone is told to adopt the canonical row");
  assert.equal(result.server_version?.completed, false);
  assert.deepEqual(await stateOf(HABIT, MISSED_DAY), USER_MISSED);

  // From then on automation leaves it alone.
  await linkedTodo("todo-second", HABIT, MISSED_DAY);
  await todosService.completeTodo(USER_ID, "todo-second", {});
  assert.deepEqual(await stateOf(HABIT, MISSED_DAY), USER_MISSED);
});

test("todo (sync): a row the user already set is not taken over by another id", async () => {
  await markMissed(HABIT, MISSED_DAY);

  const [result] = await processPush(USER_ID, [logPush("stale-phone-log", MISSED_DAY, true)] as never);

  assert.equal(result.status, "conflict");
  assert.deepEqual(await stateOf(HABIT, MISSED_DAY), USER_MISSED, "server copy of the user's choice wins");
});

// ── linked checklists ────────────────────────────────────────────────────────

test("checklist run (REST): finishing a run on a day marked missed leaves the habit missed", async () => {
  await linkToChecklist(HABIT);
  await markMissed(HABIT, RUN_MISSED_DAY);
  await fx.insertRun(turso, {
    id: "run-skip",
    templateId: TEMPLATE,
    status: "in_progress",
    startedAt: runStart(RUN_MISSED_DAY),
  });
  await fx.insertRun(turso, {
    id: "run-open",
    templateId: TEMPLATE,
    status: "in_progress",
    startedAt: runStart(RUN_OPEN_DAY),
  });

  await checklistsService.completeRun(USER_ID, "run-skip", {});
  assert.deepEqual(await stateOf(HABIT, RUN_MISSED_DAY), USER_MISSED);

  await checklistsService.completeRun(USER_ID, "run-open", {});
  assert.deepEqual(await stateOf(HABIT, RUN_OPEN_DAY), AUTO_TICK, "control");
});

test("checklist run (sync): a completed run pushed for a day marked missed leaves the habit missed", async () => {
  await linkToChecklist(HABIT);
  await markMissed(HABIT, RUN_MISSED_DAY);
  const runPush = (id: string, day: string) => ({
    op: "create",
    type: "checklist_run",
    payload: {
      id,
      template_id: TEMPLATE,
      name: null,
      status: "completed",
      started_at: runStart(day),
      completed_at: `${day}T05:30:00.000Z`,
      created_at: `${day}T05:30:00.000Z`,
      updated_at: `${day}T05:30:00.000Z`,
    },
  });

  const results = await processPush(USER_ID, [
    runPush("run-sync-skip", RUN_MISSED_DAY),
    runPush("run-sync-open", RUN_OPEN_DAY),
  ] as never);

  assert.deepEqual(
    results.map((r) => r.status),
    ["applied", "applied"]
  );
  assert.deepEqual(await stateOf(HABIT, RUN_MISSED_DAY), USER_MISSED);
  assert.deepEqual(await stateOf(HABIT, RUN_OPEN_DAY), AUTO_TICK, "control");
});

test("checklist day mark (sync): marking a day done leaves a habit the user marked missed", async () => {
  await linkToChecklist(HABIT);
  await markMissed(HABIT, RUN_MISSED_DAY);
  const markPush = (id: string, day: string) => ({
    op: "create",
    type: "checklist_occurrence_mark",
    payload: {
      id,
      template_id: TEMPLATE,
      local_date: day,
      status: "done",
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
    },
  });

  const results = await processPush(USER_ID, [
    markPush("mark-skip", RUN_MISSED_DAY),
    markPush("mark-open", RUN_OPEN_DAY),
  ] as never);

  assert.deepEqual(
    results.map((r) => r.status),
    ["applied", "applied"]
  );
  assert.deepEqual(await stateOf(HABIT, RUN_MISSED_DAY), USER_MISSED);
  assert.deepEqual(await stateOf(HABIT, RUN_OPEN_DAY), AUTO_TICK, "control");
});

test("checklist run: a day the midnight job closed is still ticked, one the user set is not", async () => {
  await linkToChecklist(HABIT);
  await linkToChecklist(OTHER_HABIT);
  await habitsRepo.upsertLog(OTHER_HABIT, RUN_MISSED_DAY, false, null);
  await closeHabitDay(USER_ID, RUN_MISSED_DAY, `${RUN_OPEN_DAY}T00:00:00.000Z`);
  assert.deepEqual(await stateOf(HABIT, RUN_MISSED_DAY), AUTO_ZERO);

  // Started before midnight, finished after it: the run belongs to the day it started.
  await autoLogHabitsForCompletedRun(USER_ID, {
    template_id: TEMPLATE,
    status: "completed",
    started_at: runStart(RUN_MISSED_DAY),
    completed_at: `${RUN_OPEN_DAY}T00:30:00.000Z`,
    updated_at: `${RUN_OPEN_DAY}T00:30:00.000Z`,
    deleted_at: null,
  });

  assert.deepEqual(await stateOf(HABIT, RUN_MISSED_DAY), AUTO_TICK);
  assert.deepEqual(await stateOf(OTHER_HABIT, RUN_MISSED_DAY), USER_MISSED);
});

import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";

const { turso } = await import("../src/config/db.js");
const { createNotificationTables } = await import("./helpers/migrations.js");
const todosService = await import("../src/services/todos.js");
const { processPush } = await import("../src/services/sync.service.js");
const { getChangesSince } = await import("../src/repositories/sync.repo.js");
const { createDailyTodoLogTables, clearDailyTodoLogTables } = await import(
  "./helpers/daily-todo-log-tables.js"
);

const USER_ID = "55555555-5555-7555-8555-555555555555";
const OTHER_USER_ID = "66666666-6666-7666-8666-666666666666";
const OLD = "2026-01-01T00:00:00.000Z";
const NEW = "2026-01-02T00:00:00.000Z";

const insertUser = async (id: string): Promise<void> => {
  await turso.execute({
    sql: `INSERT INTO users
          (id, email, password_hash, timezone, is_admin, created_at, updated_at)
          VALUES (?, ?, 'test-hash', 'Asia/Ho_Chi_Minh', 0, ?, ?)`,
    args: [id, `${id}@test.local`, OLD, OLD],
  });
};

const insertHabit = async (
  id: string,
  userId = USER_ID
): Promise<void> => {
  await turso.execute({
    sql: `INSERT INTO habits
          (id, user_id, title, description, icon, color, frequency_type,
           target_per_period, active_weekdays, start_date, end_date,
           current_streak, longest_streak, is_archived, created_at, updated_at)
          VALUES (?, ?, ?, NULL, NULL, '#4CAF50', 'daily', 1, NULL,
                  '2026-01-01', NULL, 0, 0, 0, ?, ?)`,
    args: [id, userId, id, OLD, OLD],
  });
};

const insertTodo = async (
  id: string,
  overrides: Partial<Record<string, string | number | null>> = {}
): Promise<void> => {
  const row = {
    id,
    user_id: USER_ID,
    parent_id: null,
    title: id,
    description: null,
    status: "open",
    position: 0,
    is_frog: 0,
    frog_date: null,
    is_important: null,
    is_urgent: null,
    estimated_minutes: null,
    actual_minutes: null,
    start_at: null,
    due_at: null,
    scheduled_date: "2099-01-01",
    time: null,
    trigger_after_todo_id: null,
    habit_id: null,
    completed_at: null,
    recurrence_type: null,
    recurrence_interval: null,
    recurrence_days_of_week: null,
    recurrence_end_date: null,
    recurrence_template_id: null,
    created_at: OLD,
    updated_at: OLD,
    deleted_at: null,
    ...overrides,
  };
  const columns = Object.keys(row);
  await turso.execute({
    sql: `INSERT INTO todos (${columns.join(", ")})
          VALUES (${columns.map(() => "?").join(", ")})`,
    args: columns.map((column) => row[column as keyof typeof row]),
  });
};

const getHabitLog = async (
  habitId: string,
  logDate: string
): Promise<Record<string, unknown> | null> => {
  const res = await turso.execute({
    sql: `SELECT id, habit_id, log_date, completed, note, created_at, updated_at, deleted_at
          FROM habit_logs
          WHERE habit_id = ? AND log_date = ? AND deleted_at IS NULL`,
    args: [habitId, logDate],
  });
  return (res.rows[0] as unknown as Record<string, unknown> | undefined) ?? null;
};

before(async () => {
  await createNotificationTables(turso);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
      settings TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#888888',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS habits (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      color TEXT NOT NULL DEFAULT '#4CAF50',
      frequency_type TEXT NOT NULL DEFAULT 'daily',
      target_per_period INTEGER NOT NULL DEFAULT 1,
      active_weekdays TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      current_streak INTEGER NOT NULL DEFAULT 0,
      longest_streak INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS habit_logs (
      id TEXT PRIMARY KEY,
      habit_id TEXT NOT NULL,
      log_date TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  await turso.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_habit_logs_unique
      ON habit_logs(habit_id, log_date)
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      parent_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      position INTEGER NOT NULL DEFAULT 0,
      is_frog INTEGER NOT NULL DEFAULT 0,
      frog_date TEXT,
      is_important INTEGER,
      is_urgent INTEGER,
      estimated_minutes INTEGER,
      actual_minutes INTEGER,
      start_at TEXT,
      due_at TEXT,
      scheduled_date TEXT,
      time TEXT,
      trigger_after_todo_id TEXT,
      habit_id TEXT,
      completed_at TEXT,
      recurrence_type TEXT,
      recurrence_interval INTEGER,
      recurrence_days_of_week TEXT,
      recurrence_end_date TEXT,
      recurrence_template_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS todo_tags (
      todo_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      PRIMARY KEY (todo_id, tag_id)
    )
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'free',
      body TEXT,
      cornell_cue TEXT,
      cornell_summary TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  await turso.execute("CREATE TABLE IF NOT EXISTS note_tags (note_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (note_id, tag_id))");
  await turso.execute("CREATE TABLE IF NOT EXISTS note_links (source_note_id TEXT NOT NULL, target_note_id TEXT NOT NULL, label TEXT)");
  await turso.execute("CREATE TABLE IF NOT EXISTS note_todo_links (note_id TEXT NOT NULL, todo_id TEXT NOT NULL)");
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS checklist_categories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      icon TEXT,
      color TEXT NOT NULL DEFAULT '#888888',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS checklist_templates (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      category TEXT,
      category_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      times_used INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS checklist_template_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS checklist_template_items (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      is_required INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS checklist_runs (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS checklist_run_items (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      template_item_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      completed_at TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  await createDailyTodoLogTables(turso);
});

beforeEach(async () => {
  await clearDailyTodoLogTables(turso);
  for (const table of [
    "checklist_run_items",
    "checklist_runs",
    "checklist_template_items",
    "checklist_template_orders",
    "checklist_templates",
    "checklist_categories",
    "habit_logs",
    "habits",
    "note_todo_links",
    "note_links",
    "note_tags",
    "notes",
    "todo_tags",
    "todos",
    "tags",
    "users",
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await insertUser(USER_ID);
  await insertUser(OTHER_USER_ID);
});

test("todo can be linked, relinked, cleared, and filtered by habit_id", async () => {
  await insertHabit("habit-a");
  await insertHabit("habit-b");
  await insertHabit("habit-other", OTHER_USER_ID);

  const created = await todosService.createTodo(USER_ID, {
    title: "Linked todo",
    scheduled_date: "2099-01-01",
    habit_id: "habit-a",
  });
  assert.equal(created.todo.habit_id, "habit-a");

  const relinked = await todosService.updateTodo(USER_ID, created.todo.id, {
    habit_id: "habit-b",
  });
  assert.equal(relinked.habit_id, "habit-b");

  const listed = await todosService.listTodos(USER_ID, {
    limit: 20,
    habit_id: "habit-b",
  });
  assert.equal(listed.rows.length, 1);
  assert.equal(listed.rows[0].id, created.todo.id);

  const cleared = await todosService.updateTodo(USER_ID, created.todo.id, {
    habit_id: null,
  });
  assert.equal(cleared.habit_id, null);

  await assert.rejects(
    () => todosService.updateTodo(USER_ID, created.todo.id, { habit_id: "habit-other" }),
    { code: "invalid_habit" }
  );
});

test("complete linked todos auto-logs habit only when all day todos are done on time", async () => {
  await insertHabit("habit-auto");
  await insertTodo("todo-a", { habit_id: "habit-auto" });
  await insertTodo("todo-b", { habit_id: "habit-auto" });

  await todosService.completeTodo(USER_ID, "todo-a", {});
  let log = await getHabitLog("habit-auto", "2099-01-01");
  assert.equal(log?.completed, 0);

  await todosService.completeTodo(USER_ID, "todo-b", {});
  log = await getHabitLog("habit-auto", "2099-01-01");
  assert.equal(log?.completed, 1);
});

test("late completion writes incomplete habit log and preserves manual note", async () => {
  await insertHabit("habit-late");
  await insertTodo("todo-late", {
    habit_id: "habit-late",
    scheduled_date: "2020-01-01",
  });
  await turso.execute({
    sql: `INSERT INTO habit_logs
          (id, habit_id, log_date, completed, note, created_at, updated_at)
          VALUES ('manual-log', 'habit-late', '2020-01-01', 1, 'manual note', ?, ?)`,
    args: [OLD, OLD],
  });

  await todosService.completeTodo(USER_ID, "todo-late", {});

  const log = await getHabitLog("habit-late", "2020-01-01");
  assert.equal(log?.completed, 0);
  assert.equal(log?.note, "manual note");
});

test("uncomplete and habit link changes do not mutate existing habit logs", async () => {
  await insertHabit("habit-stable");
  await insertHabit("habit-new");
  await insertTodo("todo-stable", { habit_id: "habit-stable" });

  await todosService.completeTodo(USER_ID, "todo-stable", {});
  let log = await getHabitLog("habit-stable", "2099-01-01");
  assert.equal(log?.completed, 1);

  await todosService.uncompleteTodo(USER_ID, "todo-stable");
  await todosService.updateTodo(USER_ID, "todo-stable", { habit_id: "habit-new" });
  await todosService.updateTodo(USER_ID, "todo-stable", { habit_id: null });

  log = await getHabitLog("habit-stable", "2099-01-01");
  assert.equal(log?.completed, 1);
  assert.equal(await getHabitLog("habit-new", "2099-01-01"), null);
});

test("todos without scheduled_date do not auto-log habits", async () => {
  await insertHabit("habit-no-date");
  await insertTodo("todo-no-date", {
    habit_id: "habit-no-date",
    scheduled_date: null,
  });

  await todosService.completeTodo(USER_ID, "todo-no-date", {});

  assert.equal(await getHabitLog("habit-no-date", "2099-01-01"), null);
});

test("next recurring todo copies habit_id", async () => {
  await insertHabit("habit-recurring");
  await insertTodo("todo-recurring-linked", {
    habit_id: "habit-recurring",
    recurrence_type: "daily",
    recurrence_interval: 2,
    recurrence_end_date: "2099-01-10",
  });

  const result = await todosService.completeTodo(USER_ID, "todo-recurring-linked", {});

  assert.equal(result.next_recurring_todo?.habit_id, "habit-recurring");
  assert.equal(result.next_recurring_todo?.scheduled_date, "2099-01-03");
  assert.equal(result.next_recurring_todo?.time, null);
});

test("sync changes and push support habit_id and auto habit logging", async () => {
  await insertHabit("habit-sync");
  await insertTodo("todo-sync", { habit_id: "habit-sync" });

  const initial = await getChangesSince(USER_ID, null);
  const syncedTodo = initial.todos.find((todo) => todo.id === "todo-sync");
  assert.equal(syncedTodo?.habit_id, "habit-sync");

  const results = await processPush(USER_ID, [
    {
      op: "update",
      type: "todo",
      payload: {
        id: "todo-sync",
        updated_at: NEW,
        status: "done",
        completed_at: "2026-01-02T00:00:00.000Z",
      },
    },
  ]);
  assert.equal(results[0].status, "applied");

  const log = await getHabitLog("habit-sync", "2099-01-01");
  assert.equal(log?.completed, 1);
});

test("sync push late completion logs incomplete and invalid habit_id is rejected", async () => {
  await insertHabit("habit-sync-late");
  await insertHabit("habit-other", OTHER_USER_ID);
  await insertTodo("todo-sync-late", {
    habit_id: "habit-sync-late",
    scheduled_date: "2020-01-01",
  });

  const invalid = await processPush(USER_ID, [
    {
      op: "update",
      type: "todo",
      payload: {
        id: "todo-sync-late",
        updated_at: NEW,
        habit_id: "habit-other",
      },
    },
  ]);
  assert.equal(invalid[0].status, "error");
  assert.equal(invalid[0].error, "invalid_habit");

  const late = await processPush(USER_ID, [
    {
      op: "update",
      type: "todo",
      payload: {
        id: "todo-sync-late",
        updated_at: "2026-01-03T00:00:00.000Z",
        status: "done",
        completed_at: "2026-01-03T00:00:00.000Z",
      },
    },
  ]);
  assert.equal(late[0].status, "applied");

  const log = await getHabitLog("habit-sync-late", "2020-01-01");
  assert.equal(log?.completed, 0);
});

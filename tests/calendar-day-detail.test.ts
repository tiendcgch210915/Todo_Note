import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";

const { turso } = await import("../src/config/db.js");
const dashboard = await import("../src/services/dashboard.js");
const { createDailyTodoLogTables, clearDailyTodoLogTables } = await import(
  "./helpers/daily-todo-log-tables.js"
);
const { CalendarDayDetailQuerySchema } = await import(
  "../src/schemas/api/dashboard.js"
);

const USER_ID = "user-calendar-detail";
const NOW = "2026-06-20T00:00:00.000Z";

type TodoOptions = {
  title?: string;
  date?: string;
  time?: string | null;
  parentId?: string | null;
  status?: "open" | "in_progress" | "done" | "archived";
  position?: number;
  isFrog?: number;
  frogDate?: string | null;
  isImportant?: number | null;
  isUrgent?: number | null;
  estimatedMinutes?: number | null;
  completedAt?: string | null;
  deletedAt?: string | null;
  createdAt?: string;
};

const insertTodo = async (
  id: string,
  options: TodoOptions = {}
): Promise<void> => {
  const status = options.status ?? "open";
  const completedAt =
    options.completedAt !== undefined
      ? options.completedAt
      : status === "done"
        ? NOW
        : null;
  const createdAt = options.createdAt ?? NOW;
  await turso.execute({
    sql: `INSERT INTO todos
          (id, user_id, parent_id, title, description, status, position,
           is_frog, frog_date, is_important, is_urgent,
           estimated_minutes, actual_minutes, start_at, due_at,
           scheduled_date, time, trigger_after_todo_id, habit_id, completed_at,
           recurrence_type, recurrence_interval, recurrence_days_of_week,
           recurrence_end_date, recurrence_template_id,
           created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, NULL, ?, ?,
                  ?, ?, ?, ?,
                  ?, NULL, NULL, NULL,
                  ?, ?, NULL, NULL, ?,
                  NULL, 1, NULL,
                  NULL, NULL,
                  ?, ?, ?)`,
    args: [
      id,
      USER_ID,
      options.parentId ?? null,
      options.title ?? id,
      status,
      options.position ?? 0,
      options.isFrog ?? 0,
      options.frogDate ?? null,
      options.isImportant ?? null,
      options.isUrgent ?? null,
      options.estimatedMinutes ?? null,
      options.date ?? "2026-06-26",
      options.time ?? null,
      completedAt,
      createdAt,
      createdAt,
      options.deletedAt ?? null,
    ],
  });
};

before(async () => {
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
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
  await createDailyTodoLogTables(turso);
});

beforeEach(async () => {
  await clearDailyTodoLogTables(turso);
  await turso.execute("DELETE FROM todo_tags");
  await turso.execute("DELETE FROM tags");
  await turso.execute("DELETE FROM todos");
  await turso.execute("DELETE FROM users");
  await turso.execute({
    sql: `INSERT INTO users
          (id, email, password_hash, timezone, is_admin, created_at, updated_at)
          VALUES (?, ?, ?, 'Asia/Ho_Chi_Minh', 0, ?, ?)`,
    args: [USER_ID, "calendar@example.com", "hash", NOW, NOW],
  });
});

test("calendar day detail groups top-level todos by time and builds week strip", async () => {
  await insertTodo("todo-930", {
    title: "Morning work",
    time: "09:30",
    status: "done",
    position: 2,
    isImportant: 1,
  });
  await insertTodo("todo-1800", {
    title: "Evening work",
    time: "18:00",
    position: 1,
    isFrog: 1,
    frogDate: "2026-06-26",
    estimatedMinutes: 45,
  });
  await insertTodo("todo-untimed", { title: "Inbox cleanup", position: 0 });
  await insertTodo("todo-child", {
    parentId: "todo-1800",
    title: "Subtask should stay out of timeline",
    time: null,
  });
  await insertTodo("todo-archived", {
    title: "Archived",
    status: "archived",
    time: "08:00",
  });
  await insertTodo("todo-deleted", {
    title: "Deleted",
    time: "10:00",
    deletedAt: NOW,
  });
  await insertTodo("todo-next-day", {
    date: "2026-06-27",
    title: "Next day",
    time: "07:00",
  });
  await turso.execute({
    sql: `INSERT INTO tags
          (id, user_id, name, color, created_at, updated_at)
          VALUES ('tag-work', ?, 'Work', '#3366ff', ?, ?)`,
    args: [USER_ID, NOW, NOW],
  });
  await turso.execute({
    sql: "INSERT INTO todo_tags (todo_id, tag_id) VALUES (?, ?)",
    args: ["todo-1800", "tag-work"],
  });

  const detail = await dashboard.getCalendarDayDetail(
    USER_ID,
    { date: "2026-06-26" },
    new Date("2026-06-26T09:44:00.000Z")
  );

  assert.equal(detail.date, "2026-06-26");
  assert.equal(detail.timezone, "Asia/Ho_Chi_Minh");
  assert.equal(detail.week.from, "2026-06-22");
  assert.equal(detail.week.to, "2026-06-28");
  assert.equal(detail.week.days.length, 7);

  const selected = detail.week.days.find((day) => day.date === "2026-06-26");
  assert.deepEqual(selected, {
    date: "2026-06-26",
    iso_weekday: 5,
    weekday_label: "T6",
    day_of_month: 26,
    month: 6,
    is_selected: true,
    is_today: true,
    total_todos: 3,
    timed_todos: 2,
    done_todos: 1,
  });

  assert.deepEqual(
    detail.timed_todos.map((todo) => [
      todo.id,
      todo.time,
      todo.minutes_since_midnight,
    ]),
    [
      ["todo-930", "09:30", 570],
      ["todo-1800", "18:00", 1080],
    ]
  );
  assert.equal(detail.timed_todos[1].has_subtasks, true);
  assert.deepEqual(detail.timed_todos[1].tag_ids, ["tag-work"]);
  assert.deepEqual(
    detail.untimed_todos.map((todo) => todo.id),
    ["todo-untimed"]
  );
  assert.deepEqual(detail.totals, {
    total_todos: 3,
    timed_todos: 2,
    untimed_todos: 1,
    done_todos: 1,
  });
});

test("calendar day detail exposes current-time line metadata for the selected day", async () => {
  const detail = await dashboard.getCalendarDayDetail(
    USER_ID,
    { date: "2026-06-26" },
    new Date("2026-06-26T09:44:00.000Z")
  );

  assert.equal(detail.current_time_indicator.visible, true);
  assert.equal(detail.current_time_indicator.current_date, "2026-06-26");
  assert.equal(detail.current_time_indicator.current_time, "16:44");
  assert.equal(detail.current_time_indicator.minutes_since_midnight, 1004);
  assert.equal(detail.current_time_indicator.line_minutes_since_midnight, 1004);
  assert.equal(detail.current_time_indicator.hidden_hour_mark_minute, 1020);
  assert.equal(detail.current_time_indicator.hidden_hour_label, "17:00");
  assert.equal(detail.timeline.hour_marks.length, 25);
  assert.deepEqual(detail.timeline.hour_marks.at(-1), {
    minute: 1440,
    label: "00:00",
  });
});

test("calendar day detail hides current-time line on non-current selected day", async () => {
  const detail = await dashboard.getCalendarDayDetail(
    USER_ID,
    { date: "2026-06-25" },
    new Date("2026-06-26T09:44:00.000Z")
  );

  assert.equal(detail.current_time_indicator.visible, false);
  assert.equal(detail.current_time_indicator.line_minutes_since_midnight, null);
  assert.equal(detail.current_time_indicator.hidden_hour_mark_minute, null);
  assert.equal(detail.current_time_indicator.hidden_hour_label, null);
});

test("calendar day detail query requires ISO date", () => {
  assert.equal(
    CalendarDayDetailQuerySchema.safeParse({ date: "2026-06-26" }).success,
    true
  );
  assert.equal(
    CalendarDayDetailQuerySchema.safeParse({ date: "2026-6-26" }).success,
    false
  );
});

test("overlapping calendar reads freeze every day once, including empty days and multi-chunk logs", async () => {
  const date = "2026-06-24";
  const now = new Date("2026-06-29T12:00:00Z");
  for (let i = 0; i < 85; i++) {
    await insertTodo(`past-${i}`, { date, time: i % 2 ? null : "08:00" });
  }
  const [overview, detail] = await Promise.all([
    dashboard.getCalendarOverview(USER_ID, { from: "2026-06-22", to: "2026-06-28" }, now),
    dashboard.getCalendarDayDetail(USER_ID, { date }, now),
  ]);
  assert.equal(overview.days[date].total_todos, 85);
  assert.equal(detail.timed_todos.length, 43);
  assert.equal(detail.untimed_todos.length, 42);
  assert.equal(detail.week.days.find((d) => d.date === date)?.timed_todos, 43);

  await insertTodo("added-after-close", { date: "2026-06-22", time: "12:00" });
  await turso.execute("UPDATE todos SET time = NULL");
  const reread = await dashboard.getCalendarDayDetail(USER_ID, { date }, now);
  assert.deepEqual(reread, detail);
  assert.equal(reread.week.days[0].total_todos, 0);
});

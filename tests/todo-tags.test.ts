import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";

const { turso } = await import("../src/config/db.js");
const tagsService = await import("../src/services/tags.js");
const todosService = await import("../src/services/todos.js");
const dashboard = await import("../src/services/dashboard.js");
const { processPush } = await import("../src/services/sync.service.js");
const { getChangesSince } = await import("../src/repositories/sync.repo.js");
const { newId } = await import("../src/utils/id.js");
const { createDailyTodoLogTables, clearDailyTodoLogTables } = await import(
  "./helpers/daily-todo-log-tables.js"
);

const USER_ID = "33333333-3333-7333-8333-333333333333";
const OTHER_USER_ID = "44444444-4444-7444-8444-444444444444";
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
    scheduled_date: "2026-01-10",
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

const todoTagIds = async (todoId: string): Promise<string[]> => {
  const res = await turso.execute({
    sql: "SELECT tag_id FROM todo_tags WHERE todo_id = ? ORDER BY tag_id ASC",
    args: [todoId],
  });
  return (res.rows as unknown as { tag_id: string }[]).map((row) => row.tag_id);
};

const getTodoRow = async (
  todoId: string
): Promise<Record<string, unknown>> => {
  const res = await turso.execute({
    sql: "SELECT * FROM todos WHERE id = ?",
    args: [todoId],
  });
  assert.equal(res.rows.length, 1);
  return res.rows[0] as unknown as Record<string, unknown>;
};

before(async () => {
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

test("tag CRUD normalizes names and keeps unused tags in list", async () => {
  const created = await tagsService.createTag(USER_ID, {
    name: "  Work   Focus ",
    color: "#3366ff",
  });
  const duplicate = await tagsService.createTag(USER_ID, {
    name: "work focus",
  });

  assert.equal(created.tag.id, duplicate.tag.id);
  assert.equal(created.tag.name, "Work Focus");

  const listed = await tagsService.listTags(USER_ID, { scope: "all", limit: 20 });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].usage_count, 0);

  const updated = await tagsService.updateTag(USER_ID, created.tag.id, {
    name: "Deep Work",
    color: "#ff6633",
  });
  assert.equal(updated.tag.name, "Deep Work");
  assert.equal(updated.tag.color, "#ff6633");

  await tagsService.deleteTag(USER_ID, created.tag.id);
  const afterDelete = await tagsService.listTags(USER_ID, { scope: "all", limit: 20 });
  assert.equal(afterDelete.items.length, 0);
});

test("todo create, list, day list, detail, replace, and filters include tags", async () => {
  const existingTag = await tagsService.createTag(USER_ID, { name: "Code" });
  const created = await todosService.createTodo(USER_ID, {
    title: "Tagged todo",
    scheduled_date: "2026-01-10",
    tag_ids: [existingTag.tag.id],
    tags: ["Health"],
  });

  assert.deepEqual(
    created.tags.map((tag) => tag.name).sort(),
    ["Code", "Health"]
  );
  assert.equal(created.tag_ids.length, 2);

  const listed = await todosService.listTodos(USER_ID, {
    limit: 20,
    tag_id: existingTag.tag.id,
  });
  assert.equal(listed.rows.length, 1);
  assert.equal(listed.rows[0].tag_ids.length, 2);
  assert.equal(listed.rows[0].tags.some((tag) => tag.name === "Code"), true);

  const legacyFiltered = await todosService.listTodos(USER_ID, {
    limit: 20,
    tag: "health",
  });
  assert.equal(legacyFiltered.rows.length, 1);

  const dayRows = await todosService.listDayTopLevel(USER_ID, "2026-01-10");
  assert.equal(dayRows.length, 1);
  assert.deepEqual(
    dayRows[0].tags.map((tag) => tag.name).sort(),
    ["Code", "Health"]
  );

  const detail = await todosService.getTodoDetail(USER_ID, created.todo.id);
  assert.deepEqual(detail.tag_ids.sort(), created.tag_ids.sort());

  const replaced = await todosService.replaceTags(USER_ID, created.todo.id, {
    tags: ["Work"],
  });
  assert.deepEqual(replaced.tags.map((tag) => tag.name), ["Work"]);

  const cleared = await todosService.replaceTags(USER_ID, created.todo.id, {
    tag_ids: [],
    tags: [],
  });
  assert.deepEqual(cleared.tag_ids, []);
});

test("PATCH todo replaces tags only when tag fields are present", async () => {
  const tag = await tagsService.createTag(USER_ID, { name: "Initial" });
  const created = await todosService.createTodo(USER_ID, {
    title: "Patch tags",
    tag_ids: [tag.tag.id],
  });

  const titleOnly = await todosService.updateTodo(USER_ID, created.todo.id, {
    title: "Patch tags renamed",
  });
  assert.deepEqual(titleOnly.tag_ids, [tag.tag.id]);

  const cleared = await todosService.updateTodo(USER_ID, created.todo.id, {
    tags: [],
  });
  assert.deepEqual(cleared.tag_ids, []);
});

test("dashboard eisenhower returns tags and tag_ids on todo items", async () => {
  const tag = await tagsService.createTag(USER_ID, { name: "Dashboard" });
  const todoId = newId();
  await insertTodo(todoId, {
    title: "Dashboard todo",
    scheduled_date: "2099-01-10",
    is_important: 1,
    is_urgent: 1,
  });
  await todosService.replaceTags(USER_ID, todoId, { tag_ids: [tag.tag.id] });

  const result = await dashboard.getEisenhower(USER_ID, { date: "2099-01-10" });

  assert.equal(result.by_quadrant.q1.length, 1);
  assert.deepEqual(result.by_quadrant.q1[0].tag_ids, [tag.tag.id]);
  assert.equal(result.by_quadrant.q1[0].tags[0].name, "Dashboard");
});

test("sync push tag_ids attaches and clears todo tags", async () => {
  const tag = await tagsService.createTag(USER_ID, { name: "Synced" });
  const todoId = newId();
  await insertTodo(todoId);

  const attached = await processPush(USER_ID, [
    {
      op: "update",
      type: "todo",
      payload: {
        id: todoId,
        updated_at: NEW,
        tag_ids: [tag.tag.id],
      },
    },
  ]);
  assert.equal(attached[0].status, "applied");
  assert.deepEqual(await todoTagIds(todoId), [tag.tag.id]);

  const cleared = await processPush(USER_ID, [
    {
      op: "update",
      type: "todo",
      payload: {
        id: todoId,
        updated_at: "2026-01-03T00:00:00.000Z",
        tag_ids: [],
      },
    },
  ]);
  assert.equal(cleared[0].status, "applied");
  assert.deepEqual(await todoTagIds(todoId), []);
});

test("sync push frog is unique per day and forces Q1 classification", async () => {
  const firstId = newId();
  const secondId = newId();
  await insertTodo(firstId, {
    scheduled_date: "2099-01-10",
    is_important: 0,
    is_urgent: 0,
  });
  await insertTodo(secondId, {
    scheduled_date: "2099-01-10",
    is_important: 0,
    is_urgent: 0,
  });

  let pushed = await processPush(USER_ID, [
    {
      op: "update",
      type: "todo",
      payload: {
        id: firstId,
        updated_at: NEW,
        is_frog: true,
        frog_date: "2099-01-10",
      },
    },
  ]);
  assert.equal(pushed[0].status, "applied");

  pushed = await processPush(USER_ID, [
    {
      op: "update",
      type: "todo",
      payload: {
        id: secondId,
        updated_at: "2026-01-03T00:00:00.000Z",
        is_frog: true,
        frog_date: "2099-01-10",
      },
    },
  ]);
  assert.equal(pushed[0].status, "applied");

  const oldFrog = await getTodoRow(firstId);
  const newFrog = await getTodoRow(secondId);
  assert.equal(Number(oldFrog.is_frog), 0);
  assert.equal(oldFrog.frog_date, null);
  assert.equal(Number(newFrog.is_frog), 1);
  assert.equal(newFrog.frog_date, "2099-01-10");
  assert.equal(Number(newFrog.is_important), 1);
  assert.equal(Number(newFrog.is_urgent), 1);
});

test("sync push and changes preserve todo time", async () => {
  const todoId = newId();
  await insertTodo(todoId);

  const pushed = await processPush(USER_ID, [
    {
      op: "update",
      type: "todo",
      payload: {
        id: todoId,
        updated_at: NEW,
        time: "08:30",
      },
    },
  ]);
  assert.equal(pushed[0].status, "applied");

  const changes = await getChangesSince(USER_ID, OLD);
  const changedTodo = changes.todos.find((todo) => todo.id === todoId);
  assert.ok(changedTodo);
  assert.equal(changedTodo.time, "08:30");
});

test("sync push rejects invalid todo time", async () => {
  const todoId = newId();
  await insertTodo(todoId);

  const invalidFormat = await processPush(USER_ID, [
    {
      op: "update",
      type: "todo",
      payload: {
        id: todoId,
        updated_at: NEW,
        time: "8:30",
      },
    },
  ]);
  assert.equal(invalidFormat[0].status, "error");
  assert.equal(invalidFormat[0].error, "bad_input");

  const missingDate = await processPush(USER_ID, [
    {
      op: "create",
      type: "todo",
      payload: {
        id: newId(),
        title: "No date",
        status: "open",
        position: 0,
        time: "08:30",
        created_at: NEW,
        updated_at: NEW,
      },
    },
  ]);
  assert.equal(missingDate[0].status, "error");
  assert.equal(missingDate[0].error, "bad_input");

  const subtaskTime = await processPush(USER_ID, [
    {
      op: "create",
      type: "todo",
      payload: {
        id: newId(),
        parent_id: todoId,
        title: "Subtask",
        status: "open",
        position: 0,
        scheduled_date: "2026-01-10",
        time: "08:30",
        created_at: NEW,
        updated_at: NEW,
      },
    },
  ]);
  assert.equal(subtaskTime[0].status, "error");
  assert.equal(subtaskTime[0].error, "bad_input");
});

test("REST-style replace bumps todo so sync changes include new tag_ids", async () => {
  const tag = await tagsService.createTag(USER_ID, { name: "Delta" });
  const todoId = newId();
  await insertTodo(todoId);

  await todosService.replaceTags(USER_ID, todoId, { tag_ids: [tag.tag.id] });
  const changes = await getChangesSince(USER_ID, OLD);
  const changedTodo = changes.todos.find((todo) => todo.id === todoId);

  assert.ok(changedTodo);
  assert.deepEqual(changedTodo.tag_ids, [tag.tag.id]);
});

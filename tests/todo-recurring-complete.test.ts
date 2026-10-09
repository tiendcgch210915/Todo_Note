import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";

const { turso } = await import("../src/config/db.js");
const todosService = await import("../src/services/todos.js");
const syncService = await import("../src/services/sync.service.js");
const todosRepo = await import("../src/repositories/todos.js");
const { createDailyTodoLogTables, clearDailyTodoLogTables } = await import(
  "./helpers/daily-todo-log-tables.js"
);

const USER_ID = "user-recurring-complete";
const OLD = "2026-06-01T00:00:00.000Z";

const TODO_COLUMNS = [
  "id",
  "user_id",
  "parent_id",
  "title",
  "description",
  "status",
  "position",
  "is_frog",
  "frog_date",
  "is_important",
  "is_urgent",
  "estimated_minutes",
  "actual_minutes",
  "start_at",
  "due_at",
  "scheduled_date",
  "time",
  "trigger_after_todo_id",
  "habit_id",
  "completed_at",
  "recurrence_type",
  "recurrence_interval",
  "recurrence_days_of_week",
  "recurrence_end_date",
  "recurrence_template_id",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;

type TodoColumn = (typeof TODO_COLUMNS)[number];
type TestTodoRow = Record<TodoColumn, string | number | null>;

const insertTodo = async (
  id: string,
  overrides: Partial<TestTodoRow> = {}
): Promise<void> => {
  const row: TestTodoRow = {
    id,
    user_id: USER_ID,
    parent_id: null,
    title: "Recurring todo",
    description: "Repeat this task",
    status: "open",
    position: 3,
    is_frog: 1,
    frog_date: "2026-06-15",
    is_important: 1,
    is_urgent: 0,
    estimated_minutes: 45,
    actual_minutes: null,
    start_at: "2026-06-15T08:00:00.000Z",
    due_at: "2026-06-15T09:00:00.000Z",
    scheduled_date: "2026-06-15",
    time: "08:30",
    trigger_after_todo_id: null,
    habit_id: null,
    completed_at: null,
    recurrence_type: "daily",
    recurrence_interval: 2,
    recurrence_days_of_week: null,
    recurrence_end_date: "2026-06-30",
    recurrence_template_id: null,
    created_at: OLD,
    updated_at: OLD,
    deleted_at: null,
    ...overrides,
  };

  await turso.execute({
    sql: `INSERT INTO todos (${TODO_COLUMNS.join(", ")})
          VALUES (${TODO_COLUMNS.map(() => "?").join(", ")})`,
    args: TODO_COLUMNS.map((column) => row[column]),
  });
};

const insertTag = async (id: string): Promise<void> => {
  await turso.execute({
    sql: `INSERT INTO tags (id, user_id, name, color, created_at, updated_at)
          VALUES (?, ?, ?, '#3366ff', ?, ?)`,
    args: [id, USER_ID, id, OLD, OLD],
  });
};

const attachTag = async (todoId: string, tagId: string): Promise<void> => {
  await turso.execute({
    sql: "INSERT INTO todo_tags (todo_id, tag_id) VALUES (?, ?)",
    args: [todoId, tagId],
  });
};

const getTodo = async (id: string): Promise<Record<string, unknown>> => {
  const res = await turso.execute({
    sql: "SELECT * FROM todos WHERE id = ?",
    args: [id],
  });
  assert.equal(res.rows.length, 1);
  return res.rows[0] as unknown as Record<string, unknown>;
};

const countTodos = async (): Promise<number> => {
  const res = await turso.execute("SELECT COUNT(*) AS count FROM todos");
  return Number((res.rows[0] as unknown as { count: number }).count);
};

const liveTodoIds = async (userId = USER_ID): Promise<string[]> => {
  const res = await turso.execute({
    sql: `SELECT id FROM todos
          WHERE user_id = ? AND deleted_at IS NULL
          ORDER BY scheduled_date ASC, id ASC`,
    args: [userId],
  });
  return (res.rows as unknown as { id: string }[]).map((row) => row.id);
};

const todoTagIds = async (todoId: string): Promise<string[]> => {
  const res = await turso.execute({
    sql: "SELECT tag_id FROM todo_tags WHERE todo_id = ? ORDER BY tag_id ASC",
    args: [todoId],
  });
  return (res.rows as unknown as { tag_id: string }[]).map((row) => row.tag_id);
};

const liveChildren = async (
  parentId: string
): Promise<Record<string, unknown>[]> => {
  const res = await turso.execute({
    sql: `SELECT * FROM todos
          WHERE parent_id = ? AND deleted_at IS NULL
          ORDER BY position ASC, id ASC`,
    args: [parentId],
  });
  return res.rows as unknown as Record<string, unknown>[];
};

before(async () => {
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
      color TEXT NOT NULL DEFAULT '#888888',
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
  // Read by getFullEntity when a sync conflict returns the canonical todo.
  await turso.execute(
    "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, deleted_at TEXT)"
  );
  await turso.execute(
    "CREATE TABLE IF NOT EXISTS note_todo_links (note_id TEXT NOT NULL, todo_id TEXT NOT NULL)"
  );
  await createDailyTodoLogTables(turso);
});

beforeEach(async () => {
  await clearDailyTodoLogTables(turso);
  await turso.execute("DELETE FROM todo_tags");
  await turso.execute("DELETE FROM tags");
  await turso.execute("DELETE FROM todos");
});

test("completing a daily recurring todo creates exactly one next occurrence", async () => {
  await insertTodo("todo-daily");
  await insertTag("tag-recurring");
  await attachTag("todo-daily", "tag-recurring");

  const result = await todosService.completeTodo(USER_ID, "todo-daily", {
    actual_minutes: 30,
  });

  assert.equal(result.todo.status, "done");
  assert.equal(result.todo.actual_minutes, 30);
  assert.ok(result.todo.completed_at);
  assert.ok(result.next_recurring_todo);

  const next = result.next_recurring_todo;
  assert.equal(next.title, "Recurring todo");
  assert.equal(next.description, "Repeat this task");
  assert.equal(next.status, "open");
  assert.equal(next.completed_at, null);
  assert.equal(next.actual_minutes, null);
  assert.equal(next.scheduled_date, "2026-06-17");
  assert.equal(next.time, "08:30");
  assert.equal(next.due_at, "2026-06-15T09:00:00.000Z");
  assert.equal(next.habit_id, null);
  assert.equal(next.recurrence_type, "daily");
  assert.equal(next.recurrence_interval, 2);
  assert.equal(next.recurrence_template_id, "todo-daily");
  assert.deepEqual(await todoTagIds(next.id), ["tag-recurring"]);
  assert.equal(await countTodos(), 2);

  const retry = await todosService.completeTodo(USER_ID, "todo-daily", {});
  assert.equal(retry.next_recurring_todo, null);
  assert.equal(await countTodos(), 2);
});

test("next recurring todo clones the complete subtask tree with tags and fresh state", async () => {
  await insertTodo("todo-parent");
  await insertTodo("todo-child-a", {
    parent_id: "todo-parent",
    title: "Prepare materials",
    status: "done",
    position: 0,
    actual_minutes: 20,
    scheduled_date: null,
    time: null,
    completed_at: "2026-06-15T07:30:00.000Z",
    recurrence_type: null,
    recurrence_interval: null,
    recurrence_end_date: null,
  });
  await insertTodo("todo-child-b", {
    parent_id: "todo-parent",
    title: "Execute task",
    position: 1,
    scheduled_date: null,
    time: null,
    trigger_after_todo_id: "todo-child-a",
    recurrence_type: null,
    recurrence_interval: null,
    recurrence_end_date: null,
  });
  await insertTodo("todo-grandchild", {
    parent_id: "todo-child-b",
    title: "Review output",
    position: 0,
    scheduled_date: null,
    time: null,
    recurrence_type: null,
    recurrence_interval: null,
    recurrence_end_date: null,
  });
  await insertTag("tag-child");
  await attachTag("todo-child-a", "tag-child");

  const result = await todosService.completeTodo(USER_ID, "todo-parent", {});
  const next = result.next_recurring_todo;
  assert.ok(next);

  const clonedChildren = await liveChildren(next.id);
  assert.equal(clonedChildren.length, 2);
  const clonedA = clonedChildren.find(
    (row) => row.title === "Prepare materials"
  );
  const clonedB = clonedChildren.find((row) => row.title === "Execute task");
  assert.ok(clonedA);
  assert.ok(clonedB);
  assert.notEqual(clonedA.id, "todo-child-a");
  assert.notEqual(clonedB.id, "todo-child-b");
  assert.equal(clonedA.status, "open");
  assert.equal(clonedA.actual_minutes, null);
  assert.equal(clonedA.completed_at, null);
  assert.equal(clonedA.scheduled_date, null);
  assert.equal(clonedA.time, null);
  assert.equal(clonedB.trigger_after_todo_id, clonedA.id);
  assert.deepEqual(await todoTagIds(String(clonedA.id)), ["tag-child"]);

  const clonedGrandchildren = await liveChildren(String(clonedB.id));
  assert.equal(clonedGrandchildren.length, 1);
  assert.equal(clonedGrandchildren[0].title, "Review output");
  assert.notEqual(clonedGrandchildren[0].id, "todo-grandchild");
});

test("existing next occurrence receives missing subtasks without duplicating them", async () => {
  await insertTodo("todo-template");
  await insertTodo("todo-child", {
    parent_id: "todo-template",
    title: "Child task",
    scheduled_date: null,
    time: null,
    recurrence_type: null,
    recurrence_interval: null,
    recurrence_end_date: null,
  });
  await insertTodo("todo-existing-next", {
    scheduled_date: "2026-06-17",
    recurrence_template_id: "todo-template",
  });

  const result = await todosService.completeTodo(USER_ID, "todo-template", {});

  assert.equal(result.next_recurring_todo?.id, "todo-existing-next");
  assert.equal((await liveChildren("todo-existing-next")).length, 1);

  await todosService.deleteTodo(USER_ID, "todo-template", "this");
  assert.equal((await liveChildren("todo-existing-next")).length, 1);
});

test("weekly recurrence uses the next configured weekday", async () => {
  await insertTodo("todo-weekly", {
    recurrence_type: "weekly",
    recurrence_interval: 1,
    recurrence_days_of_week: "1,3,5",
    recurrence_end_date: "2026-07-31",
  });

  const result = await todosService.completeTodo(USER_ID, "todo-weekly", {});

  assert.equal(result.next_recurring_todo?.scheduled_date, "2026-06-17");
  assert.equal(result.next_recurring_todo?.recurrence_type, "weekly");
  assert.equal(result.next_recurring_todo?.recurrence_days_of_week, "1,3,5");
});

test("recurrence_end_date prevents creating an occurrence beyond the end date", async () => {
  await insertTodo("todo-ended", {
    recurrence_end_date: "2026-06-16",
  });

  const result = await todosService.completeTodo(USER_ID, "todo-ended", {});

  assert.equal(result.next_recurring_todo, null);
  assert.equal(await countTodos(), 1);
});

test("existing next occurrence is reused instead of duplicated", async () => {
  await insertTodo("todo-template");
  await insertTodo("todo-existing-next", {
    scheduled_date: "2026-06-17",
    recurrence_template_id: "todo-template",
  });

  const result = await todosService.completeTodo(USER_ID, "todo-template", {});

  assert.equal(result.next_recurring_todo?.id, "todo-existing-next");
  assert.equal(await countTodos(), 2);

  const original = await getTodo("todo-template");
  assert.equal(original.status, "done");
});

test("delete scope this removes only the selected occurrence and keeps it as an exception", async () => {
  await insertTodo("todo-template");
  await insertTodo("todo-selected", {
    scheduled_date: "2026-06-17",
    recurrence_template_id: "todo-template",
  });
  await insertTodo("todo-selected-subtask", {
    parent_id: "todo-selected",
    scheduled_date: null,
    recurrence_type: null,
    recurrence_interval: null,
    recurrence_end_date: null,
    recurrence_template_id: null,
  });
  await insertTodo("todo-future", {
    scheduled_date: "2026-06-19",
    recurrence_template_id: "todo-template",
  });

  await todosService.deleteTodo(USER_ID, "todo-selected", "this");

  const futureChildren = await liveChildren("todo-future");
  assert.equal(futureChildren.length, 1);
  assert.equal(futureChildren[0].title, "Recurring todo");
  assert.ok((await getTodo("todo-selected")).deleted_at);
  assert.ok((await getTodo("todo-selected-subtask")).deleted_at);

  const completed = await todosService.completeTodo(
    USER_ID,
    "todo-template",
    {}
  );
  assert.equal(completed.next_recurring_todo?.id, "todo-future");
  assert.ok((await getTodo("todo-selected")).deleted_at);
  assert.equal(await countTodos(), 5);
});

test("delete scope this keeps the recurrence alive when no later occurrence exists", async () => {
  await insertTodo("todo-template");

  await todosService.deleteTodo(USER_ID, "todo-template", "this");

  const allRows = await turso.execute({
    sql: `SELECT id, scheduled_date, recurrence_template_id, deleted_at
          FROM todos ORDER BY scheduled_date ASC`,
    args: [],
  });
  assert.equal(allRows.rows.length, 2);
  const rows = allRows.rows as unknown as {
    scheduled_date: string;
    recurrence_template_id: string | null;
    deleted_at: string | null;
  }[];
  assert.ok(rows[0].deleted_at);
  const next = rows[1] as {
    scheduled_date: string;
    recurrence_template_id: string;
    deleted_at: string | null;
  };
  assert.equal(next.scheduled_date, "2026-06-17");
  assert.equal(next.recurrence_template_id, "todo-template");
  assert.equal(next.deleted_at, null);
});

test("delete scope future removes the selected date and every later occurrence including done todos", async () => {
  await insertTodo("todo-template", {
    recurrence_end_date: "2026-12-31",
  });
  await insertTodo("todo-selected-done", {
    status: "done",
    completed_at: "2026-06-17T08:00:00.000Z",
    scheduled_date: "2026-06-17",
    recurrence_template_id: "todo-template",
  });
  await insertTodo("todo-future", {
    scheduled_date: "2026-06-19",
    recurrence_template_id: "todo-template",
  });
  await insertTodo("todo-past", {
    status: "done",
    completed_at: "2026-06-13T08:00:00.000Z",
    scheduled_date: "2026-06-13",
    recurrence_template_id: "todo-template",
  });

  await todosService.deleteTodo(USER_ID, "todo-selected-done", "future");

  assert.deepEqual(await liveTodoIds(), ["todo-past", "todo-template"]);
  assert.ok((await getTodo("todo-selected-done")).deleted_at);
  assert.ok((await getTodo("todo-future")).deleted_at);
  assert.equal((await getTodo("todo-template")).recurrence_end_date, "2026-06-16");
  assert.equal((await getTodo("todo-past")).recurrence_end_date, "2026-06-16");

  const completed = await todosService.completeTodo(
    USER_ID,
    "todo-template",
    {}
  );
  assert.equal(completed.next_recurring_todo, null);
  assert.equal(await countTodos(), 4);
});

test("delete scope all removes the complete series but never another user's rows", async () => {
  await insertTodo("todo-template");
  await insertTodo("todo-past", {
    status: "done",
    completed_at: "2026-06-13T08:00:00.000Z",
    scheduled_date: "2026-06-13",
    recurrence_template_id: "todo-template",
  });
  await insertTodo("todo-selected", {
    scheduled_date: "2026-06-17",
    recurrence_template_id: "todo-template",
  });
  await insertTodo("todo-future", {
    scheduled_date: "2026-06-19",
    recurrence_template_id: "todo-template",
  });
  await insertTodo("foreign-row", {
    user_id: "another-user",
    scheduled_date: "2026-06-21",
    recurrence_template_id: "todo-template",
  });

  await todosService.deleteTodo(USER_ID, "todo-selected", "all");

  assert.deepEqual(await liveTodoIds(), []);
  assert.deepEqual(await liveTodoIds("another-user"), ["foreign-row"]);
});

test("sync push todo delete supports future scope", async () => {
  await insertTodo("todo-template");
  await insertTodo("todo-selected", {
    scheduled_date: "2026-06-17",
    recurrence_template_id: "todo-template",
  });
  await insertTodo("todo-future", {
    scheduled_date: "2026-06-19",
    recurrence_template_id: "todo-template",
  });

  const results = await syncService.processPush(USER_ID, [
    {
      op: "delete",
      type: "todo",
      payload: {
        id: "todo-selected",
        delete_scope: "future",
        deleted_at: "2026-06-20T00:00:00.000Z",
        updated_at: "2026-06-20T00:00:00.000Z",
      },
    },
  ]);

  assert.deepEqual(results, [{ id: "todo-selected", status: "applied" }]);
  assert.deepEqual(await liveTodoIds(), ["todo-template"]);
  assert.equal((await getTodo("todo-template")).recurrence_end_date, "2026-06-16");
});

const countRowsOn = async (date: string): Promise<number> => {
  const res = await turso.execute({
    sql: "SELECT COUNT(*) AS count FROM todos WHERE scheduled_date = ?",
    args: [date],
  });
  return Number((res.rows[0] as unknown as { count: number }).count);
};

test("uncompleting parks the generated occurrence and completing again revives that same row", async () => {
  await insertTodo("todo-a");

  const first = await todosService.completeTodo(USER_ID, "todo-a", {});
  const nextId = first.next_recurring_todo?.id;
  assert.ok(nextId);
  assert.equal(await countTodos(), 2);

  const reopened = await todosService.uncompleteTodo(USER_ID, "todo-a");
  assert.equal(reopened.status, "open");
  assert.equal((await getTodo(nextId)).status, "archived");
  assert.equal((await getTodo(nextId)).deleted_at, null);
  assert.equal(await countTodos(), 2);

  const second = await todosService.completeTodo(USER_ID, "todo-a", {});
  assert.equal(second.next_recurring_todo?.id, nextId);
  assert.equal(second.next_recurring_todo?.status, "open");
  assert.equal(second.next_recurring_todo?.scheduled_date, "2026-06-17");
  assert.equal(await countTodos(), 2);

  // The undo/redo cycle can repeat without ever adding a row.
  await todosService.uncompleteTodo(USER_ID, "todo-a");
  await todosService.completeTodo(USER_ID, "todo-a", {});
  assert.equal(await countTodos(), 2);
  assert.equal((await getTodo(nextId)).status, "open");
});

test("rescheduling the reopened todo moves the parked occurrence instead of adding another", async () => {
  await insertTodo("todo-a");
  const first = await todosService.completeTodo(USER_ID, "todo-a", {});
  const nextId = first.next_recurring_todo?.id;
  assert.ok(nextId);

  await todosService.uncompleteTodo(USER_ID, "todo-a");
  // Later than the parked occurrence's own date (2026-06-17).
  await todosService.updateTodo(USER_ID, "todo-a", {
    scheduled_date: "2026-06-20",
  });
  const second = await todosService.completeTodo(USER_ID, "todo-a", {});

  assert.equal(second.next_recurring_todo?.id, nextId);
  assert.equal(second.next_recurring_todo?.scheduled_date, "2026-06-22");
  assert.equal(second.next_recurring_todo?.status, "open");
  assert.equal(await countTodos(), 2);
  assert.equal(await countRowsOn("2026-06-17"), 0);
});

test("a next occurrence the user moved is not parked and is reused instead of duplicated", async () => {
  await insertTodo("todo-a");
  const first = await todosService.completeTodo(USER_ID, "todo-a", {});
  const nextId = first.next_recurring_todo?.id;
  assert.ok(nextId);
  await todosService.updateTodo(USER_ID, nextId, {
    scheduled_date: "2026-06-18",
  });

  await todosService.uncompleteTodo(USER_ID, "todo-a");
  assert.equal((await getTodo(nextId)).status, "open");

  const second = await todosService.completeTodo(USER_ID, "todo-a", {});
  assert.equal(second.next_recurring_todo?.id, nextId);
  assert.equal(second.next_recurring_todo?.scheduled_date, "2026-06-18");
  assert.equal(await countTodos(), 2);
});

test("undoing an old completion leaves later done and open occurrences alone", async () => {
  await insertTodo("todo-a");
  const first = await todosService.completeTodo(USER_ID, "todo-a", {});
  const secondId = first.next_recurring_todo?.id;
  assert.ok(secondId);
  const second = await todosService.completeTodo(USER_ID, secondId, {});
  const thirdId = second.next_recurring_todo?.id;
  assert.ok(thirdId);
  assert.equal(await countTodos(), 3);

  await todosService.uncompleteTodo(USER_ID, "todo-a");

  assert.equal((await getTodo(secondId)).status, "done");
  assert.equal((await getTodo(thirdId)).status, "open");
  assert.equal(await countTodos(), 3);
});

test("uncompleting a todo that is not recurring changes nothing else", async () => {
  await insertTodo("todo-plain", {
    recurrence_type: null,
    recurrence_interval: null,
    recurrence_end_date: null,
  });
  await insertTodo("todo-other");

  await todosService.completeTodo(USER_ID, "todo-plain", {});
  await todosService.uncompleteTodo(USER_ID, "todo-plain");

  assert.equal((await getTodo("todo-plain")).status, "open");
  assert.equal((await getTodo("todo-other")).status, "open");
  assert.equal(await countTodos(), 2);
});

test("concurrent completions in one series create the next occurrence once", async () => {
  await insertTodo("todo-t");
  await insertTodo("todo-x", { recurrence_template_id: "todo-t" });

  const [a, b] = await Promise.all([
    todosService.completeTodo(USER_ID, "todo-t", {}),
    todosService.completeTodo(USER_ID, "todo-x", {}),
  ]);

  assert.ok(a.next_recurring_todo);
  assert.equal(a.next_recurring_todo?.id, b.next_recurring_todo?.id);
  assert.equal(await countRowsOn("2026-06-17"), 1);
  assert.equal(await countTodos(), 3);
});

test("the repository insert never creates a second row for a taken series date", async () => {
  await insertTodo("todo-t");
  await insertTag("tag-keep");
  await attachTag("todo-t", "tag-keep");
  const source = await todosRepo.getTodoById("todo-t");
  assert.ok(source);

  const first = await todosRepo.createNextRecurringTodo(
    source,
    "2026-06-17",
    "todo-t"
  );
  const second = await todosRepo.createNextRecurringTodo(
    source,
    "2026-06-17",
    "todo-t"
  );

  assert.equal(second.id, first.id);
  assert.equal(await countTodos(), 2);
  assert.deepEqual(await todoTagIds(first.id), ["tag-keep"]);
  const tagRows = await turso.execute("SELECT COUNT(*) AS count FROM todo_tags");
  assert.equal(Number((tagRows.rows[0] as unknown as { count: number }).count), 2);
});

test("sync push cannot create a second occurrence for an occupied series date", async () => {
  await insertTodo("todo-template");
  await insertTodo("todo-existing-next", {
    scheduled_date: "2026-06-17",
    recurrence_template_id: "todo-template",
  });

  const occurrence = (id: string, scheduledDate: string) => ({
    op: "create" as const,
    type: "todo" as const,
    payload: {
      id,
      title: "Recurring todo",
      status: "open",
      position: 0,
      scheduled_date: scheduledDate,
      recurrence_type: "daily",
      recurrence_interval: 2,
      recurrence_template_id: "todo-template",
      created_at: "2026-06-18T00:00:00.000Z",
      updated_at: "2026-06-18T00:00:00.000Z",
    },
  });

  const [duplicate] = await syncService.processPush(USER_ID, [
    occurrence("todo-duplicate", "2026-06-17"),
  ]);
  assert.equal(duplicate.status, "conflict");
  assert.equal(duplicate.server_version?.id, "todo-existing-next");
  assert.equal(await countTodos(), 2);

  const [free] = await syncService.processPush(USER_ID, [
    occurrence("todo-free", "2026-06-19"),
  ]);
  assert.equal(free.status, "applied");
  assert.equal(await countTodos(), 3);

  // A retried create of the same row is idempotent, not a conflict with itself.
  const [retry] = await syncService.processPush(USER_ID, [
    occurrence("todo-free", "2026-06-19"),
  ]);
  assert.equal(retry.status, "applied");
  assert.equal(await countTodos(), 3);
});

test("sync push skips the cloned subtree of a refused duplicate occurrence", async () => {
  await insertTodo("todo-template");
  await insertTodo("todo-existing-next", {
    scheduled_date: "2026-06-17",
    recurrence_template_id: "todo-template",
  });

  const base = {
    title: "Recurring todo",
    status: "open",
    position: 0,
    created_at: "2026-06-18T00:00:00.000Z",
    updated_at: "2026-06-18T00:00:00.000Z",
  };
  const results = await syncService.processPush(USER_ID, [
    {
      op: "create",
      type: "todo",
      payload: {
        ...base,
        id: "dup-parent",
        scheduled_date: "2026-06-17",
        recurrence_type: "daily",
        recurrence_interval: 2,
        recurrence_template_id: "todo-template",
      },
    },
    {
      op: "create",
      type: "todo",
      payload: { ...base, id: "dup-child", parent_id: "dup-parent" },
    },
    {
      op: "create",
      type: "todo",
      payload: { ...base, id: "dup-grandchild", parent_id: "dup-child" },
    },
    {
      op: "create",
      type: "todo",
      payload: {
        ...base,
        id: "dup-sibling",
        parent_id: "dup-parent",
        trigger_after_todo_id: "dup-child",
      },
    },
    {
      // Unrelated to the refused occurrence: must still be applied.
      op: "create",
      type: "todo",
      payload: { ...base, id: "unrelated", scheduled_date: "2099-01-01" },
    },
  ]);

  assert.deepEqual(
    results.map((r) => [r.id, r.status]),
    [
      ["dup-parent", "conflict"],
      ["dup-child", "applied"],
      ["dup-grandchild", "applied"],
      ["dup-sibling", "applied"],
      ["unrelated", "applied"],
    ]
  );
  assert.equal(results[0].server_version?.id, "todo-existing-next");

  // Nothing of the refused subtree was written; the unrelated todo was.
  const written = await turso.execute(
    "SELECT id FROM todos WHERE id LIKE 'dup-%' OR id = 'unrelated' ORDER BY id"
  );
  assert.deepEqual(
    (written.rows as unknown as { id: string }[]).map((r) => r.id),
    ["unrelated"]
  );
});

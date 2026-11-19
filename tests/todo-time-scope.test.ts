import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import { applyAllMigrations } from "./helpers/migrations.js";
import { insertUser, USER_ID, OTHER_USER_ID } from "./helpers/notification-fixtures.js";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";
process.env.JWT_SECRET = "test-jwt-secret-123";
process.env.JWT_ADMIN_SECRET = "test-admin-secret-123";
process.env.COOKIE_SECRET = "test-cookie-secret-123456789012345";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD_HASH = `$2b$12$${"a".repeat(53)}`;
const { turso } = await import("../src/config/db.js");
const { default: userAuth } = await import("../src/plugins/user-auth.js");
const { signUserToken } = await import("../src/services/api-auth.js");
const { default: todosRoutes } = await import("../src/routes/api/v1/todos.js");
const { default: dashboardRoutes } = await import("../src/routes/api/v1/dashboard.js");
const { processPush } = await import("../src/services/sync.service.js");
const { getChangesSince, getFullEntity } = await import("../src/repositories/sync.repo.js");
const { addDays, localDateOf, localDateTimeToUtc } = await import("../src/utils/time.js");
const todos = await import("../src/services/todos.js");

const app = Fastify();
const zone = "Asia/Ho_Chi_Minh";
const today = localDateOf(new Date(), zone);
const tomorrow = addDays(today, 1);
before(async () => {
  await applyAllMigrations(turso);
  await insertUser(turso, USER_ID);
  await insertUser(turso, OTHER_USER_ID);
  await app.register(userAuth);
  await app.register(todosRoutes, { prefix: "/todos" });
  await app.register(dashboardRoutes, { prefix: "/dashboard" });
  await app.ready();
});
after(async () => { await app.close(); turso.close(); });

const request = (method: "GET" | "PATCH", url: string, payload?: object, userId = USER_ID) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${signUserToken(app, userId)}` } });
const createSeries = async (time: string | null, date = today) =>
  (await todos.createTodo(USER_ID, { title: "Recurring todo", scheduled_date: date, time, recurrence_type: "daily" })).todo;
const complete = async (id: string) => {
  const { next_recurring_todo: next } = await todos.completeTodo(USER_ID, id, {});
  assert.ok(next);
  return next;
};

test("a recurring PATCH asks once, applies nothing before the choice, and restores the usual time the next day", async () => {
  const root = await createSeries("08:00");
  const edit = { title: "Morning todo", time: "10:15" };
  const response = await request("PATCH", `/todos/${root.id}`, edit);
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: "time_scope_required",
    prompt: { message: "Which reminders should use the new time?", options: [
      { value: "this", label: "Today only" }, { value: "all", label: "All occurrences" },
    ] },
  });
  const original = (await todos.getTodoDetail(USER_ID, root.id)).todo;
  assert.equal(original.time, "08:00");
  assert.equal(original.title, root.title);
  const saved = await request("PATCH", `/todos/${root.id}`, { ...edit, time_scope: "this" });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().todo.time, "10:15");

  const list = (await request("GET", `/todos/day/${today}`)).json();
  assert.equal(list.items.find((item: { id: string }) => item.id === root.id).time, "10:15");
  const dashboard = (await request("GET", `/dashboard/eisenhower?date=${today}`)).json();
  const dashboardTodo = dashboard.by_quadrant.q4.find((item: { id: string }) => item.id === root.id);
  assert.equal(dashboardTodo.time, "10:15");
  assert.equal(dashboardTodo.is_recurring, true);
  const timeline = (await request("GET", `/dashboard/calendar/day?date=${today}`)).json();
  assert.equal(timeline.timed_todos.find((item: { id: string }) => item.id === root.id).minutes_since_midnight, 615);
  const next = await complete(root.id);
  assert.equal(next.scheduled_date, tomorrow);
  assert.equal(next.time, "08:00");
});

test("all occurrences updates open and parked siblings from a generated occurrence, including their reminder jobs", async () => {
  const root = await createSeries("08:00");
  const current = await complete(root.id);
  const next = await complete(current.id);
  await todos.uncompleteTodo(USER_ID, current.id);
  const change = { time: "14:30", time_scope: "all" };
  assert.equal((await request("PATCH", `/todos/${current.id}`, change, OTHER_USER_ID)).statusCode, 404);
  assert.equal((await request("PATCH", `/todos/${current.id}`, change)).statusCode, 200);
  assert.equal((await todos.getTodoDetail(USER_ID, root.id)).todo.time, "08:00");
  assert.equal((await todos.getTodoDetail(USER_ID, next.id)).todo.time, "14:30");
  const job = await turso.execute({
    sql: "SELECT run_at FROM notification_jobs WHERE ref_id = ? AND kind = 'todo_reminder' AND status = 'pending'",
    args: [current.id],
  });
  assert.equal(job.rows[0]?.run_at, localDateTimeToUtc(tomorrow, "14:30", zone).toISOString());
  const revived = await complete(current.id);
  assert.equal(revived.id, next.id);
  assert.equal(revived.time, "14:30");
  assert.equal((await complete(next.id)).time, "14:30");
});

test("sync keeps an untimed default across repeated one-day edits and offline successor creation", async () => {
  const root = await createSeries(null, tomorrow);
  const push = (payload: Record<string, unknown>) =>
    processPush(USER_ID, [{ type: "todo", op: "update", payload: { id: root.id, ...payload } }]);
  assert.equal((await push({ time: "12:30" }))[0].error, "time_scope_required");
  assert.equal((await push({ time: "12:30", time_scope: "unknown" }))[0].error, "bad_input");
  for (const time of ["12:30", "15:00"]) {
    assert.equal((await push({ time, time_scope: "this" }))[0].status, "applied");
  }
  const offline = {
    id: "offline-successor", recurrence_template_id: root.id, recurrence_type: "daily",
    scheduled_date: addDays(tomorrow, 1), title: "Offline successor", time: "15:00",
  };
  const [created] = await processPush(USER_ID, [{ op: "create", type: "todo", payload: offline }]);
  assert.equal(created.status, "applied");
  const pull = await getFullEntity("todo", root.id, USER_ID);
  assert.equal(pull?.time, "15:00");
  assert.equal(pull?.recurrence_time, null);
  assert.equal((await todos.getTodoDetail(USER_ID, offline.id)).todo.time, null);

  assert.equal((await push({ time: "15:00", time_scope: "all" }))[0].status, "applied");
  assert.equal((await todos.getTodoDetail(USER_ID, offline.id)).todo.time, "15:00");
  assert.equal((await push({ time: null, time_scope: "this" }))[0].status, "applied");
  assert.equal((await todos.getTodoDetail(USER_ID, root.id)).todo.time, null);
  assert.equal((await complete(offline.id)).time, "15:00");
});

test("changing a standalone todo is direct, and moving a one-day override restores its series time", async () => {
  const { todo } = await todos.createTodo(USER_ID, { title: "Once", scheduled_date: today });
  assert.equal((await request("PATCH", `/todos/${todo.id}`, { time: "09:00" })).statusCode, 200);
  const root = await createSeries("08:00", tomorrow);
  assert.equal((await request("PATCH", `/todos/${root.id}`, { time_scope: "this" })).statusCode, 400);
  await todos.updateTodo(USER_ID, root.id, { time: null, time_scope: "this" });
  const moved = await todos.moveToDay(USER_ID, root.id, { date: addDays(tomorrow, 1) });
  assert.equal(moved.time, "08:00");
  await todos.updateTodo(USER_ID, root.id, { recurrence_type: null, time: "18:00" });
  assert.equal((await todos.moveToDay(USER_ID, root.id, { date: tomorrow })).time, "18:00");
  await todos.updateTodo(USER_ID, root.id, { recurrence_type: "daily" });
  assert.equal((await complete(root.id)).time, "18:00");
});

test("offline series edits reach delta pulls and a later one-day edit in the same batch wins", async () => {
  const root = await createSeries("07:00");
  const sibling = (await todos.createTodo(USER_ID, {
    title: "Already generated", scheduled_date: tomorrow, recurrence_type: "daily",
    recurrence_template_id: root.id, time: "07:00",
  })).todo;
  const stamp = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  await turso.execute({
    sql: "UPDATE todos SET updated_at = ? WHERE id IN (?, ?)",
    args: [stamp(100_000), root.id, sibling.id],
  });
  const lastPull = stamp(10_000);
  const result = await processPush(USER_ID, [
    { type: "todo", op: "update", payload: { id: root.id, time: "09:00", time_scope: "all", updated_at: stamp(50_000) } },
    { type: "todo", op: "update", payload: { id: sibling.id, time: "11:00", time_scope: "this", updated_at: stamp(40_000) } },
  ]);
  assert.deepEqual(result.map((op) => op.status), ["applied", "applied"]);
  const { todos: delta } = await getChangesSince(USER_ID, lastPull);
  assert.equal(delta.find((item) => item.id === root.id)?.time, "09:00");
  const changed = delta.find((item) => item.id === sibling.id);
  assert.equal(changed?.time, "11:00");
  assert.equal(changed?.recurrence_time, "09:00");
});

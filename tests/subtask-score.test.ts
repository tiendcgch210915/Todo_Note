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
const scoring = await import("../src/services/dashboard-scoring.js");
const dashboard = await import("../src/services/dashboard.js");
const dailyTodoLogs = await import("../src/services/daily-todo-logs.js");
const todosService = await import("../src/services/todos.js");
const syncService = await import("../src/services/sync.service.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");

const USER_ID = "user-subtask-score";
const NOW = "2026-01-01T00:00:00.000Z";
const PAST_DAY = "2026-06-20";
const DONE_ON_PAST_DAY = "2026-06-20T08:00:00.000Z";

type Sub = { status: string; completed_at: string | null; subtasks?: Sub[] };

const done = (completedAt: string = DONE_ON_PAST_DAY): Sub => ({
  status: "done",
  completed_at: completedAt,
});
const open = (): Sub => ({ status: "open", completed_at: null });

const scorable = (
  important: number,
  urgent: number,
  base: Sub,
  extra: Partial<{ is_frog: number; frog_date: string | null }> = {}
) => ({
  ...base,
  is_important: important,
  is_urgent: urgent,
  is_frog: extra.is_frog ?? 0,
  frog_date: extra.frog_date ?? null,
});

// Three finished weight-1 todos: they satisfy the "three completed todos" minimum.
const threeDoneImportant = () => [
  scorable(1, 0, done()),
  scorable(1, 0, done()),
  scorable(1, 0, done()),
];

test("completionShare splits a todo's weight evenly across its subtasks", () => {
  const share = (sub: Sub) => scoring.completionShare(sub, PAST_DAY);

  assert.equal(share(open()), 0);
  assert.equal(share(done()), 1);
  assert.equal(share({ ...open(), subtasks: [done(), open(), open()] }), 1 / 3);
  assert.equal(share({ ...open(), subtasks: [done(), done(), open()] }), 2 / 3);
  assert.equal(share({ ...open(), subtasks: [done(), done(), done()] }), 1);
});

test("a completed todo earns its full share whatever its subtasks say", () => {
  const parent = { ...done(), subtasks: [open(), open(), open()] };
  assert.equal(scoring.completionShare(parent, PAST_DAY), 1);
});

test("completionShare counts leaf subtasks at every depth and ignores completions after the day", () => {
  // Leaves: a1 (done), a2, b -> 1 of 3. A group's own status is not counted, only its leaves.
  const nested: Sub = {
    ...open(),
    subtasks: [
      { ...done(), subtasks: [done(), open()] }, // group marked done, but only its leaves count
      open(),
    ],
  };
  assert.equal(scoring.completionShare(nested, PAST_DAY), 1 / 3);

  const late = { ...open(), subtasks: [done("2026-06-21T00:05:00.000Z"), open()] };
  assert.equal(scoring.completionShare(late, PAST_DAY), 0);
});

test("computeScore gives a partly completed parent a proportional share of its weight", () => {
  // Q1 parent (weight 2) with 3 subtasks, one done: earns 2/3 of its weight.
  // Weights: 3 done important (3) + parent (2) = 5; earned = 3 + 2/3.
  const parent = scorable(1, 1, { ...open(), subtasks: [done(), open(), open()] });
  const withSubtasks = scoring.computeScore([...threeDoneImportant(), parent], PAST_DAY);
  assert.equal(withSubtasks, Math.round((80 * (3 + 2 / 3)) / 5));

  const withoutProgress = scoring.computeScore(
    [...threeDoneImportant(), scorable(1, 1, open())],
    PAST_DAY
  );
  assert.equal(withoutProgress, 48);
  assert.ok(withSubtasks > withoutProgress);
});

test("each subtask is worth parent weight divided by the subtask count", () => {
  const score = (doneCount: number) =>
    scoring.computeScore(
      [
        ...threeDoneImportant(),
        scorable(1, 1, {
          ...open(),
          subtasks: [
            ...Array.from({ length: doneCount }, () => done()),
            ...Array.from({ length: 3 - doneCount }, () => open()),
          ],
        }),
      ],
      PAST_DAY
    );
  // Total weight 5 -> a Q1 parent is 32 of 80 points, so each of 3 subtasks is 32/3.
  assert.equal(score(0), 48);
  assert.equal(score(1), Math.round(48 + 32 / 3));
  assert.equal(score(2), Math.round(48 + 64 / 3));
  assert.equal(score(3), 80);
});

test("partial subtask progress neither counts as a completed todo nor earns the frog bonus", () => {
  const frog = scorable(
    0,
    0,
    { ...open(), subtasks: [done(), done(), open()] },
    { is_frog: 1, frog_date: PAST_DAY }
  );

  // Two finished todos plus a mostly finished frog: still below the three-completed minimum.
  const belowMinimum = scoring.computeScore(
    [scorable(1, 0, done()), scorable(1, 0, done()), frog],
    PAST_DAY
  );
  assert.equal(belowMinimum, 0);

  // Frog weight is 2 (three done todos at 1 each + frog 2 = 5); no +10 bonus while unfinished.
  const score = scoring.computeScore([...threeDoneImportant(), frog], PAST_DAY);
  assert.equal(score, Math.round((80 * (3 + (2 * 2) / 3)) / 5));
});

// ── Database-backed: live scoring, frozen snapshots, and the day lock ──────────────

type TodoInsert = {
  parentId?: string | null;
  status?: "open" | "done";
  date?: string | null;
  important?: number;
  urgent?: number;
  completedAt?: string | null;
};

const insertTodo = async (id: string, options: TodoInsert = {}): Promise<void> => {
  const status = options.status ?? "open";
  const completedAt =
    options.completedAt !== undefined
      ? options.completedAt
      : status === "done"
        ? DONE_ON_PAST_DAY
        : null;
  await turso.execute({
    sql: `INSERT INTO todos
          (id, user_id, parent_id, title, status, scheduled_date, is_important, is_urgent,
           position, completed_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    args: [
      id,
      USER_ID,
      options.parentId ?? null,
      id,
      status,
      options.date ?? null,
      options.important ?? 0,
      options.urgent ?? 0,
      completedAt,
      NOW,
      NOW,
    ],
  });
};

// Three finished important todos plus a Q1 parent with three subtasks, one of them done.
// Top-level only (subtasks carry no scheduled_date, like todos created under a parent).
const seedDay = async (date: string, doneAt: string): Promise<void> => {
  for (let i = 1; i <= 3; i += 1) {
    await insertTodo(`done-${i}`, {
      date,
      status: "done",
      important: 1,
      completedAt: doneAt,
    });
  }
  await insertTodo("parent", { date, important: 1, urgent: 1 });
  await insertTodo("sub-1", { parentId: "parent", status: "done", completedAt: doneAt });
  await insertTodo("sub-2", { parentId: "parent" });
  await insertTodo("sub-3", { parentId: "parent" });
};

const EXPECTED_SCORE = Math.round((80 * (3 + 2 / 3)) / 5); // 59

const overviewScore = async (date: string): Promise<number | undefined> => {
  const overview = await dashboard.getCalendarOverview(USER_ID, { from: date, to: date });
  return overview.days[date].score;
};

const summaryCount = async (date: string): Promise<number> => {
  const res = await turso.execute({
    sql: "SELECT COUNT(*) AS n FROM daily_todo_summaries WHERE user_id = ? AND log_date = ?",
    args: [USER_ID, date],
  });
  return Number((res.rows[0] as unknown as { n: number }).n);
};

const statusOf = async (id: string): Promise<string> => {
  const res = await turso.execute({ sql: "SELECT status FROM todos WHERE id = ?", args: [id] });
  return String((res.rows[0] as unknown as { status: string }).status);
};

before(async () => {
  await applyAllMigrations(turso);
});

beforeEach(async () => {
  for (const table of [
    "notification_jobs",
    "daily_todo_logs",
    "daily_todo_summaries",
    "todo_tags",
    "todos",
    "users",
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await turso.execute({
    sql: `INSERT INTO users (id, email, password_hash, created_at, updated_at)
          VALUES (?, 'subtask-score@example.com', 'x', ?, ?)`,
    args: [USER_ID, NOW, NOW],
  });
});

test("live today score credits completed subtasks of an unfinished parent", async () => {
  const date = "2099-01-10";
  await seedDay(date, NOW);

  const stats = await dashboard.getTodayStats(USER_ID, { date });

  // The parent is still open, so it is not a completed todo; only its subtasks earn weight.
  assert.equal(stats.todos.total, 4);
  assert.equal(stats.todos.done, 3);
  assert.equal(stats.score, EXPECTED_SCORE);
});

test("completing more subtasks raises the live score, finishing the parent maxes it", async () => {
  const date = "2099-01-10";
  await seedDay(date, NOW);

  await turso.execute({
    sql: "UPDATE todos SET status = 'done', completed_at = ? WHERE id IN ('sub-2', 'sub-3')",
    args: [NOW],
  });
  assert.equal((await dashboard.getTodayStats(USER_ID, { date })).score, 80);

  // Parent explicitly completed with its subtasks still open earns its full weight too.
  await turso.execute({
    sql: `UPDATE todos SET status = 'open', completed_at = NULL WHERE id IN ('sub-2', 'sub-3')`,
  });
  await turso.execute({
    sql: "UPDATE todos SET status = 'done', completed_at = ? WHERE id = 'parent'",
    args: [NOW],
  });
  assert.equal((await dashboard.getTodayStats(USER_ID, { date })).score, 80);
});

test("deleted and archived subtasks do not dilute a parent's share", async () => {
  const date = "2099-01-10";
  await seedDay(date, NOW);
  await turso.execute({
    sql: "UPDATE todos SET deleted_at = ? WHERE id = 'sub-3'",
    args: [NOW],
  });
  await turso.execute("UPDATE todos SET status = 'archived' WHERE id = 'sub-2'");

  // Only sub-1 remains and it is done: the parent earns its whole weight.
  assert.equal((await dashboard.getTodayStats(USER_ID, { date })).score, 80);
});

test("the calendar's today score uses the same subtask-aware model", async () => {
  const today = dailyTodoLogs.vietnamToday();
  await seedDay(today, NOW);

  const overview = await dashboard.getCalendarOverview(USER_ID, { from: today, to: today });

  assert.equal(overview.days[today].score, EXPECTED_SCORE);
});

test("a closed day's score includes subtask credit and stays fixed afterwards", async () => {
  await seedDay(PAST_DAY, DONE_ON_PAST_DAY);

  assert.equal(await overviewScore(PAST_DAY), EXPECTED_SCORE);

  // Later edits to the subtasks (even through the normal service path) cannot move it.
  await todosService.completeTodo(USER_ID, "sub-2", {});
  await todosService.completeTodo(USER_ID, "sub-3", {});
  assert.equal(await overviewScore(PAST_DAY), EXPECTED_SCORE);
  assert.equal(
    (await dashboard.getTodayStats(USER_ID, { date: PAST_DAY })).score,
    EXPECTED_SCORE
  );
});

test("un-completing a subtask after midnight freezes the day first (subtask has no own date)", async () => {
  await seedDay(PAST_DAY, DONE_ON_PAST_DAY);
  assert.equal(await summaryCount(PAST_DAY), 0, "day must not be closed before the mutation");

  await todosService.uncompleteTodo(USER_ID, "sub-1");

  assert.equal(await statusOf("sub-1"), "open");
  assert.equal(await summaryCount(PAST_DAY), 1, "mutation must close the parent's day");
  assert.equal(await overviewScore(PAST_DAY), EXPECTED_SCORE);
});

test("deleting a subtask after midnight freezes the day first", async () => {
  await seedDay(PAST_DAY, DONE_ON_PAST_DAY);

  await todosService.deleteTodo(USER_ID, "sub-2");

  assert.equal(await summaryCount(PAST_DAY), 1);
  assert.equal(await overviewScore(PAST_DAY), EXPECTED_SCORE);
});

test("a sync push that changes a subtask freezes the parent's day first", async () => {
  await seedDay(PAST_DAY, DONE_ON_PAST_DAY);

  const [result] = await syncService.processPush(USER_ID, [
    {
      op: "update",
      type: "todo",
      payload: {
        id: "sub-1",
        status: "open",
        completed_at: null,
        updated_at: "2026-06-25T00:00:00.000Z",
      },
    },
  ]);

  assert.equal(result.status, "applied");
  assert.equal(await statusOf("sub-1"), "open");
  assert.equal(await summaryCount(PAST_DAY), 1);
  assert.equal(await overviewScore(PAST_DAY), EXPECTED_SCORE);
});

test("a subtask completed after the day ended does not raise that day's score", async () => {
  await seedDay(PAST_DAY, DONE_ON_PAST_DAY);
  await turso.execute({
    sql: "UPDATE todos SET status = 'done', completed_at = ? WHERE id = 'sub-2'",
    args: ["2026-06-21T00:05:00.000Z"],
  });

  assert.equal(await overviewScore(PAST_DAY), EXPECTED_SCORE);
});

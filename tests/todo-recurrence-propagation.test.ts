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
const { applyAllMigrations } = await import("./helpers/migrations.js");
const todosService = await import("../src/services/todos.js");
const syncService = await import("../src/services/sync.service.js");
const { vietnamToday } = await import("../src/services/daily-todo-logs.js");
const { addDays } = await import("../src/utils/time.js");
const { isoWeekdayOf, ruleAllowsDate, firstRuleDateOnOrAfter } = await import(
  "../src/utils/recurrence.js"
);

const USER_ID = "user-rule-propagation";
const OTHER_USER_ID = "user-rule-propagation-other";
const OLD = "2026-01-01T00:00:00.000Z";

// A fixed "now" for the pure service tests: Monday 2026-11-02, 10:00 in Vietnam.
//   Nov 2 Mon · 3 Tue · 4 Wed · 5 Thu · 6 Fri · 7 Sat · 8 Sun · 9 Mon · 10 Tue · 11 Wed
const NOW = new Date("2026-11-02T03:00:00.000Z");

// Mon/Tue/Wed, as the mobile "Tùy chỉnh → Theo tuần" sheet sends it.
const MON_TUE_WED = {
  recurrence_type: "weekly",
  recurrence_interval: 1,
  recurrence_days_of_week: "1,2,3",
  recurrence_end_date: null,
} as const;

const DAILY = {
  recurrence_type: "daily",
  recurrence_interval: 1,
  recurrence_days_of_week: null,
  recurrence_end_date: null,
} as const;

type Row = Record<string, string | number | null>;

const insertTodo = async (id: string, overrides: Row = {}): Promise<void> => {
  const row: Row = {
    id,
    user_id: USER_ID,
    parent_id: null,
    title: `todo ${id}`,
    status: "open",
    position: 0,
    is_frog: 0,
    frog_date: null,
    scheduled_date: null,
    time: null,
    start_at: null,
    due_at: null,
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
    args: columns.map((column) => row[column]),
  });
};

const getTodo = async (id: string): Promise<Row> => {
  const res = await turso.execute({ sql: "SELECT * FROM todos WHERE id = ?", args: [id] });
  assert.equal(res.rows.length, 1, `todo ${id} should exist`);
  return res.rows[0] as unknown as Row;
};

const ruleOf = (row: Row) => ({
  recurrence_type: row.recurrence_type,
  recurrence_interval: row.recurrence_interval,
  recurrence_days_of_week: row.recurrence_days_of_week,
  recurrence_end_date: row.recurrence_end_date,
});

/** A series as the app leaves it after the rule was edited on the root: root = new rule, occurrences = old. */
const insertSeries = async (
  rootRule: Row,
  occurrences: { id: string; date: string; status?: string; overrides?: Row }[]
): Promise<void> => {
  await insertTodo("root", {
    scheduled_date: "2026-10-26",
    status: "done",
    completed_at: "2026-10-26T05:00:00.000Z",
    ...rootRule,
  });
  for (const occurrence of occurrences) {
    await insertTodo(occurrence.id, {
      scheduled_date: occurrence.date,
      status: occurrence.status ?? "open",
      recurrence_template_id: "root",
      ...DAILY,
      ...occurrence.overrides,
    });
  }
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
  for (const id of [USER_ID, OTHER_USER_ID]) {
    await turso.execute({
      sql: `INSERT INTO users (id, email, password_hash, created_at, updated_at)
            VALUES (?, ?, 'x', ?, ?)`,
      args: [id, `${id}@example.com`, OLD, OLD],
    });
  }
});

test("the root's new rule is copied to the open occurrence; a date the rule allows stays", async () => {
  await insertSeries(MON_TUE_WED, [
    { id: "occ-open", date: "2026-11-03" }, // Tue: still allowed
    { id: "occ-done", date: "2026-10-27", status: "done" },
  ]);

  const changed = await todosService.propagateRecurrenceRule(USER_ID, "root", NOW);

  assert.deepEqual(changed, ["occ-open"]);
  const open = await getTodo("occ-open");
  assert.deepEqual(ruleOf(open), ruleOf(MON_TUE_WED));
  assert.equal(open.scheduled_date, "2026-11-03");
  assert.ok(String(open.updated_at) > OLD, "the change must bump updated_at so clients pull it");
  // Finished occurrences are history: their rule is left as it was.
  assert.deepEqual(ruleOf(await getTodo("occ-done")), ruleOf(DAILY));
  assert.equal((await getTodo("root")).updated_at, OLD);
});

test("completing the refreshed occurrence follows the weekdays instead of continuing daily", async () => {
  await insertSeries(MON_TUE_WED, [{ id: "occ-open", date: "2026-11-03" }]);
  await todosService.propagateRecurrenceRule(USER_ID, "root", NOW);

  const wed = await todosService.completeTodo(USER_ID, "occ-open", {});
  assert.equal(wed.next_recurring_todo?.scheduled_date, "2026-11-04");
  assert.equal(wed.next_recurring_todo?.recurrence_type, "weekly");
  assert.equal(wed.next_recurring_todo?.recurrence_days_of_week, "1,2,3");

  // Wed is the last allowed day of the week: the next one is Monday, not Thursday.
  const mon = await todosService.completeTodo(USER_ID, wed.next_recurring_todo!.id, {});
  assert.equal(mon.next_recurring_todo?.scheduled_date, "2026-11-09");
});

test("an open occurrence on a day the rule forbids moves to the first allowed day, shifting due/start with it", async () => {
  await insertSeries(MON_TUE_WED, [
    {
      id: "occ-open",
      date: "2026-11-05", // Thu
      overrides: {
        due_at: "2026-11-05T16:59:00.000Z",
        start_at: "2026-11-05T01:30:00.000Z",
        time: "08:30",
      },
    },
  ]);

  await todosService.propagateRecurrenceRule(USER_ID, "root", NOW);

  const open = await getTodo("occ-open");
  assert.equal(open.scheduled_date, "2026-11-09"); // next Monday
  assert.equal(open.due_at, "2026-11-09T16:59:00.000Z");
  assert.equal(open.start_at, "2026-11-09T01:30:00.000Z");
  assert.equal(open.time, "08:30");
  assert.deepEqual(ruleOf(open), ruleOf(MON_TUE_WED));
});

test("an occurrence due today moves too, but never into the past", async () => {
  // Today is Monday; the rule is Tue/Wed only.
  await insertSeries(
    { ...MON_TUE_WED, recurrence_days_of_week: "2,3" },
    [{ id: "occ-today", date: "2026-11-02" }]
  );

  await todosService.propagateRecurrenceRule(USER_ID, "root", NOW);

  assert.equal((await getTodo("occ-today")).scheduled_date, "2026-11-03");
});

test("an overdue occurrence keeps its date and gets only the rule, after its day was closed", async () => {
  await insertSeries(MON_TUE_WED, [{ id: "occ-overdue", date: "2026-10-29" }]); // Thu, before today

  await todosService.propagateRecurrenceRule(USER_ID, "root", NOW);

  const overdue = await getTodo("occ-overdue");
  assert.equal(overdue.scheduled_date, "2026-10-29");
  assert.deepEqual(ruleOf(overdue), ruleOf(MON_TUE_WED));
  const logs = await turso.execute({
    sql: "SELECT COUNT(*) AS n FROM daily_todo_logs WHERE user_id = ? AND log_date = ?",
    args: [USER_ID, "2026-10-29"],
  });
  assert.equal(Number((logs.rows[0] as unknown as { n: number }).n), 1);
});

test("re-aiming skips dates the series already holds, live or deleted", async () => {
  await insertSeries(MON_TUE_WED, [{ id: "occ-open", date: "2026-11-05" }]);
  // A deleted single occurrence is a recurrence exception; a done one holds its day.
  await insertTodo("occ-deleted", {
    scheduled_date: "2026-11-09",
    status: "open",
    recurrence_template_id: "root",
    ...DAILY,
    deleted_at: "2026-11-01T00:00:00.000Z",
  });
  await insertTodo("occ-held", {
    scheduled_date: "2026-11-10",
    status: "done",
    recurrence_template_id: "root",
    ...DAILY,
  });

  await todosService.propagateRecurrenceRule(USER_ID, "root", NOW);

  assert.equal((await getTodo("occ-open")).scheduled_date, "2026-11-11"); // Wed
});

test("when no allowed date is left before the end date the occurrence keeps its date and only gets the rule", async () => {
  const rule = { ...MON_TUE_WED, recurrence_end_date: "2026-11-04" };
  await insertSeries(rule, [{ id: "occ-open", date: "2026-11-05" }]);

  await todosService.propagateRecurrenceRule(USER_ID, "root", NOW);

  const open = await getTodo("occ-open");
  assert.equal(open.scheduled_date, "2026-11-05");
  assert.deepEqual(ruleOf(open), ruleOf(rule));
});

test("a parked occurrence gets the rule but keeps its date; the revive re-dates it", async () => {
  await insertSeries(MON_TUE_WED, [{ id: "occ-parked", date: "2026-11-05", status: "archived" }]);

  await todosService.propagateRecurrenceRule(USER_ID, "root", NOW);

  const parked = await getTodo("occ-parked");
  assert.equal(parked.status, "archived");
  assert.equal(parked.scheduled_date, "2026-11-05");
  assert.deepEqual(ruleOf(parked), ruleOf(MON_TUE_WED));
});

test("a frog occurrence keeps its frog flag on the new day", async () => {
  await insertSeries(MON_TUE_WED, [
    {
      id: "occ-frog",
      date: "2026-11-05",
      overrides: { is_frog: 1, frog_date: "2026-11-05", is_important: 1, is_urgent: 1 },
    },
  ]);

  await todosService.propagateRecurrenceRule(USER_ID, "root", NOW);

  const frog = await getTodo("occ-frog");
  assert.equal(frog.scheduled_date, "2026-11-09");
  assert.equal(frog.is_frog, 1);
  assert.equal(frog.frog_date, "2026-11-09");
});

test("running it again changes nothing", async () => {
  await insertSeries(MON_TUE_WED, [{ id: "occ-open", date: "2026-11-05" }]);

  assert.deepEqual(await todosService.propagateRecurrenceRule(USER_ID, "root", NOW), ["occ-open"]);
  const after = await getTodo("occ-open");

  assert.deepEqual(await todosService.propagateRecurrenceRule(USER_ID, "root", NOW), []);
  assert.deepEqual(await getTodo("occ-open"), after);
});

test("only a series root propagates, and only to its own series and user", async () => {
  await insertSeries(MON_TUE_WED, [{ id: "occ-open", date: "2026-11-03" }]);
  await insertTodo("other-root", { scheduled_date: "2026-10-26", status: "done", ...DAILY });
  await insertTodo("other-occ", {
    scheduled_date: "2026-11-03",
    recurrence_template_id: "other-root",
    ...DAILY,
  });
  await insertTodo("foreign", {
    user_id: OTHER_USER_ID,
    scheduled_date: "2026-11-03",
    recurrence_template_id: "root",
    ...DAILY,
  });
  await insertTodo("plain", { scheduled_date: "2026-11-03" }); // no rule at all

  // An occurrence is not a root: nothing happens.
  assert.deepEqual(await todosService.propagateRecurrenceRule(USER_ID, "occ-open", NOW), []);
  assert.deepEqual(ruleOf(await getTodo("occ-open")), ruleOf(DAILY));
  // A todo without a rule is not a root either.
  assert.deepEqual(await todosService.propagateRecurrenceRule(USER_ID, "plain", NOW), []);

  assert.deepEqual(await todosService.propagateRecurrenceRule(USER_ID, "root", NOW), ["occ-open"]);
  assert.deepEqual(ruleOf(await getTodo("other-occ")), ruleOf(DAILY));
  assert.deepEqual(ruleOf(await getTodo("foreign")), ruleOf(DAILY));
});

// ── Pure rule helpers ────────────────────────────────────────────────────────

test("ruleAllowsDate filters by weekday only for weekly rules that list weekdays", () => {
  const rule = (type: "daily" | "weekly" | "custom", days: string | null) => ({
    type,
    interval: 1,
    daysOfWeek: days,
    endDate: null,
  });

  assert.equal(ruleAllowsDate(rule("weekly", "1,2,3"), "2026-11-03"), true); // Tue
  assert.equal(ruleAllowsDate(rule("weekly", "1,2,3"), "2026-11-05"), false); // Thu
  assert.equal(ruleAllowsDate(rule("weekly", null), "2026-11-05"), true);
  assert.equal(ruleAllowsDate(rule("daily", null), "2026-11-05"), true);
  // Same reading as nextRecurrenceDateAfter: custom is "every N days" and ignores weekdays.
  assert.equal(ruleAllowsDate(rule("custom", "1,2,3"), "2026-11-05"), true);
  assert.equal(ruleAllowsDate({ ...rule("daily", null), type: null }, "2026-11-05"), false);
  assert.equal(ruleAllowsDate(rule("weekly", "1,2,3"), "not-a-date"), false);
});

test("firstRuleDateOnOrAfter returns the first allowed day, or null past the end date", () => {
  const rule = {
    type: "weekly" as const,
    interval: 1,
    daysOfWeek: "1,2,3",
    endDate: null as string | null,
  };

  assert.equal(firstRuleDateOnOrAfter(rule, "2026-11-03"), "2026-11-03"); // already allowed
  assert.equal(firstRuleDateOnOrAfter(rule, "2026-11-05"), "2026-11-09"); // Thu -> Mon
  assert.equal(firstRuleDateOnOrAfter({ ...rule, endDate: "2026-11-08" }, "2026-11-05"), null);
  assert.equal(firstRuleDateOnOrAfter({ ...rule, endDate: "2026-11-09" }, "2026-11-05"), "2026-11-09");
  assert.equal(firstRuleDateOnOrAfter({ ...rule, type: null as never }, "2026-11-05"), null);
});

// ── Entry points: REST (service) and sync push ───────────────────────────────

test("editing the rule through updateTodo refreshes the occurrence the earlier completion created", async () => {
  // The reported scenario: a daily series whose first todo was completed (so an occurrence
  // exists), then the rule is changed to specific weekdays on the root.
  const today = vietnamToday();
  const tomorrow = addDays(today, 1);
  const created = await todosService.createTodo(USER_ID, {
    title: "daily then weekdays",
    scheduled_date: today,
    recurrence_type: "daily",
    recurrence_interval: 1,
  });
  const rootId = created.todo.id;
  const done = await todosService.completeTodo(USER_ID, rootId, {});
  const occurrenceId = done.next_recurring_todo!.id;
  assert.equal(done.next_recurring_todo?.recurrence_type, "daily");

  // A single weekday that matches the existing occurrence, so only the rule must change.
  const weekday = String(isoWeekdayOf(tomorrow));
  await todosService.updateTodo(USER_ID, rootId, {
    recurrence_type: "weekly",
    recurrence_interval: 1,
    recurrence_days_of_week: weekday,
  });

  const occurrence = await getTodo(occurrenceId);
  assert.equal(occurrence.recurrence_type, "weekly");
  assert.equal(occurrence.recurrence_days_of_week, weekday);
  assert.equal(occurrence.scheduled_date, tomorrow);

  // And it now repeats weekly, not daily.
  const next = await todosService.completeTodo(USER_ID, occurrenceId, {});
  assert.equal(next.next_recurring_todo?.scheduled_date, addDays(tomorrow, 7));
});

test("updateTodo leaves the occurrences alone when the patch does not touch the rule", async () => {
  await insertSeries(MON_TUE_WED, [{ id: "occ-open", date: "2026-11-03" }]);

  await todosService.updateTodo(USER_ID, "root", { title: "renamed" });

  assert.deepEqual(ruleOf(await getTodo("occ-open")), ruleOf(DAILY));
});

test("a sync push of the root's rule refreshes the occurrence, and a completion queued behind it in the same batch still wins", async () => {
  const today = vietnamToday();
  await insertTodo("root", {
    scheduled_date: addDays(today, -3),
    status: "done",
    completed_at: `${addDays(today, -3)}T05:00:00.000Z`,
    ...DAILY,
  });
  await insertTodo("occ-open", {
    scheduled_date: addDays(today, 1),
    recurrence_template_id: "root",
    ...DAILY,
  });
  const tomorrowWeekday = String(isoWeekdayOf(addDays(today, 1)));
  const dayAfter = addDays(today, 2);

  const editedAt = new Date(Date.now() - 20_000).toISOString();
  const completedAt = new Date(Date.now() - 10_000).toISOString();
  const results = await syncService.processPush(USER_ID, [
    {
      op: "update",
      type: "todo",
      payload: {
        id: "root",
        updated_at: editedAt,
        recurrence_type: "weekly",
        recurrence_interval: 1,
        recurrence_days_of_week: tomorrowWeekday,
        recurrence_end_date: null,
      },
    },
    // Completed offline after the rule edit; its payload still carries the old (daily) rule.
    {
      op: "update",
      type: "todo",
      payload: {
        id: "occ-open",
        updated_at: completedAt,
        status: "done",
        completed_at: completedAt,
        ...DAILY,
      },
    },
    // The next occurrence the app built locally from the completed one: stale rule as well.
    {
      op: "create",
      type: "todo",
      payload: {
        id: "occ-next",
        title: "todo occ-next",
        status: "open",
        position: 0,
        scheduled_date: dayAfter,
        recurrence_template_id: "root",
        created_at: completedAt,
        updated_at: completedAt,
        ...DAILY,
      },
    },
  ]);

  assert.deepEqual(
    results.map((r) => r.status),
    ["applied", "applied", "applied"]
  );
  assert.equal((await getTodo("occ-open")).status, "done");
  const next = await getTodo("occ-next");
  assert.equal(next.recurrence_type, "weekly");
  assert.equal(next.recurrence_days_of_week, tomorrowWeekday);
  // The weekday filter now applies to it, so it sits on the next allowed day (a week on).
  assert.equal(next.scheduled_date, addDays(today, 8));
});

test("a sync push that does not carry the rule fields does not propagate", async () => {
  await insertSeries(MON_TUE_WED, [{ id: "occ-open", date: "2026-11-03" }]);

  const [result] = await syncService.processPush(USER_ID, [
    {
      op: "update",
      type: "todo",
      payload: { id: "root", title: "renamed", updated_at: new Date().toISOString() },
    },
  ]);

  assert.equal(result.status, "applied");
  assert.deepEqual(ruleOf(await getTodo("occ-open")), ruleOf(DAILY));
});

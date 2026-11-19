import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";

import { createClient } from "@libsql/client";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";
process.env.JWT_SECRET = "test-jwt-secret-123";
process.env.JWT_ADMIN_SECRET = "test-admin-secret-123";
process.env.COOKIE_SECRET = "test-cookie-secret-123456789012345";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD_HASH = `$2b$12$${"a".repeat(53)}`;
process.env.GOOGLE_APPLICATION_CREDENTIALS = "./does-not-exist-service-account.json";

const { turso } = await import("../src/config/db.js");
const { getChangesSince, getSyncCursorTime } = await import("../src/repositories/sync.repo.js");
const { processPush } = await import("../src/services/sync.service.js");
const { default: Fastify } = await import("fastify");
const { default: userAuth } = await import("../src/plugins/user-auth.js");
const { default: syncRoutes } = await import("../src/routes/api/v1/sync.js");
const { signUserToken } = await import("../src/services/api-auth.js");
const { applyAllMigrations, parseStatements } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID } = fx;
const TPL = "tst-cursor-template";
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Row = Record<string, unknown>;
type Op = { op: "create" | "update" | "delete"; type: string; payload: Row };

const push = (ops: Op[]) => processPush(USER_ID, ops as never[]);

/** What an offline device stamped on its edit: an hour before the cursor another device holds. */
const hourBefore = (cursor: string): string => new Date(Date.parse(cursor) - 3_600_000).toISOString();

const overrideOp = (id: string, editedAt: string, fields: Row = {}): Op => ({
  op: "create",
  type: "checklist_schedule_override",
  payload: {
    id,
    template_id: TPL,
    local_date: "2026-06-20",
    time: "08:00",
    skipped: true,
    created_at: editedAt,
    updated_at: editedAt,
    ...fields,
  },
});

const overridesIn = (changes: { checklist_schedule_overrides: Row[] }, id: string): Row | undefined =>
  changes.checklist_schedule_overrides.find((row) => row.id === id);

const stampOf = async (table: string, id: string): Promise<string | null> => {
  const res = await turso.execute({
    sql: "SELECT synced_at FROM sync_stamps WHERE entity_type = ? AND entity_id = ?",
    args: [table, id],
  });
  return res.rows.length === 0 ? null : String((res.rows[0] as unknown as Row).synced_at);
};

const app = Fastify();

before(async () => {
  await applyAllMigrations(turso);
  await app.register(userAuth);
  await app.register(syncRoutes, { prefix: "/sync" });
  await app.ready();
});

after(async () => {
  await app.close();
});

beforeEach(async () => {
  for (const table of [
    "sync_stamps",
    "checklist_schedule_overrides",
    "checklist_schedules",
    "habit_logs",
    "habits",
    "todos",
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await turso.execute("DELETE FROM checklist_template_items WHERE template_id LIKE 'tst-%'");
  await turso.execute("DELETE FROM checklist_templates WHERE id LIKE 'tst-%'");
  await turso.execute({ sql: "DELETE FROM users WHERE id = ?", args: [USER_ID] });
  await fx.insertUser(turso, USER_ID);
  await fx.insertTemplateWithItems(turso, { id: TPL, title: "Buổi sáng", itemCount: 2 });
});

// ── The bug this migration fixes ─────────────────────────────────────────────

test("an edit pushed late (older updated_at than the puller's cursor) reaches the puller's next delta", async () => {
  const cursor = await getSyncCursorTime(); // device B pulled: this is its cursor
  const editedAt = hourBefore(cursor); // device A edited offline an hour earlier and pushes only now

  const [result] = await push([overrideOp("ov-late", editedAt)]);
  assert.equal(result.status, "applied");

  const row = overridesIn(await getChangesSince(USER_ID, cursor), "ov-late");
  assert.ok(row, "the late push is in the delta; `updated_at > since` would have skipped it");
  assert.equal(row.skipped, true);
  assert.equal(row.local_date, "2026-06-20");
  assert.equal(row.updated_at, editedAt, "updated_at stays the writer's clock (Last-Write-Wins is untouched)");
});

test("it is not specific to checklists: a todo edited offline and pushed late reaches the delta", async () => {
  await fx.insertTodo(turso, { id: "tst-late-todo", title: "Before" });
  const cursor = await getSyncCursorTime();
  const editedAt = hourBefore(cursor);

  const [result] = await push([
    { op: "update", type: "todo", payload: { id: "tst-late-todo", title: "After", updated_at: editedAt } },
  ]);
  assert.equal(result.status, "applied");

  const todo = (await getChangesSince(USER_ID, cursor)).todos.find((row) => row.id === "tst-late-todo");
  assert.ok(todo);
  assert.equal(todo.title, "After");
});

test("rows not written since the cursor are not sent again", async () => {
  const cursor = await getSyncCursorTime();
  await push([overrideOp("ov-once", hourBefore(cursor))]);
  assert.ok(overridesIn(await getChangesSince(USER_ID, cursor), "ov-once"));

  await sleep(5); // stamps and cursors have millisecond resolution
  const next = await getSyncCursorTime();
  const delta = await getChangesSince(USER_ID, next);

  assert.equal(overridesIn(delta, "ov-once"), undefined);
  assert.deepEqual(delta.checklist_schedule_overrides, []);
  assert.deepEqual(delta.todos, []);
});

test("a write that never touches updated_at still reaches the delta (any write path)", async () => {
  await fx.insertHabit(turso, { id: "tst-habit" });
  const cursor = await getSyncCursorTime();

  // Server-side bookkeeping (streak recomputation, an admin SQL fix...): no updated_at bump.
  const res = await turso.execute("UPDATE habits SET current_streak = 9 WHERE id = 'tst-habit'");
  assert.equal(res.rowsAffected, 1, "the stamp trigger must not change what the writer's statement reports");

  const habit = (await getChangesSince(USER_ID, cursor)).habits.find((row) => row.id === "tst-habit");
  assert.ok(habit);
  assert.equal(habit.current_streak, 9);
});

test("tombstones come through the delta (even a late one) and never through the initial pull", async () => {
  const cursor = await getSyncCursorTime();
  const editedAt = hourBefore(cursor);
  await push([overrideOp("ov-gone", editedAt, { updated_at: new Date(Date.parse(editedAt) - 1000).toISOString() })]);
  await sleep(5);
  const afterCreate = await getSyncCursorTime();

  const [deleted] = await push([
    { op: "delete", type: "checklist_schedule_override", payload: { id: "ov-gone", updated_at: editedAt, deleted_at: editedAt } },
  ]);
  assert.equal(deleted.status, "applied");

  const tombstone = overridesIn(await getChangesSince(USER_ID, afterCreate), "ov-gone");
  assert.ok(tombstone, "the delta carries the soft-deleted row");
  assert.equal(tombstone.deleted_at, editedAt);
  assert.equal(overridesIn(await getChangesSince(USER_ID, null), "ov-gone"), undefined, "initial pull is living rows only");
});

// ── What must NOT change ─────────────────────────────────────────────────────

test("Last-Write-Wins still runs on updated_at: an older update is a conflict and writes nothing", async () => {
  const newer = new Date().toISOString();
  const older = new Date(Date.now() - 3_600_000).toISOString();
  await push([overrideOp("ov-lww", newer, { time: "21:00", skipped: false })]);
  const stampBefore = await stampOf("checklist_schedule_overrides", "ov-lww");
  await sleep(5);

  const [result] = await push([{ ...overrideOp("ov-lww", older, { time: "03:00" }), op: "update" }]);

  assert.equal(result.status, "conflict");
  const row = (await turso.execute("SELECT time FROM checklist_schedule_overrides WHERE id = 'ov-lww'")).rows[0] as unknown as Row;
  assert.equal(row.time, "21:00");
  assert.equal(await stampOf("checklist_schedule_overrides", "ov-lww"), stampBefore, "a refused op is not a write");
});

test("pulled rows do not expose the cursor bookkeeping", async () => {
  await fx.insertTodo(turso, { id: "tst-shape" });
  const full = await getChangesSince(USER_ID, null);
  const delta = await getChangesSince(USER_ID, "2000-01-01T00:00:00.000Z");
  for (const changes of [full, delta]) {
    assert.ok(changes.todos.length > 0);
    for (const rows of Object.values(changes)) {
      for (const row of rows) assert.equal("synced_at" in row, false);
    }
  }
});

// ── The cursor itself ────────────────────────────────────────────────────────

test("the cursor is a millisecond ISO string from the database clock, a hair early", async () => {
  const before = Date.now();
  const cursor = await getSyncCursorTime();
  const after = Date.now();

  assert.match(cursor, ISO_MS);
  const at = Date.parse(cursor);
  assert.ok(at >= before - 1 - 1000 && at <= after, `cursor ${cursor} should be within a moment of ${new Date(before).toISOString()}`);

  await fx.insertTodo(turso, { id: "tst-after-cursor" });
  const stamp = (await stampOf("todos", "tst-after-cursor"))!;
  assert.match(stamp, ISO_MS);
  assert.ok(stamp > cursor, "a write made after the cursor was read sorts strictly after it");
});

test("GET /sync/changes: server_time is the cursor, and a late push shows up in the delta that uses it", async () => {
  const get = async (url: string) => {
    const res = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${signUserToken(app, USER_ID)}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body) as { server_time: string; changes: { checklist_schedule_overrides: Row[] } };
  };

  const first = await get("/sync/changes");
  assert.match(first.server_time, ISO_MS);

  await push([overrideOp("ov-http", hourBefore(first.server_time))]);

  const second = await get(`/sync/changes?since=${encodeURIComponent(first.server_time)}`);
  assert.ok(second.server_time >= first.server_time);
  const row = overridesIn(second.changes, "ov-http");
  assert.ok(row, "the next delta, with the server_time the first pull returned, has the late push");
  assert.equal(row.skipped, true);
});

// ── The migration ────────────────────────────────────────────────────────────

test("every table of the pull is stamped on insert and on update", async () => {
  const pulled = Object.keys(await getChangesSince(USER_ID, null));
  assert.equal(pulled.length, 15, "SyncChanges grew or shrank: give the new table stamp triggers in a migration");

  const triggers = new Set(
    (await turso.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_stamp_%'")).rows.map(
      (row) => String((row as unknown as Row).name)
    )
  );
  for (const table of pulled) {
    assert.ok(triggers.has(`sync_stamp_${table}_ins`), `${table}: insert trigger`);
    assert.ok(triggers.has(`sync_stamp_${table}_upd`), `${table}: update trigger`);
  }
  assert.equal(triggers.size, pulled.length * 2, "no stray stamp triggers");
});

test("the migration backfills existing rows with their updated_at (created_at, then nothing, when it is missing)", async () => {
  const dir = join(process.cwd(), "migrations");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  const migration = files.find((file) => file.startsWith("0031_"));
  assert.ok(migration, "0031 migration exists");
  const db = createClient({ url: "file::memory:" });
  try {
    const apply = async (file: string) => {
      for (const statement of parseStatements(await readFile(join(dir, file), "utf-8"))) {
        await db.execute(statement);
      }
    };
    for (const file of files.filter((name) => name < migration)) await apply(file);

    const stamp = "2026-01-02T03:04:05.678Z";
    await db.batch(
      [
        { sql: "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES('u','u@t.local','',?,?)", args: [stamp, stamp] },
        { sql: "INSERT INTO tags(id,user_id,name,created_at,updated_at) VALUES('tag','u','Tag',?,?)", args: ["2025-12-31T00:00:00.000Z", stamp] },
        { sql: "INSERT INTO habits(id,user_id,title,frequency_type,target_per_period,start_date,created_at,updated_at) VALUES('h','u','H','daily',1,'2026-01-01',?,?)", args: [stamp, stamp] },
        { sql: "INSERT INTO habit_logs(id,habit_id,log_date,completed,created_at,updated_at) VALUES('log-created','h','2026-01-01',1,?,NULL)", args: [stamp] },
        { sql: "INSERT INTO checklist_templates(id,user_id,title,is_system,times_used,sort_order,created_at,updated_at) VALUES('tpl','u','T',0,0,0,?,?)", args: [stamp, stamp] },
        { sql: "INSERT INTO checklist_runs(id,template_id,user_id,started_at,created_at,updated_at) VALUES('run-bare','tpl','u',?,NULL,NULL)", args: [stamp] },
      ],
      "write"
    );

    await apply(migration);

    const stamps = new Map(
      (await db.execute("SELECT entity_type, entity_id, synced_at FROM sync_stamps")).rows.map((row) => {
        const r = row as unknown as Row;
        return [`${r.entity_type}/${r.entity_id}`, String(r.synced_at)] as const;
      })
    );
    assert.equal(stamps.get("users/u"), stamp);
    assert.equal(stamps.get("tags/tag"), stamp, "updated_at wins over created_at");
    assert.equal(stamps.get("habits/h"), stamp);
    assert.equal(stamps.get("habit_logs/log-created"), stamp, "a missing updated_at falls back to created_at");
    assert.equal(stamps.get("checklist_runs/run-bare"), "", "no timestamp at all never matches a cursor");

    // From now on the triggers own the stamp: an update moves it to the database clock.
    await db.execute("UPDATE tags SET name = 'Renamed' WHERE id = 'tag'");
    const moved = (await db.execute("SELECT synced_at FROM sync_stamps WHERE entity_type='tags' AND entity_id='tag'")).rows[0] as unknown as Row;
    assert.ok(String(moved.synced_at) > stamp);
  } finally {
    db.close();
  }
});

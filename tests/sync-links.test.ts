import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAllMigrations } from "./helpers/migrations.js";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";
const { turso } = await import("../src/config/db.js");
const { getChangesSince, getFullEntity } = await import("../src/repositories/sync.repo.js");

test("full, delta and conflict reads embed the same live links, including unchanged targets", async (t) => {
  t.after(() => turso.close());
  await applyAllMigrations(turso);
  const old = "2026-01-01T00:00:00Z";
  const changed = "2026-01-02T00:00:00Z";
  const label = 'a "quoted" link\nwith a newline';
  await turso.batch([
    { sql: "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES('u','u@test.local','',?,?)", args: [old, old] },
    ...["parent", "target", "deleted"].map((id) => ({
      sql: "INSERT INTO notes(id,user_id,title,created_at,updated_at,deleted_at) VALUES(?,'u',?,?,?,?)",
      args: [id, id, old, id === "target" ? old : changed, id === "deleted" ? changed : null],
    })),
    { sql: "INSERT INTO todos(id,user_id,title,created_at,updated_at) VALUES('todo','u','Todo',?,?)", args: [old, old] },
    ...["parent", "deleted"].map((id) => ({
      sql: "INSERT INTO note_todo_links(id,note_id,todo_id,created_at) VALUES(?,?,'todo',?)",
      args: [id, id, old],
    })),
    ...["target", "deleted"].map((id) => ({
      sql: "INSERT INTO note_links(id,source_note_id,target_note_id,label,created_at) VALUES(?,'parent',?,?,?)",
      args: [id, id, label, old],
    })),
    { sql: "INSERT INTO tags(id,user_id,name,created_at,updated_at) VALUES('tag','u','Tag',?,?)", args: [old, old] },
    "INSERT INTO note_tags(note_id,tag_id) VALUES('parent','tag')",
    "INSERT INTO todo_tags(todo_id,tag_id) VALUES('todo','tag')",
  ], "write");

  const full = await getChangesSince("u", null);
  const delta = await getChangesSince("u", old);
  const parent = full.notes.find((n) => n.id === "parent");
  assert.ok(parent);
  assert.deepEqual(parent.tag_ids, ["tag"]);
  assert.deepEqual(parent.linked_todo_ids, ["todo"]);
  assert.deepEqual(parent.note_links, [{ target_note_id: "target", label }]);
  assert.deepEqual(full.todos[0].linked_note_ids, ["parent"]);
  assert.deepEqual(full.todos[0].tag_ids, ["tag"]);
  assert.deepEqual(delta.notes.find((n) => n.id === "parent"), parent);
  assert.deepEqual(delta.todos, []);
  assert.equal(full.notes.some((n) => n.id === "deleted"), false);
  assert.equal(delta.notes.find((n) => n.id === "deleted")?.deleted_at, changed);
  assert.deepEqual(await getFullEntity("note", "parent", "u"), parent);
  assert.deepEqual(await getFullEntity("todo", "todo", "u"), full.todos[0]);
  assert.equal(await getFullEntity("note", "parent", "another-user"), null);
});

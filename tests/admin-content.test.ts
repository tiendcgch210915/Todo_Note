import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { applyAllMigrations } from "./helpers/migrations.js";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";
const { turso } = await import("../src/config/db.js");
const { default: views } = await import("../src/plugins/view.js");
const { default: content } = await import("../src/routes/admin/content.js");

test("admin content renders active todo and note summaries", async (t) => {
  t.after(() => turso.close());
  await applyAllMigrations(turso);
  await turso.batch([
    "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES('u','u@test.local','','2026','2026')",
    "INSERT INTO todos(id,user_id,title,created_at,updated_at) VALUES('t','u','Visible todo','2026','2026')",
    "INSERT INTO notes(id,user_id,title,body,created_at,updated_at) VALUES('n','u','Visible note','Private body','2026','2026')",
    "INSERT INTO todos(id,user_id,title,created_at,updated_at,deleted_at) VALUES('d','u','Hidden todo','2026','2026','2026')",
  ], "write");

  const app = Fastify();
  t.after(() => app.close());
  app.decorate("requireAdmin", async () => {});
  await app.register(cookie);
  await app.register(views);
  await app.register(content, { prefix: "/admin" });
  const res = await app.inject("/admin/users/u/content");
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Todos \(1\)/);
  assert.match(res.body, /Notes \(1\)/);
  assert.match(res.body, /Visible todo/);
  assert.match(res.body, /Visible note/);
  assert.doesNotMatch(res.body, /Hidden todo|Private body/);
});

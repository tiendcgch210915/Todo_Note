import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";
process.env.JWT_SECRET = "test-jwt-secret-123";
process.env.JWT_ADMIN_SECRET = "test-admin-secret-123";
process.env.COOKIE_SECRET = "test-cookie-secret-123456789012345";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD_HASH = `$2b$12$${"a".repeat(53)}`;
process.env.NOTIFICATIONS_ENABLED = "false";

const { turso } = await import("../src/config/db.js");
const notifications = await import("../src/services/notifications.js");
const { getVietnamNowParts } = await import("../src/utils/vietnam-time.js");

const USER_ID = "11111111-1111-7111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-7222-8222-222222222222";
const NOW = "2026-06-20T00:00:00.000Z";

const insertUser = async (
  id: string,
  deletedAt: string | null = null
): Promise<void> => {
  await turso.execute({
    sql: `INSERT INTO users
          (id, email, password_hash, timezone, is_admin, created_at, updated_at, deleted_at)
          VALUES (?, ?, 'test-hash', 'Asia/Ho_Chi_Minh', 0, ?, ?, ?)`,
    args: [id, `${id}@test.local`, NOW, NOW, deletedAt],
  });
};

const insertToken = async (userId: string, token: string): Promise<void> => {
  await notifications.registerToken(userId, token);
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
    status: "open",
    position: 0,
    is_important: null,
    is_urgent: null,
    scheduled_date: "2026-06-20",
    time: null,
    created_at: NOW,
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

const tokensFor = async (userId: string): Promise<string[]> => {
  const res = await turso.execute({
    sql: "SELECT registration_id FROM user_devices WHERE user_id = ? ORDER BY registration_id ASC",
    args: [userId],
  });
  return (res.rows as unknown as { registration_id: string }[]).map(
    (row) => row.registration_id
  );
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
    CREATE TABLE IF NOT EXISTS user_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      registration_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'token',
      platform TEXT NOT NULL DEFAULT 'android',
      last_seen_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await turso.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_devices_user_token
      ON user_devices(user_id, registration_id)
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      parent_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      position INTEGER NOT NULL DEFAULT 0,
      is_important INTEGER,
      is_urgent INTEGER,
      scheduled_date TEXT,
      time TEXT,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      todo_id TEXT,
      kind TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await turso.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_deliveries_dedupe
      ON notification_deliveries(dedupe_key)
  `);
});

beforeEach(async () => {
  for (const table of [
    "notification_deliveries",
    "todos",
    "user_devices",
    "users",
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  notifications.setNotificationSenderForTests(null);
  await insertUser(USER_ID);
  await insertUser(OTHER_USER_ID);
});

test("Vietnam time helper uses hardcoded GMT+7", () => {
  assert.deepEqual(getVietnamNowParts(new Date("2026-06-20T01:00:00.000Z")), {
    date: "2026-06-20",
    hhmm: "08:00",
    hour: 8,
    minute: 0,
  });
  assert.equal(
    getVietnamNowParts(new Date("2026-06-20T17:30:00.000Z")).date,
    "2026-06-21"
  );
});

test("registerToken upserts and prevents duplicate tokens for the same user", async () => {
  const first = await notifications.registerToken(USER_ID, "token-a");
  const second = await notifications.registerToken(USER_ID, "token-a");

  assert.equal(first.id, second.id);
  assert.deepEqual(await tokensFor(USER_ID), ["token-a"]);

  await notifications.registerToken(OTHER_USER_ID, "shared-token");
  await notifications.registerToken(USER_ID, "shared-token");

  assert.deepEqual(await tokensFor(USER_ID), ["shared-token", "token-a"]);
  assert.deepEqual(await tokensFor(OTHER_USER_ID), []);
});

test("morning notification counts important urgent todos and cleans invalid tokens", async () => {
  const sent: Array<{ title: string; body: string; tokens: string[] }> = [];
  notifications.setNotificationSenderForTests(async (message) => {
    sent.push({
      title: message.title,
      body: message.body,
      tokens: message.devices.map((device) => device.registrationId).sort(),
    });
    const invalid = message.devices.filter(
      (device) => device.registrationId === "bad-token"
    );
    return {
      successCount: message.devices.length - invalid.length,
      failureCount: invalid.length,
      invalidDeviceIds: invalid.map((device) => device.id),
    };
  });

  await insertToken(USER_ID, "good-token");
  await insertToken(USER_ID, "bad-token");
  await insertTodo("todo-1", { is_important: 1, is_urgent: 1 });
  await insertTodo("todo-2", { is_important: 1, is_urgent: 1 });
  await insertTodo("todo-low", { is_important: 1, is_urgent: 0 });

  const result = await notifications.sendMorningNotifications("2026-06-20");

  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Chào buổi sáng!");
  assert.match(sent[0].body, /2 todos quan trọng & khẩn cấp/);
  assert.deepEqual(sent[0].tokens, ["bad-token", "good-token"]);
  assert.deepEqual(await tokensFor(USER_ID), ["good-token"]);

  await notifications.sendMorningNotifications("2026-06-20");
  assert.equal(sent.length, 1);
});

test("evening notification sends congratulations when all todos are done", async () => {
  const sent: Array<{ title: string; body: string }> = [];
  notifications.setNotificationSenderForTests(async (message) => {
    sent.push({ title: message.title, body: message.body });
    return {
      successCount: message.devices.length,
      failureCount: 0,
      invalidDeviceIds: [],
    };
  });

  await insertToken(USER_ID, "token-a");
  await insertTodo("done-todo", { status: "done" });

  const result = await notifications.sendEveningNotifications("2026-06-20");

  assert.equal(result.sent, 1);
  assert.equal(sent[0].title, "Tổng kết ngày");
  assert.match(sent[0].body, /hoàn thành toàn bộ todos hôm nay/);
});

test("custom todo reminder sends due todo once per minute", async () => {
  const sent: Array<{ body: string; data: Record<string, string> | undefined }> =
    [];
  notifications.setNotificationSenderForTests(async (message) => {
    sent.push({ body: message.body, data: message.data });
    return {
      successCount: message.devices.length,
      failureCount: 0,
      invalidDeviceIds: [],
    };
  });

  await insertToken(USER_ID, "token-a");
  await insertTodo("due-todo", { title: "Uống nước", time: "08:30" });
  await insertTodo("done-due", {
    title: "Already done",
    status: "done",
    time: "08:30",
  });
  await insertTodo("later-todo", { title: "Later", time: "09:30" });

  const result = await notifications.sendTodoReminderNotifications(
    "2026-06-20",
    "08:30"
  );

  assert.equal(result.todos, 1);
  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, "Đã đến giờ: Uống nước");
  assert.equal(sent[0].data?.todo_id, "due-todo");

  await notifications.sendTodoReminderNotifications("2026-06-20", "08:30");
  assert.equal(sent.length, 1);
});

import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";
process.env.JWT_SECRET = "test-jwt-secret-123";
process.env.JWT_ADMIN_SECRET = "test-admin-secret-123";
process.env.COOKIE_SECRET = "test-cookie-secret-123456789012345";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD_HASH = `$2b$12$${"a".repeat(53)}`;

const { turso } = await import("../src/config/db.js");
const notifications = await import("../src/services/notifications.js");
const { getVietnamNowParts } = await import("../src/utils/vietnam-time.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");

const USER_ID = "11111111-1111-7111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-7222-8222-222222222222";
const NOW = "2026-06-20T00:00:00.000Z";

const insertUser = async (id: string): Promise<void> => {
  await turso.execute({
    sql: `INSERT INTO users
          (id, email, password_hash, timezone, is_admin, created_at, updated_at)
          VALUES (?, ?, 'test-hash', 'Asia/Ho_Chi_Minh', 0, ?, ?)`,
    args: [id, `${id}@test.local`, NOW, NOW],
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
  await applyAllMigrations(turso);
});

beforeEach(async () => {
  for (const table of ["notification_jobs", "user_devices", "users"]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  notifications.setNotificationSenderForTests(null);
  await insertUser(USER_ID);
  await insertUser(OTHER_USER_ID);
});

// The fixed-time senders (08:00 / 17:00 / per-minute reminders) were replaced by the
// notification_jobs queue; see notification-jobs.test.ts, notification-content.test.ts
// and todo-timer.test.ts.

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

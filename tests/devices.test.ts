import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";
process.env.JWT_SECRET = "test-jwt-secret-123";
process.env.JWT_ADMIN_SECRET = "test-admin-secret-123";
process.env.COOKIE_SECRET = "test-cookie-secret-123456789012345";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD_HASH = `$2b$12$${"a".repeat(53)}`;
process.env.NOTIFICATIONS_ENABLED = "false";
// Hermetic: a path that does not exist, so initFirebase() can never load real credentials
// (even if a developer's .env defines GOOGLE_APPLICATION_CREDENTIALS).
process.env.GOOGLE_APPLICATION_CREDENTIALS = "./does-not-exist-service-account.json";

const { turso } = await import("../src/config/db.js");
const notifications = await import("../src/services/notifications.js");
const firebase = await import("../src/services/firebase.js");
const { RegisterDeviceSchema, UnregisterDeviceSchema } = await import(
  "../src/schemas/api/devices.js"
);
const { default: Fastify } = await import("fastify");
const { default: userAuth } = await import("../src/plugins/user-auth.js");
const { default: deviceRoutes } = await import(
  "../src/routes/api/v1/devices.js"
);
const { signUserToken } = await import("../src/services/api-auth.js");

import type { Message } from "firebase-admin/messaging";
import type { MessagingClient } from "../src/services/firebase.js";

const USER_ID = "11111111-1111-7111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-7222-8222-222222222222";
const NOW = "2026-06-20T00:00:00.000Z";

const silentLogger = { info() {}, warn() {}, error() {} };

type Outcome = { ok: true } | { ok: false; code: string };

/** Fake of the one Admin SDK method we use. Records every batch it receives. */
const fakeClient = (
  decide: (message: Message) => Outcome = () => ({ ok: true })
): { client: MessagingClient; batches: Message[][] } => {
  const batches: Message[][] = [];
  const client: MessagingClient = {
    sendEach: async (messages) => {
      batches.push(messages);
      return {
        responses: messages.map((message) => {
          const outcome = decide(message);
          return outcome.ok
            ? { success: true }
            : { success: false, error: { code: outcome.code } };
        }),
      };
    },
  };
  return { client, batches };
};

const targetOf = (message: Message): string =>
  "fid" in message
    ? String(message.fid)
    : "token" in message
      ? String(message.token)
      : "";

const insertUser = async (id: string): Promise<void> => {
  await turso.execute({
    sql: `INSERT INTO users
          (id, email, password_hash, timezone, is_admin, created_at, updated_at, deleted_at)
          VALUES (?, ?, 'test-hash', 'Asia/Ho_Chi_Minh', 0, ?, ?, NULL)`,
    args: [id, `${id}@test.local`, NOW, NOW],
  });
};

const rowsFor = async (
  userId: string
): Promise<Array<{ registration_id: string; kind: string }>> => {
  const res = await turso.execute({
    sql: "SELECT registration_id, kind FROM user_devices WHERE user_id = ? ORDER BY registration_id ASC",
    args: [userId],
  });
  return res.rows as unknown as Array<{ registration_id: string; kind: string }>;
};

const registered = async (userId: string): Promise<string[]> =>
  (await rowsFor(userId)).map((row) => row.registration_id);

const register = (
  userId: string,
  registrationId: string,
  kind: "fid" | "token" = "token"
) =>
  notifications.registerDevice(userId, {
    registrationId,
    kind,
    platform: "android",
  });

const input = {
  title: "Xin chào",
  body: "Nội dung",
  data: { type: "test", id: "abc-123", extra: "1" },
};

const app = Fastify();

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
      kind TEXT NOT NULL DEFAULT 'token' CHECK (kind IN ('fid', 'token')),
      platform TEXT NOT NULL DEFAULT 'android' CHECK (platform IN ('android')),
      last_seen_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await turso.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_devices_user_token
      ON user_devices(user_id, registration_id)
  `);

  await app.register(userAuth);
  await app.register(deviceRoutes, { prefix: "/devices" });
  await app.ready();
});

after(async () => {
  await app.close();
});

beforeEach(async () => {
  await turso.execute("DELETE FROM user_devices");
  await turso.execute("DELETE FROM users");
  await insertUser(USER_ID);
  await insertUser(OTHER_USER_ID);
  firebase.setMessagingClientForTests(null);
  firebase.setPushLogger(silentLogger);
});

// ── input validation ─────────────────────────────────────────────────────────

test("RegisterDeviceSchema accepts fid/token on android and rejects anything else", () => {
  assert.ok(
    RegisterDeviceSchema.safeParse({
      registrationId: "  abc  ",
      kind: "fid",
      platform: "android",
    }).success
  );
  assert.equal(
    RegisterDeviceSchema.parse({
      registrationId: "  abc  ",
      kind: "token",
      platform: "android",
    }).registrationId,
    "abc"
  );

  for (const bad of [
    { registrationId: "abc", kind: "apns", platform: "android" },
    { registrationId: "abc", kind: "fid", platform: "ios" },
    { registrationId: "   ", kind: "fid", platform: "android" },
    { registrationId: "abc", platform: "android" },
    { registrationId: "x".repeat(4097), kind: "token", platform: "android" },
  ]) {
    assert.equal(RegisterDeviceSchema.safeParse(bad).success, false);
  }
  assert.equal(UnregisterDeviceSchema.safeParse({}).success, false);
});

// ── device registration ──────────────────────────────────────────────────────

test("registerDevice upserts one row per (user, registration) and bumps last_seen_at", async () => {
  const first = await register(USER_ID, "reg-1", "token");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await register(USER_ID, "reg-1", "fid");

  assert.equal(first.id, second.id);
  assert.equal(first.created_at, second.created_at);
  assert.ok(second.last_seen_at > first.last_seen_at);
  assert.equal(second.kind, "fid");
  assert.equal(second.platform, "android");
  assert.deepEqual(await rowsFor(USER_ID), [
    { registration_id: "reg-1", kind: "fid" },
  ]);
});

test("registerDevice moves a registration to the user who registers it last", async () => {
  await register(OTHER_USER_ID, "shared");
  await register(USER_ID, "shared");

  assert.deepEqual(await registered(USER_ID), ["shared"]);
  assert.deepEqual(await registered(OTHER_USER_ID), []);
});

test("registerDevice rejects unknown users and blank ids", async () => {
  await assert.rejects(
    register("99999999-9999-7999-8999-999999999999", "reg-1"),
    { code: "not_found" }
  );
  await assert.rejects(register(USER_ID, "   "), { code: "bad_input" });
});

test("legacy registerToken stores a token-kind android device", async () => {
  await notifications.registerToken(USER_ID, "legacy");
  assert.deepEqual(await rowsFor(USER_ID), [
    { registration_id: "legacy", kind: "token" },
  ]);
});

test("unregisterDevice only deletes the caller's own registration and is idempotent", async () => {
  await register(USER_ID, "mine");
  await register(OTHER_USER_ID, "theirs");

  assert.equal(await notifications.unregisterDevice(USER_ID, "theirs"), 0);
  assert.deepEqual(await registered(OTHER_USER_ID), ["theirs"]);

  assert.equal(await notifications.unregisterDevice(USER_ID, "mine"), 1);
  assert.equal(await notifications.unregisterDevice(USER_ID, "mine"), 0);
  assert.deepEqual(await registered(USER_ID), []);
});

// ── notifyUser: message shape ────────────────────────────────────────────────

test("notifyUser targets fid devices with `fid` and token devices with `token`, with Android config", async () => {
  await register(USER_ID, "fid-device", "fid");
  await register(USER_ID, "token-device", "token");
  const { client, batches } = fakeClient();
  firebase.setMessagingClientForTests(client);

  const result = await notifications.notifyUser(USER_ID, input);

  assert.deepEqual(result, { devices: 2, sent: 2, failed: 0, removed: 0 });
  assert.equal(batches.length, 1);
  const byTarget = new Map(batches[0].map((m) => [targetOf(m), m]));

  const fidMessage = byTarget.get("fid-device") as Record<string, unknown>;
  assert.equal(fidMessage.fid, "fid-device");
  assert.equal("token" in fidMessage, false);

  const tokenMessage = byTarget.get("token-device") as Record<string, unknown>;
  assert.equal(tokenMessage.token, "token-device");
  assert.equal("fid" in tokenMessage, false);

  for (const message of batches[0]) {
    assert.deepEqual(message.notification, { title: "Xin chào", body: "Nội dung" });
    assert.deepEqual(message.data, { type: "test", id: "abc-123", extra: "1" });
    assert.equal(message.android?.priority, "high");
    assert.equal(message.android?.notification?.channelId, "general_notifications");
  }
});

test("notifyUser sends in batches of at most 500 messages", async () => {
  const statements = Array.from({ length: 501 }, (_, i) => ({
    sql: `INSERT INTO user_devices
          (id, user_id, registration_id, kind, platform, last_seen_at, created_at, updated_at)
          VALUES (?, ?, ?, 'token', 'android', ?, ?, ?)`,
    args: [`id-${i}`, USER_ID, `reg-${i}`, NOW, NOW, NOW],
  }));
  await turso.batch(statements, "write");
  const { client, batches } = fakeClient();
  firebase.setMessagingClientForTests(client);

  const result = await notifications.notifyUser(USER_ID, input);

  assert.deepEqual(batches.map((batch) => batch.length), [500, 1]);
  assert.equal(result.sent, 501);
});

// ── notifyUser: error handling ───────────────────────────────────────────────

test("dead registrations (UNREGISTERED for token and fid, INVALID_ARGUMENT) are deleted", async () => {
  await register(USER_ID, "ok-device", "token");
  await register(USER_ID, "gone-token", "token");
  await register(USER_ID, "gone-fid", "fid");
  await register(USER_ID, "bad-arg", "token");
  const codes: Record<string, string> = {
    "gone-token": "messaging/registration-token-not-registered",
    "gone-fid": "messaging/installation-id-not-registered",
    "bad-arg": "messaging/invalid-argument",
  };
  const { client } = fakeClient((message) => {
    const code = codes[targetOf(message)];
    return code ? { ok: false, code } : { ok: true };
  });
  firebase.setMessagingClientForTests(client);

  const result = await notifications.notifyUser(USER_ID, input);

  assert.deepEqual(result, { devices: 4, sent: 1, failed: 3, removed: 3 });
  assert.deepEqual(await registered(USER_ID), ["ok-device"]);
});

test("transient and configuration errors never delete a device", async () => {
  const codes = [
    "messaging/server-unavailable",
    "messaging/internal-error",
    "messaging/message-rate-exceeded",
    "messaging/device-message-rate-exceeded",
    "messaging/authentication-error",
    "messaging/third-party-auth-error",
    "messaging/mismatched-credential",
    "messaging/unknown-error",
  ];
  for (const code of codes) await register(USER_ID, `dev-${code}`);
  const { client } = fakeClient((message) => ({
    ok: false,
    code: targetOf(message).slice("dev-".length),
  }));
  firebase.setMessagingClientForTests(client);

  const result = await notifications.notifyUser(USER_ID, input);

  assert.equal(result.devices, codes.length);
  assert.equal(result.failed, codes.length);
  assert.equal(result.removed, 0);
  assert.equal((await registered(USER_ID)).length, codes.length);
});

test("an invalid payload is rejected before sending and deletes nothing", async () => {
  await register(USER_ID, "dev");
  const { client, batches } = fakeClient();
  firebase.setMessagingClientForTests(client);

  const bad = [
    { ...input, title: "  " },
    { ...input, data: { type: "t", id: "1", from: "x" } },
    { ...input, data: { type: "t", id: "1", "gcm.foo": "x" } },
    { ...input, data: { type: "t", id: "1", "google.bar": "x" } },
    { ...input, data: { type: "t", id: "1", n: 5 as unknown as string } },
    { ...input, body: "x".repeat(5000) },
    { ...input, data: { type: "", id: "1" } },
    { ...input, data: { type: "t", id: "" } },
  ];
  for (const payload of bad) {
    const result = await notifications.notifyUser(USER_ID, payload);
    assert.ok(result.error, `expected an error for ${JSON.stringify(payload).slice(0, 60)}`);
    assert.equal(result.sent, 0);
  }
  assert.equal(batches.length, 0);
  assert.deepEqual(await registered(USER_ID), ["dev"]);
});

test("notifyUser never throws: SDK failure is reported and devices are kept", async () => {
  await register(USER_ID, "dev");
  firebase.setMessagingClientForTests({
    sendEach: async () => {
      throw new Error("network down");
    },
  });

  const result = await notifications.notifyUser(USER_ID, input);

  assert.equal(result.sent, 0);
  assert.match(result.error ?? "", /network down/);
  assert.deepEqual(await registered(USER_ID), ["dev"]);

  // The fire-and-forget variant must also be safe to call without awaiting.
  assert.doesNotThrow(() => notifications.notifyUserInBackground(USER_ID, input));
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test("notifyUser with no devices does not call the SDK", async () => {
  const { client, batches } = fakeClient();
  firebase.setMessagingClientForTests(client);

  const result = await notifications.notifyUser(USER_ID, input);

  assert.deepEqual(result, { devices: 0, sent: 0, failed: 0, removed: 0 });
  assert.equal(batches.length, 0);
});

test("without Firebase credentials push is a reported no-op that keeps devices", async () => {
  await register(USER_ID, "dev");
  const warnings: string[] = [];
  const ready = await firebase.initFirebase({
    ...silentLogger,
    warn: (_obj, msg) => warnings.push(msg),
  });

  assert.equal(ready, false);
  assert.equal(firebase.isPushConfigured(), false);
  assert.ok(warnings.some((msg) => /push notifications are disabled/.test(msg)));

  const result = await notifications.notifyUser(USER_ID, input);
  assert.deepEqual(result, { devices: 1, sent: 0, failed: 1, removed: 0 });
  assert.deepEqual(await registered(USER_ID), ["dev"]);
});

// ── stale-device cleanup ─────────────────────────────────────────────────────

test("cleanupStaleDevices removes only registrations unseen for more than 30 days", async () => {
  await register(USER_ID, "old");
  await register(USER_ID, "recent");
  await turso.execute({
    sql: "UPDATE user_devices SET last_seen_at = ? WHERE registration_id = 'old'",
    args: ["2026-05-30T00:00:00.000Z"], // 32 days before `now`
  });
  await turso.execute({
    sql: "UPDATE user_devices SET last_seen_at = ? WHERE registration_id = 'recent'",
    args: ["2026-06-10T00:00:00.000Z"], // 21 days before `now`
  });
  const now = new Date("2026-07-01T00:00:00.000Z");

  const dry = await notifications.cleanupStaleDevices(30, { dryRun: true, now });
  assert.equal(dry.count, 1);
  assert.deepEqual(await registered(USER_ID), ["old", "recent"]);

  const real = await notifications.cleanupStaleDevices(30, { now });
  assert.equal(real.count, 1);
  assert.deepEqual(await registered(USER_ID), ["recent"]);

  await assert.rejects(notifications.cleanupStaleDevices(0), { code: "bad_input" });
  await assert.rejects(notifications.cleanupStaleDevices(Number.NaN), {
    code: "bad_input",
  });
});

// ── HTTP: authentication reuse + validation ──────────────────────────────────

test("POST/DELETE /devices require a user JWT, validate input and act on the caller only", async () => {
  const token = signUserToken(app, USER_ID);
  const auth = { authorization: `Bearer ${token}` };

  const anon = await app.inject({
    method: "POST",
    url: "/devices",
    payload: { registrationId: "r", kind: "token", platform: "android" },
  });
  assert.equal(anon.statusCode, 401);

  for (const payload of [
    { registrationId: "r", kind: "apns", platform: "android" },
    { registrationId: "r", kind: "fid", platform: "ios" },
    {},
  ]) {
    const res = await app.inject({
      method: "POST",
      url: "/devices",
      headers: auth,
      payload,
    });
    assert.equal(res.statusCode, 400);
  }

  const created = await app.inject({
    method: "POST",
    url: "/devices",
    headers: auth,
    payload: { registrationId: "http-reg", kind: "fid", platform: "android" },
  });
  assert.equal(created.statusCode, 200);
  const body = created.json();
  assert.equal(body.ok, true);
  assert.ok(body.device_id);
  assert.ok(body.last_seen_at);
  assert.deepEqual(await rowsFor(USER_ID), [
    { registration_id: "http-reg", kind: "fid" },
  ]);

  // Another user's token cannot remove this registration.
  const otherAuth = { authorization: `Bearer ${signUserToken(app, OTHER_USER_ID)}` };
  const foreign = await app.inject({
    method: "DELETE",
    url: "/devices",
    headers: otherAuth,
    payload: { registrationId: "http-reg" },
  });
  assert.equal(foreign.statusCode, 200);
  assert.equal(foreign.json().deleted, 0);
  assert.deepEqual(await registered(USER_ID), ["http-reg"]);

  const missingBody = await app.inject({
    method: "DELETE",
    url: "/devices",
    headers: auth,
  });
  assert.equal(missingBody.statusCode, 400);

  const removed = await app.inject({
    method: "DELETE",
    url: "/devices",
    headers: auth,
    payload: { registrationId: "http-reg" },
  });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.json(), { ok: true, deleted: 1 });
  assert.deepEqual(await registered(USER_ID), []);
});

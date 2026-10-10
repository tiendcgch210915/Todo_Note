import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";
process.env.JWT_SECRET = "test-jwt-secret-123";
process.env.JWT_ADMIN_SECRET = "test-admin-secret-123";
process.env.COOKIE_SECRET = "test-cookie-secret-123456789012345";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD_HASH = `$2b$12$${"a".repeat(53)}`;
// Hermetic: initFirebase() can never load real credentials.
process.env.GOOGLE_APPLICATION_CREDENTIALS = "./does-not-exist-service-account.json";

const { turso } = await import("../src/config/db.js");
const firebase = await import("../src/services/firebase.js");
const notifications = await import("../src/services/notifications.js");
const jobsRepo = await import("../src/repositories/notification-jobs.js");
const { default: Fastify } = await import("fastify");
const { default: userAuth } = await import("../src/plugins/user-auth.js");
const { default: deviceRoutes } = await import("../src/routes/api/v1/devices.js");
const { signUserToken } = await import("../src/services/api-auth.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID, OTHER_USER_ID } = fx;
const app = Fastify();

before(async () => {
  await applyAllMigrations(turso);
  await app.register(userAuth);
  await app.register(deviceRoutes, { prefix: "/devices" });
  await app.ready();
});

after(async () => {
  await app.close();
});

beforeEach(async () => {
  for (const table of ["notification_jobs", "todo_timers", "user_devices"]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await turso.execute("UPDATE todos SET parent_id = NULL, trigger_after_todo_id = NULL");
  await turso.execute("DELETE FROM todos");
  await turso.execute(`DELETE FROM users WHERE id IN ('${USER_ID}', '${OTHER_USER_ID}')`);
  await fx.insertUser(turso, USER_ID);
  await fx.insertUser(turso, OTHER_USER_ID);
  firebase.setMessagingClientForTests(null);
  firebase.setPushLogger(fx.silentLogger);
});

const deviceRows = async (userId: string) => {
  const res = await turso.execute({
    sql: "SELECT id, registration_id, kind FROM user_devices WHERE user_id = ? ORDER BY registration_id",
    args: [userId],
  });
  return res.rows as unknown as Array<{ id: string; registration_id: string; kind: string }>;
};

const targetedJob = (refId: string, deviceId: string, userId = USER_ID) =>
  jobsRepo.upsertEventJob({
    userId,
    kind: "todo_timer_end",
    refId,
    runAt: "2030-01-01T00:00:00.000Z",
    targetDeviceId: deviceId,
  });

const statusOfJob = async (refId: string, userId = USER_ID) =>
  (await jobsRepo.getEventJob(userId, "todo_timer_end", refId))?.status;

// ── previousRegistrationId (FID/token rotation) ──────────────────────────────

test("previousRegistrationId renames the row in place: same id, jobs still point at it", async () => {
  const before = await notifications.registerDevice(USER_ID, {
    registrationId: "old-fid",
    kind: "fid",
    platform: "android",
  });
  await targetedJob("todo-1", before.id);

  const after = await notifications.registerDevice(USER_ID, {
    registrationId: "new-fid",
    kind: "fid",
    platform: "android",
    previousRegistrationId: "old-fid",
  });

  assert.equal(after.id, before.id, "the stable device id survives rotation");
  assert.deepEqual(
    (await deviceRows(USER_ID)).map((r) => [r.id, r.registration_id]),
    [[before.id, "new-fid"]]
  );
  const job = await jobsRepo.getEventJob(USER_ID, "todo_timer_end", "todo-1");
  assert.equal(job?.status, "pending");
  assert.equal(job?.target_device_id, before.id);
});

test("rotating kind together with the id (token -> fid) updates the row too", async () => {
  const before = await notifications.registerToken(USER_ID, "old-token");
  const after = await notifications.registerDevice(USER_ID, {
    registrationId: "brand-new-fid",
    kind: "fid",
    platform: "android",
    previousRegistrationId: "old-token",
  });
  assert.equal(after.id, before.id);
  assert.equal(after.kind, "fid");
  assert.equal((await deviceRows(USER_ID)).length, 1);
});

test("if the new registration already exists, the old row is merged away and jobs/timers re-point", async () => {
  const oldRow = await notifications.registerDevice(USER_ID, { registrationId: "old", kind: "token", platform: "android" });
  const newRow = await notifications.registerDevice(USER_ID, { registrationId: "new", kind: "token", platform: "android" });
  await fx.insertTodo(turso, { id: "todo-1", scheduledDate: "2030-01-01" });
  await targetedJob("todo-1", oldRow.id);
  await turso.execute({
    sql: `INSERT INTO todo_timers (todo_id, user_id, status, device_id, updated_at)
          VALUES ('todo-1', ?, 'running', ?, '2026-06-20T00:00:00.000Z')`,
    args: [USER_ID, oldRow.id],
  });

  const result = await notifications.registerDevice(USER_ID, {
    registrationId: "new",
    kind: "token",
    platform: "android",
    previousRegistrationId: "old",
  });

  assert.equal(result.id, newRow.id);
  assert.deepEqual((await deviceRows(USER_ID)).map((r) => r.registration_id), ["new"]);
  const job = await jobsRepo.getEventJob(USER_ID, "todo_timer_end", "todo-1");
  assert.equal(job?.target_device_id, newRow.id);
  assert.equal(job?.status, "pending");
  const timer = await turso.execute("SELECT device_id FROM todo_timers WHERE todo_id = 'todo-1'");
  assert.equal((timer.rows[0] as unknown as { device_id: string }).device_id, newRow.id);
});

test("an unknown, identical or foreign previousRegistrationId is ignored and reveals nothing", async () => {
  const theirs = await notifications.registerDevice(OTHER_USER_ID, { registrationId: "theirs", kind: "token", platform: "android" });

  const viaForeign = await notifications.registerDevice(USER_ID, {
    registrationId: "mine",
    kind: "token",
    platform: "android",
    previousRegistrationId: "theirs",
  });
  assert.notEqual(viaForeign.id, theirs.id);
  assert.deepEqual((await deviceRows(OTHER_USER_ID)).map((r) => r.registration_id), ["theirs"]);
  assert.deepEqual((await deviceRows(USER_ID)).map((r) => r.registration_id), ["mine"]);

  const viaUnknown = await notifications.registerDevice(USER_ID, {
    registrationId: "mine-2",
    kind: "token",
    platform: "android",
    previousRegistrationId: "never-existed",
  });
  assert.equal(viaUnknown.registration_id, "mine-2");

  const viaSame = await notifications.registerDevice(USER_ID, {
    registrationId: "mine-2",
    kind: "token",
    platform: "android",
    previousRegistrationId: "mine-2",
  });
  assert.equal(viaSame.id, viaUnknown.id);
  assert.deepEqual((await deviceRows(USER_ID)).map((r) => r.registration_id), ["mine", "mine-2"]);
});

test("POST /devices accepts previousRegistrationId (same device_id comes back) and rejects a blank one", async () => {
  const auth = { authorization: `Bearer ${signUserToken(app, USER_ID)}` };
  const first = await app.inject({
    method: "POST",
    url: "/devices",
    headers: auth,
    payload: { registrationId: "http-old", kind: "fid", platform: "android" },
  });
  const rotated = await app.inject({
    method: "POST",
    url: "/devices",
    headers: auth,
    payload: { registrationId: "http-new", kind: "fid", platform: "android", previousRegistrationId: "http-old" },
  });
  assert.equal(rotated.statusCode, 200);
  assert.equal(rotated.json().device_id, first.json().device_id);
  assert.deepEqual((await deviceRows(USER_ID)).map((r) => r.registration_id), ["http-new"]);

  const blank = await app.inject({
    method: "POST",
    url: "/devices",
    headers: auth,
    payload: { registrationId: "x", kind: "fid", platform: "android", previousRegistrationId: "   " },
  });
  assert.equal(blank.statusCode, 400);
});

// ── jobs aimed at a device die with the device ───────────────────────────────

test("signing a device out cancels only the jobs aimed at it", async () => {
  const a = await notifications.registerToken(USER_ID, "reg-a");
  const b = await notifications.registerToken(USER_ID, "reg-b");
  await targetedJob("for-a", a.id);
  await targetedJob("for-b", b.id);

  await notifications.unregisterDevice(USER_ID, "reg-a");

  assert.equal(await statusOfJob("for-a"), "cancelled");
  assert.equal(await statusOfJob("for-b"), "pending");
});

test("moving a registration to another account cancels the previous owner's jobs aimed at it", async () => {
  const theirs = await notifications.registerToken(OTHER_USER_ID, "shared");
  await targetedJob("their-todo", theirs.id, OTHER_USER_ID);

  await notifications.registerToken(USER_ID, "shared");

  assert.equal(await statusOfJob("their-todo", OTHER_USER_ID), "cancelled");
  assert.equal((await deviceRows(OTHER_USER_ID)).length, 0);
});

test("cleaning up stale devices and FCM-reported dead devices also cancels their jobs", async () => {
  const stale = await notifications.registerToken(USER_ID, "stale");
  await turso.execute({
    sql: "UPDATE user_devices SET last_seen_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    args: [stale.id],
  });
  const dead = await notifications.registerToken(USER_ID, "dead");
  const fresh = await notifications.registerToken(USER_ID, "fresh");
  await targetedJob("for-stale", stale.id);
  await targetedJob("for-dead", dead.id);
  await targetedJob("for-fresh", fresh.id);

  await notifications.cleanupStaleDevices(30);
  assert.equal(await statusOfJob("for-stale"), "cancelled");

  const fake = fx.fakeMessaging((message) => {
    const m = message as { token?: string };
    return m.token === "dead"
      ? { ok: false, code: "messaging/registration-token-not-registered" }
      : { ok: true };
  });
  firebase.setMessagingClientForTests(fake.client);
  await notifications.notifyUser(USER_ID, {
    title: "Xin chào",
    body: "Nội dung",
    data: { type: "test", id: "abc" },
  });
  assert.equal(await statusOfJob("for-dead"), "cancelled");
  assert.equal(await statusOfJob("for-fresh"), "pending");
});

test("notifyUser aimed at one device never reaches the others, even if that device is gone", async () => {
  const a = await notifications.registerToken(USER_ID, "reg-a");
  await notifications.registerToken(USER_ID, "reg-b");
  const fake = fx.fakeMessaging();
  firebase.setMessagingClientForTests(fake.client);
  const payload = { title: "T", body: "B", data: { type: "t", id: "1" } };

  await notifications.notifyUser(USER_ID, payload, {
    targetDeviceId: a.id,
    channelId: "todo_timer",
    ttlMs: 900_000,
  });
  assert.deepEqual(fake.targets(), ["reg-a"]);
  assert.equal(fake.messages[0].android?.ttl, 900_000);
  assert.equal(fake.messages[0].android?.notification?.channelId, "todo_timer");

  fake.messages.length = 0;
  const result = await notifications.notifyUser(USER_ID, payload, { targetDeviceId: "no-such-device" });
  assert.equal(result.devices, 0);
  assert.equal(fake.messages.length, 0, "no fallback to the remaining device");

  fake.messages.length = 0;
  await notifications.notifyUser(USER_ID, payload);
  assert.deepEqual(fake.targets().sort(), ["reg-a", "reg-b"]);
  assert.equal(fake.messages[0].android?.ttl, undefined, "no ttl unless asked for");
  assert.equal(fake.messages[0].android?.notification?.channelId, "general_notifications");
});

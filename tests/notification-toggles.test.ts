import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";
process.env.JWT_SECRET = "test-jwt-secret-123";
process.env.JWT_ADMIN_SECRET = "test-admin-secret-123";
process.env.COOKIE_SECRET = "test-cookie-secret-123456789012345";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD_HASH = `$2b$12$${"a".repeat(53)}`;
process.env.GOOGLE_APPLICATION_CREDENTIALS = "./does-not-exist-service-account.json";

const { turso } = await import("../src/config/db.js");
const firebase = await import("../src/services/firebase.js");
const { runDispatch, runMaintenance } = await import("../src/services/notification-tick.js");
const planner = await import("../src/services/notification-planner.js");
const { DIGEST_GROUP, DIGEST_KINDS } = await import("../src/config/notification-policy.js");
const { default: Fastify } = await import("fastify");
const { default: userAuth } = await import("../src/plugins/user-auth.js");
const { default: notificationSettingsRoutes } = await import(
  "../src/routes/api/v1/notification-settings.js"
);
const { signUserToken } = await import("../src/services/api-auth.js");
const { localDateTimeToUtc } = await import("../src/utils/time.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID } = fx;
const VN = "Asia/Ho_Chi_Minh";
const TODAY = "2026-06-20";

const at = (date: string, hhmm: string, seconds = 0): Date =>
  new Date(localDateTimeToUtc(date, hhmm, VN).getTime() + seconds * 1000);

let fake = fx.fakeMessaging();
const app = Fastify();

before(async () => {
  await applyAllMigrations(turso);
  await app.register(userAuth);
  await app.register(notificationSettingsRoutes, { prefix: "/notification-settings" });
  await app.ready();
});

after(async () => {
  await app.close();
});

beforeEach(async () => {
  await turso.execute("DELETE FROM notification_jobs");
  await turso.execute("DELETE FROM notification_settings");
  await turso.execute("DELETE FROM user_devices");
  await turso.execute(`DELETE FROM users WHERE id = '${USER_ID}'`);
  await fx.insertUser(turso, USER_ID);

  fake = fx.fakeMessaging();
  firebase.setMessagingClientForTests(fake.client);
  firebase.setPushLogger(fx.silentLogger);
});

const auth = () => ({ authorization: `Bearer ${signUserToken(app, USER_ID)}` });
const get = () => app.inject({ method: "GET", url: "/notification-settings", headers: auth() });
const put = (payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: "/notification-settings", headers: auth(), payload });
const base = { morningTime: "07:00", eveningTime: "17:00", timezone: VN };

/** Ghi thẳng dòng cài đặt (không qua PUT, vì PUT lập lịch theo giờ thật của máy). */
const seedSettings = (flags: { morning?: number; evening?: number; review?: number }) =>
  turso.execute({
    sql: `INSERT INTO notification_settings
          (user_id, morning_enabled, evening_enabled, review_enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      USER_ID,
      flags.morning ?? 1,
      flags.evening ?? 1,
      flags.review ?? 1,
      "2026-06-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
    ],
  });

const plannedKinds = async (): Promise<string[]> =>
  [...new Set((await fx.jobsFor(turso, USER_ID, "AND kind LIKE 'digest_%'")).map((j) => j.kind as string))].sort();

// ── API ──────────────────────────────────────────────────────────────────────

test("every digest belongs to a group", () => {
  for (const kind of DIGEST_KINDS) assert.ok(DIGEST_GROUP[kind], kind);
});

test("GET: all three are on by default", async () => {
  const body = (await get()).json();
  assert.deepEqual(
    [body.morningEnabled, body.eveningEnabled, body.reviewEnabled],
    [true, true, true]
  );
});

test("PUT saves each switch and GET returns it; the times are kept while off", async () => {
  const res = await put({
    ...base,
    reviewTime: "22:00",
    morningEnabled: false,
    eveningEnabled: true,
    reviewEnabled: false,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    [res.json().morningEnabled, res.json().eveningEnabled, res.json().reviewEnabled],
    [false, true, false]
  );

  const again = (await get()).json();
  assert.deepEqual(
    [again.morningEnabled, again.eveningEnabled, again.reviewEnabled],
    [false, true, false]
  );
  assert.equal(again.morningTime, "07:00");
  assert.equal(again.reviewTime, "22:00");
});

test("PUT without the switches (an older app) keeps what was stored", async () => {
  await put({ ...base, morningEnabled: false, eveningEnabled: false, reviewEnabled: false });

  const res = await put({ ...base, morningTime: "06:30" });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().morningTime, "06:30");
  assert.deepEqual(
    [res.json().morningEnabled, res.json().eveningEnabled, res.json().reviewEnabled],
    [false, false, false]
  );
});

test("a single switch can be changed on its own", async () => {
  await put({ ...base, morningEnabled: false, eveningEnabled: false });

  const res = await put({ ...base, eveningEnabled: true });

  assert.deepEqual(
    [res.json().morningEnabled, res.json().eveningEnabled, res.json().reviewEnabled],
    [false, true, true]
  );
});

test("the switches must be booleans", async () => {
  for (const value of ["false", 0, 1, null]) {
    const res = await put({ ...base, morningEnabled: value });
    assert.equal(res.statusCode, 400, JSON.stringify(value));
    assert.equal(res.json().error, "bad_input");
  }
});

// ── planner ──────────────────────────────────────────────────────────────────

const ALL = [
  "digest_habits",
  "digest_morning",
  "digest_overdue_evening",
  "digest_overdue_morning",
  "digest_review",
  "digest_todos",
];

test("with everything on, all six digests are planned (unchanged behaviour)", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await planner.planAllUsers(at(TODAY, "06:00"));
  assert.deepEqual(await plannedKinds(), ALL);
});

test("each switch removes only its own digests", async () => {
  const cases: Array<[{ morning?: number; evening?: number; review?: number }, string[]]> = [
    [{ morning: 0 }, ["digest_overdue_morning", "digest_morning"]],
    [{ evening: 0 }, ["digest_habits", "digest_overdue_evening", "digest_todos"]],
    [{ review: 0 }, ["digest_review"]],
  ];
  for (const [flags, removed] of cases) {
    await turso.execute("DELETE FROM notification_jobs");
    await turso.execute("DELETE FROM notification_settings");
    await turso.execute("DELETE FROM user_devices");
    await fx.insertDevice(turso, USER_ID, "reg-A");
    await seedSettings(flags);

    await planner.planAllUsers(at(TODAY, "06:00"));

    assert.deepEqual(await plannedKinds(), ALL.filter((kind) => !removed.includes(kind)), JSON.stringify(flags));
  }
});

test("with all three off nothing daily is planned", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await seedSettings({ morning: 0, evening: 0, review: 0 });

  await planner.planAllUsers(at(TODAY, "06:00"));

  assert.deepEqual(await plannedKinds(), []);
});

test("switching a group back on plans its digests again", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await put({ ...base, morningEnabled: false, eveningEnabled: false, reviewEnabled: false });
  await turso.execute("DELETE FROM notification_jobs");

  await put({ ...base, reviewEnabled: true });

  assert.deepEqual(await plannedKinds(), ["digest_review"]);
});

// ── sending ──────────────────────────────────────────────────────────────────

const arm = async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await runMaintenance({ now: at(TODAY, "21:00"), logger: fx.silentLogger });
};
const reviews = () => fake.messages.filter((m) => m.data?.type === "digest_review");
const reviewJob = async () =>
  (await fx.jobsFor(turso, USER_ID, "AND kind = 'digest_review'")).find((job) => job.local_date === TODAY);

test("turning a group off after its job was planned cancels the push instead of sending it", async () => {
  await arm();
  assert.equal((await reviewJob())?.status, "pending");

  const res = await put({ ...base, reviewEnabled: false });
  assert.equal(res.statusCode, 200);
  await runDispatch({ now: at(TODAY, "21:30", 10), logger: fx.silentLogger });

  assert.equal(reviews().length, 0);
  assert.equal((await reviewJob())?.status, "cancelled");
});

test("turning it off and on again before the time still delivers it", async () => {
  await arm();

  await put({ ...base, reviewEnabled: false });
  await put({ ...base, reviewEnabled: true });
  await runDispatch({ now: at(TODAY, "21:30", 10), logger: fx.silentLogger });

  assert.equal(reviews().length, 1);
  assert.equal((await reviewJob())?.status, "sent");
});

test("the other groups keep sending when only one is off", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await runMaintenance({ now: at(TODAY, "06:00"), logger: fx.silentLogger });
  await put({ ...base, reviewEnabled: false });

  await runDispatch({ now: at(TODAY, "07:00", 10), logger: fx.silentLogger });
  await runDispatch({ now: at(TODAY, "21:30", 10), logger: fx.silentLogger });

  const types = fake.messages.map((m) => m.data?.type);
  assert.ok(types.includes("digest_morning"), "morning still goes out");
  assert.equal(reviews().length, 0);
});

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
const content = await import("../src/services/notification-content.js");
const { UpdateNotificationSettingsSchema } = await import("../src/schemas/api/notification-settings.js");
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
const TOMORROW = "2026-06-21";

const at = (date: string, hhmm: string, seconds = 0): Date =>
  new Date(localDateTimeToUtc(date, hhmm, VN).getTime() + seconds * 1000);
const runAtVn = (date: string, hhmm: string): string => at(date, hhmm).toISOString();

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
  for (const table of [
    "notification_jobs",
    "notification_settings",
    "user_devices",
    "habit_logs",
    "habits",
    "daily_todo_logs",
    "daily_todo_summaries",
    "todo_tags",
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await turso.execute("UPDATE todos SET parent_id = NULL, trigger_after_todo_id = NULL, recurrence_template_id = NULL");
  await turso.execute("DELETE FROM todos");
  await turso.execute(`DELETE FROM users WHERE id = '${USER_ID}'`);
  await fx.insertUser(turso, USER_ID);

  fake = fx.fakeMessaging();
  firebase.setMessagingClientForTests(fake.client);
  firebase.setPushLogger(fx.silentLogger);
});

const stats = (t: number, done: number, h: number, x: number) => ({
  totalTodos: t,
  doneTodos: done,
  habitsTotal: h,
  habitsDone: x,
});

// ── content ──────────────────────────────────────────────────────────────────

test("review text: the counts line and a short call to review and plan tomorrow", () => {
  const text = content.buildReviewDigest(stats(5, 3, 3, 2));
  assert.equal(text.title, "Rà soát cuối ngày");
  assert.equal(
    text.body,
    [
      "📋 Hôm nay: 3/5 todo xong · 2/3 thói quen",
      "🌙 Rà lại phần chưa xong & lên kế hoạch cho ngày mai để tiến bộ hơn nhé!",
    ].join("\n")
  );
});

test("review text: everything done is congratulated, an empty day is still a prompt", () => {
  assert.equal(
    content.buildReviewDigest(stats(4, 4, 2, 2)).body,
    ["📋 Hôm nay: 4/4 todo xong · 2/2 thói quen", "🌙 Tuyệt vời! Lên kế hoạch cho ngày mai để tiến bộ hơn nữa nhé!"].join("\n")
  );
  assert.equal(
    content.buildReviewDigest(stats(0, 0, 0, 0)).body,
    "🌙 Hôm nay chưa có todo hay thói quen. Lên kế hoạch cho ngày mai nhé!",
    "no counts line when there is nothing to count"
  );
});

test("review text: parts that do not exist are left out", () => {
  const onlyTodos = content.buildReviewDigest(stats(3, 1, 0, 0)).body.split("\n");
  assert.equal(onlyTodos[0], "📋 Hôm nay: 1/3 todo xong");
  const onlyHabits = content.buildReviewDigest(stats(0, 0, 2, 2)).body.split("\n");
  assert.equal(onlyHabits[0], "📋 Hôm nay: 2/2 thói quen");
  assert.match(onlyHabits[1], /Tuyệt vời/, "all habits kept and no todos -> nothing left to review");
  const todosDoneHabitsOpen = content.buildReviewDigest(stats(2, 2, 3, 0)).body.split("\n");
  assert.match(todosDoneHabitsOpen[1], /Rà lại phần chưa xong/);
});

test("review text: nonsense counts are clamped like the other digests, and it stays short", () => {
  const text = content.buildReviewDigest(stats(2, 9, 1, -4));
  assert.match(text.body, /2\/2 todo xong · 0\/1 thói quen/);
  assert.ok(text.body.length < 120, `body is ${text.body.length} chars`);
  assert.equal(text.body.split("\n").length, 2);
});

// ── settings API ─────────────────────────────────────────────────────────────

const auth = () => ({ authorization: `Bearer ${signUserToken(app, USER_ID)}` });
const put = (payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: "/notification-settings", headers: auth(), payload });
const base = { morningTime: "07:00", eveningTime: "17:00", timezone: VN };

test("GET returns 21:30 as the default review time", async () => {
  const res = await app.inject({ method: "GET", url: "/notification-settings", headers: auth() });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().reviewTime, "21:30");
});

test("PUT saves a new review time and GET returns it", async () => {
  const res = await put({ ...base, reviewTime: "22:15" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().reviewTime, "22:15");

  const again = await app.inject({ method: "GET", url: "/notification-settings", headers: auth() });
  assert.equal(again.json().reviewTime, "22:15");
  const row = await turso.execute({ sql: "SELECT review_time FROM notification_settings WHERE user_id = ?", args: [USER_ID] });
  assert.equal((row.rows[0] as unknown as { review_time: string }).review_time, "22:15");
});

test("PUT without reviewTime (an older app version) keeps the stored one", async () => {
  await put({ ...base, reviewTime: "22:15" });

  const res = await put({ morningTime: "06:00", eveningTime: "18:00", timezone: VN });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().reviewTime, "22:15");
  assert.equal(res.json().morningTime, "06:00");
});

test("PUT without reviewTime on a user who never saved settings creates the default", async () => {
  const res = await put({ ...base });
  assert.equal(res.json().reviewTime, "21:30");
});

test("the review time is validated as HH:mm", async () => {
  for (const reviewTime of ["25:00", "9:30", "21:60", "21:30:00", "", 2130, null]) {
    const res = await put({ ...base, reviewTime });
    assert.equal(res.statusCode, 400, JSON.stringify(reviewTime));
    assert.equal(res.json().error, "bad_input");
  }
  assert.equal(UpdateNotificationSettingsSchema.safeParse({ ...base, reviewTime: "23:59" }).success, true);
  assert.equal(UpdateNotificationSettingsSchema.safeParse({ ...base, reviewTime: "00:00" }).success, true);
});

test("the review time has no tie to the evening time: it may be earlier or equal", async () => {
  const res = await put({ ...base, eveningTime: "22:00", reviewTime: "20:00" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().habitSummaryTime, "22:30");
  assert.equal(res.json().reviewTime, "20:00");
});

test("changing the review time moves the pending review jobs and leaves sent ones alone", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await planner.planAllUsers(at(TODAY, "08:00"));
  const reviews = await fx.jobsFor(turso, USER_ID, "AND kind = 'digest_review'");
  assert.deepEqual(reviews.map((job) => job.run_at), [runAtVn(TODAY, "21:30"), runAtVn(TOMORROW, "21:30")]);
  await turso.execute({ sql: "UPDATE notification_jobs SET status = 'sent' WHERE id = ?", args: [reviews[0].id as string] });

  const res = await put({ ...base, reviewTime: "22:45" });
  assert.equal(res.statusCode, 200);

  const after = await fx.jobsFor(turso, USER_ID, "AND kind = 'digest_review'");
  const byDate = new Map(after.map((job) => [job.local_date, job]));
  assert.equal(byDate.get(TODAY)?.run_at, runAtVn(TODAY, "21:30"), "the sent one is untouched");
  assert.equal(byDate.get(TOMORROW)?.run_at, runAtVn(TOMORROW, "22:45"), "the pending one moved");
});

// ── planner ──────────────────────────────────────────────────────────────────

test("the planner adds a review job for today and tomorrow at 21:30 local, next to the other three digests", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");

  await planner.planAllUsers(at(TODAY, "06:00"));

  const rows = await fx.jobsFor(turso, USER_ID, "AND kind LIKE 'digest_%'");
  const key = (row: Record<string, unknown>) => `${row.kind} ${row.local_date} ${row.run_at}`;
  assert.deepEqual(rows.map(key).sort(), [
    `digest_habits ${TODAY} ${runAtVn(TODAY, "17:30")}`,
    `digest_habits ${TOMORROW} ${runAtVn(TOMORROW, "17:30")}`,
    `digest_morning ${TODAY} ${runAtVn(TODAY, "07:00")}`,
    `digest_morning ${TOMORROW} ${runAtVn(TOMORROW, "07:00")}`,
    `digest_review ${TODAY} ${runAtVn(TODAY, "21:30")}`,
    `digest_review ${TOMORROW} ${runAtVn(TOMORROW, "21:30")}`,
    `digest_todos ${TODAY} ${runAtVn(TODAY, "17:00")}`,
    `digest_todos ${TOMORROW} ${runAtVn(TOMORROW, "17:00")}`,
  ].sort());
});

test("a user's own review time and zone are respected, and the planner is idempotent", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");
  await turso.execute({ sql: "UPDATE users SET timezone = 'America/New_York' WHERE id = ?", args: [USER_ID] });
  await turso.execute({
    sql: `INSERT INTO notification_settings (user_id, morning_time, evening_time, review_time, created_at, updated_at)
          VALUES (?, '07:00', '17:00', '20:45', ?, ?)`,
    args: [USER_ID, "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"],
  });

  const now = at(TODAY, "06:00");
  const created = await planner.planAllUsers(now);
  assert.ok(created > 0);
  assert.equal(await planner.planAllUsers(now), 0);

  const reviews = await fx.jobsFor(turso, USER_ID, "AND kind = 'digest_review'");
  assert.ok(reviews.length >= 1);
  for (const job of reviews) {
    assert.equal(
      job.run_at,
      localDateTimeToUtc(job.local_date as string, "20:45", "America/New_York").toISOString()
    );
  }
});

test("a review whose time passed more than an hour ago is not created", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A");

  await planner.planAllUsers(at(TODAY, "22:31")); // 61 minutes after 21:30

  const dates = (await fx.jobsFor(turso, USER_ID, "AND kind = 'digest_review'")).map((job) => job.local_date);
  assert.deepEqual(dates, [TOMORROW]);
});

// ── sending ──────────────────────────────────────────────────────────────────

const armReview = async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await fx.insertDevice(turso, USER_ID, "reg-B", { id: "device-B", kind: "fid" });
  await runMaintenance({ now: at(TODAY, "21:00"), logger: fx.silentLogger });
};
const reviewMessages = () => fake.messages.filter((m) => m.data?.type === "digest_review");

test("at 21:30 every device gets the review with today's real numbers", async () => {
  await armReview();
  await fx.insertTodo(turso, { id: "a", scheduledDate: TODAY, status: "done" });
  await fx.insertTodo(turso, { id: "b", scheduledDate: TODAY });
  await fx.insertTodo(turso, { id: "c", scheduledDate: TODAY });
  await fx.insertTodo(turso, { id: "sub", scheduledDate: TODAY, parentId: "a" });
  await fx.insertTodo(turso, { id: "archived", scheduledDate: TODAY, status: "archived" });
  await fx.insertHabit(turso, { id: "h1" });
  await fx.insertHabit(turso, { id: "h2" });
  await fx.insertHabitLog(turso, { id: "l1", habitId: "h1", logDate: TODAY, completed: 1 });

  await runDispatch({ now: at(TODAY, "21:30", 10), logger: fx.silentLogger });

  assert.equal(reviewMessages().length, 2);
  assert.deepEqual(fake.targets().sort(), ["reg-A", "reg-B"]);
  const [message] = reviewMessages();
  assert.equal(message.notification?.title, "Rà soát cuối ngày");
  assert.equal(
    message.notification?.body,
    [
      "📋 Hôm nay: 1/3 todo xong · 1/2 thói quen",
      "🌙 Rà lại phần chưa xong & lên kế hoạch cho ngày mai để tiến bộ hơn nhé!",
    ].join("\n")
  );
  assert.deepEqual(message.data, { type: "digest_review", id: TODAY, date: TODAY });
  assert.equal(message.android?.priority, "high");
  assert.equal(message.android?.ttl, 3_600_000);
  assert.equal(message.android?.notification?.channelId, "daily_digest");
});

test("the review is sent even on an empty day, unlike the todo and habit digests", async () => {
  await armReview();

  await runDispatch({ now: at(TODAY, "21:30", 10), logger: fx.silentLogger });

  assert.equal(reviewMessages().length, 2);
  assert.equal(reviewMessages()[0].notification?.body, "🌙 Hôm nay chưa có todo hay thói quen. Lên kế hoạch cho ngày mai nhé!");
});

test("it is sent once, and not at all when it is more than an hour late", async () => {
  await armReview();
  await runDispatch({ now: at(TODAY, "21:30", 10), logger: fx.silentLogger });
  await runDispatch({ now: at(TODAY, "21:30", 40), logger: fx.silentLogger });
  await runDispatch({ now: at(TODAY, "21:45"), logger: fx.silentLogger });
  assert.equal(reviewMessages().length, 2);

  fake.messages.length = 0;
  await turso.execute("UPDATE notification_jobs SET status = 'pending', sent_at = NULL, attempts = 0, locked_at = NULL WHERE kind = 'digest_review'");
  await runDispatch({ now: at(TODAY, "22:31"), logger: fx.silentLogger });
  assert.equal(reviewMessages().length, 0);
  assert.equal(
    (await fx.jobsFor(turso, USER_ID, "AND kind = 'digest_review'")).find((j) => j.local_date === TODAY)?.status,
    "missed"
  );
});

test("the habit digest and the review are independent jobs: both go out even in the same minute", async () => {
  await armReview();
  await fx.insertHabit(turso, { id: "h1" });
  // The planner skipped today's 17:30 habit digest (older than its 1h window at 21:00): seed one at 21:30.
  await fx.insertRawJob(turso, { id: "habit-job", kind: "digest_habits", localDate: TODAY, runAt: at(TODAY, "21:30").toISOString() });

  await runDispatch({ now: at(TODAY, "21:30", 10), logger: fx.silentLogger });

  const types = fake.messages.map((m) => m.data?.type);
  assert.ok(types.includes("digest_habits"));
  assert.ok(types.includes("digest_review"));
});

test("the existing digests are unchanged: titles and types", async () => {
  await armReview();
  await fx.insertTodo(turso, { id: "a", scheduledDate: TODAY });
  await fx.insertRawJob(turso, { id: "todos-job", kind: "digest_todos", localDate: TODAY, runAt: at(TODAY, "21:30").toISOString() });

  await runDispatch({ now: at(TODAY, "21:30", 10), logger: fx.silentLogger });

  const todos = fake.messages.find((m) => m.data?.type === "digest_todos");
  assert.equal(todos?.notification?.title, "Tổng kết todo hôm nay");
});

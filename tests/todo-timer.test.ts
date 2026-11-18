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
const jobsRepo = await import("../src/repositories/notification-jobs.js");
const timersRepo = await import("../src/repositories/todo-timers.js");
const timers = await import("../src/services/todo-timers.js");
const todosService = await import("../src/services/todos.js");
const notifications = await import("../src/services/notifications.js");
const cards = await import("../src/services/notification-cards.js");
const triggers = await import("../src/services/notification-triggers.js");
const { runTick } = await import("../src/services/notification-tick.js");
const { default: Fastify } = await import("fastify");
const { default: userAuth } = await import("../src/plugins/user-auth.js");
const { default: todosRoutes } = await import("../src/routes/api/v1/todos.js");
const { signUserToken } = await import("../src/services/api-auth.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID, OTHER_USER_ID } = fx;
const TODO_ID = "todo-1";
const DEVICE_A = "device-A";
const DEVICE_B = "device-B";
const SECOND = 1000;

// 2026-06-20 10:00 in Vietnam; nothing else is due around it, so only timer pushes appear.
const NOW = new Date("2026-06-20T03:00:00.000Z");
const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * SECOND);

type Action = "start" | "pause" | "resume" | "stop" | "finish";
type Extra = {
  remainingSeconds?: number;
  estimatedSeconds?: number;
  registrationId?: string;
};

/** Send one timer event as if it arrived at `now` carrying `clientEventAt`. */
const event = (
  action: Action,
  extra: Extra,
  options: { now?: Date; clientEventAt?: Date; todoId?: string } = {}
) => {
  const now = options.now ?? NOW;
  return timers.applyTimerEvent(
    USER_ID,
    options.todoId ?? TODO_ID,
    { action, clientEventAt: (options.clientEventAt ?? now).toISOString(), ...extra },
    now
  );
};

const start = (options: Parameters<typeof event>[2] = {}, registrationId = "reg-A") =>
  event(
    "start",
    { remainingSeconds: 1500, estimatedSeconds: 1500, registrationId },
    options
  );

const timerJob = () => jobsRepo.getEventJob(USER_ID, "todo_timer_end", TODO_ID);

const tick = (now: Date) => runTick({ now, logger: fx.silentLogger });

/**
 * Mọi tin FCM của test này đều qua `raw`. `fake` chỉ cho thấy các tin HIỆN THÔNG BÁO (hết giờ, nhắc giờ): tin gỡ
 * thẻ (`type: "dismiss"`, gửi trong nền khi bắt đầu/tiếp tục) được kiểm riêng bằng `dismissals()`, nên các test về
 * tin hết giờ không phụ thuộc việc có hay không và lúc nào tin gỡ được gửi.
 */
let raw = fx.fakeMessaging();
const isDismiss = (message: { data?: Record<string, string> }): boolean => message.data?.type === "dismiss";
const targetOf = (message: object): string => {
  const m = message as { fid?: string; token?: string };
  return (m.fid ?? m.token) as string;
};
const fake = {
  get messages() {
    return raw.messages.filter((message) => !isDismiss(message));
  },
  targets: () => fake.messages.map(targetOf),
};
/** Tin gỡ thẻ đã gửi (chờ tin đang gửi trong nền xong trước). */
const dismissals = async () => {
  await cards.flushDismissals();
  return raw.messages.filter(isDismiss);
};
/** Xóa các tin đã ghi, sau khi chờ tin gỡ đang gửi trong nền xong (nếu không nó rơi vào sau khi xóa). */
const clearPushes = async (): Promise<void> => {
  await cards.flushDismissals();
  raw.messages.length = 0;
};
const app = Fastify();

before(async () => {
  await applyAllMigrations(turso);
  await app.register(userAuth);
  await app.register(todosRoutes, { prefix: "/todos" });
  await app.ready();
});

after(async () => {
  await app.close();
});

beforeEach(async () => {
  // Tin gỡ của test trước có thể còn đang gửi trong nền: chờ xong rồi mới dọn dữ liệu và đổi FCM giả.
  await cards.flushDismissals();
  for (const table of [
    "notification_jobs",
    "todo_timers",
    "notification_settings",
    "user_devices",
    "daily_todo_logs",
    "daily_todo_summaries",
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await turso.execute("UPDATE todos SET parent_id = NULL, trigger_after_todo_id = NULL, recurrence_template_id = NULL");
  await turso.execute("DELETE FROM todos");
  await turso.execute(`DELETE FROM users WHERE id IN ('${USER_ID}', '${OTHER_USER_ID}')`);

  await fx.insertUser(turso, USER_ID);
  await fx.insertUser(turso, OTHER_USER_ID);
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: DEVICE_A });
  await fx.insertDevice(turso, USER_ID, "reg-B", { id: DEVICE_B });
  await fx.insertTodo(turso, { id: TODO_ID, title: "Viết báo cáo", scheduledDate: "2026-06-20" });

  raw = fx.fakeMessaging();
  firebase.setMessagingClientForTests(raw.client);
  firebase.setPushLogger(fx.silentLogger);
});

// ── start ────────────────────────────────────────────────────────────────────

test("start records a running timer and schedules ONE job aimed at the counting device", async () => {
  const state = await start();

  assert.equal(state.status, "running");
  assert.equal(state.remaining_seconds, 1500);
  assert.equal(state.estimated_seconds, 1500);
  assert.equal(state.ends_at, at(1500).toISOString());
  assert.equal(state.device_id, DEVICE_A);
  assert.equal(state.ignored, false);

  const job = await timerJob();
  assert.equal(job?.status, "pending");
  assert.equal(job?.run_at, at(1500).toISOString());
  assert.equal(job?.target_device_id, DEVICE_A);
  assert.equal(job?.kind, "todo_timer_end");
});

test("the end-of-timer push goes ONLY to the counting device, never to the user's other device", async () => {
  await start();

  await tick(at(1500 + 10));

  assert.deepEqual(fake.targets(), ["reg-A"]);
  const [message] = fake.messages;
  assert.equal(message.notification?.title, "Hết giờ đếm ngược");
  assert.equal(
    message.notification?.body,
    "“Viết báo cáo” đã đủ 25 phút. Hãy đánh dấu hoàn thành hoặc bắt đầu lại nếu cần nhé."
  );
  assert.equal(message.data?.type, "todo_timer_end");
  assert.equal(message.data?.id, TODO_ID);
  assert.equal(message.android?.priority, "high");
  assert.equal(message.android?.ttl, 900_000);
  assert.equal(message.android?.notification?.channelId, "todo_timer");
  // Same card as the todo's reminder and overdue nudges: the countdown end replaces them in the tray.
  assert.equal(message.android?.notification?.tag, `todo:${TODO_ID}`);
  assert.equal(message.data?.tag, `todo:${TODO_ID}`);
  assert.equal((await timerJob())?.status, "sent");
  assert.equal((await timersRepo.getTimer(TODO_ID))?.status, "finished");
});

test("the same user's other device is not reached even when it is the only one registered after A is gone", async () => {
  await start();
  // The target row vanishes without going through the cancel-on-delete path (e.g. a raw cleanup).
  await turso.execute({ sql: "DELETE FROM user_devices WHERE id = ?", args: [DEVICE_A] });

  await tick(at(1500 + 10));

  assert.equal(fake.messages.length, 0, "no fallback to reg-B");
  assert.equal((await timerJob())?.status, "cancelled");
});

test("signing the counting device out cancels the job; nothing is sent to anyone", async () => {
  await start();

  await notifications.unregisterDevice(USER_ID, "reg-A");
  assert.equal((await timerJob())?.status, "cancelled");

  await tick(at(1500 + 10));
  assert.equal(fake.messages.length, 0);
});

test("an unknown registrationId is a clear error and creates no job and no timer", async () => {
  await assert.rejects(
    start({}, "reg-does-not-exist"),
    (error: unknown) =>
      error instanceof timers.TimerServiceError && error.code === "device_not_found"
  );
  assert.equal(await timerJob(), null);
  assert.equal(await timersRepo.getTimer(TODO_ID), null);
});

test("another user's device registration cannot be used as a target", async () => {
  await fx.insertDevice(turso, OTHER_USER_ID, "reg-theirs", { id: "device-theirs" });
  await assert.rejects(
    start({}, "reg-theirs"),
    (error: unknown) =>
      error instanceof timers.TimerServiceError && error.code === "device_not_found"
  );
  assert.equal(await timerJob(), null);
});

test("a todo that is not the caller's is not found", async () => {
  await fx.insertTodo(turso, { id: "theirs", userId: OTHER_USER_ID, scheduledDate: "2026-06-20" });
  await assert.rejects(
    start({ todoId: "theirs" }),
    (error: unknown) => error instanceof timers.TimerServiceError && error.code === "not_found"
  );
  await assert.rejects(
    start({ todoId: "missing" }),
    (error: unknown) => error instanceof timers.TimerServiceError && error.code === "not_found"
  );
});

test("a completed todo cannot start or resume a timer", async () => {
  await turso.execute("UPDATE todos SET status = 'done' WHERE id = 'todo-1'");
  await assert.rejects(
    start(),
    (error: unknown) => error instanceof timers.TimerServiceError && error.code === "todo_completed"
  );
  assert.equal(await timerJob(), null);
});

// ── pause / resume ───────────────────────────────────────────────────────────

test("pause cancels the pending job and keeps the remaining time the app reports", async () => {
  await start();

  const state = await event("pause", { remainingSeconds: 1200 }, { now: at(300) });

  assert.equal(state.status, "paused");
  assert.equal(state.remaining_seconds, 1200);
  assert.equal(state.ends_at, null);
  assert.equal((await timerJob())?.status, "cancelled");

  await tick(at(1500 + 10));
  assert.equal(fake.messages.length, 0, "a paused timer never fires");
});

test("resume schedules a NEW job from the remaining time", async () => {
  await start();
  await event("pause", { remainingSeconds: 1200 }, { now: at(300) });

  const state = await event(
    "resume",
    { remainingSeconds: 1200, registrationId: "reg-A" },
    { now: at(600) }
  );

  assert.equal(state.status, "running");
  assert.equal(state.ends_at, at(600 + 1200).toISOString());
  assert.equal(state.estimated_seconds, 1500, "the original estimate survives pause/resume");
  const job = await timerJob();
  assert.equal(job?.status, "pending");
  assert.equal(job?.run_at, at(1800).toISOString());

  await tick(at(1800 + 5));
  assert.deepEqual(fake.targets(), ["reg-A"]);
  assert.match(fake.messages[0].notification?.body ?? "", /đã đủ 25 phút/);
});

test("resuming on another device moves the target; only that device is notified", async () => {
  await start();
  await event("pause", { remainingSeconds: 1000 }, { now: at(100) });

  await event("resume", { remainingSeconds: 1000, registrationId: "reg-B" }, { now: at(200) });

  const job = await timerJob();
  assert.equal(job?.target_device_id, DEVICE_B);
  assert.equal((await timersRepo.getTimer(TODO_ID))?.device_id, DEVICE_B);
  const count = await turso.execute("SELECT COUNT(*) AS c FROM notification_jobs WHERE kind = 'todo_timer_end'");
  assert.equal(Number((count.rows[0] as unknown as { c: number }).c), 1, "still one job per todo");

  await tick(at(1200 + 5));
  assert.deepEqual(fake.targets(), ["reg-B"]);
});

test("starting again on a different device while running also moves the target", async () => {
  await start();
  await event(
    "start",
    { remainingSeconds: 900, estimatedSeconds: 1500, registrationId: "reg-B" },
    { now: at(60) }
  );
  assert.equal((await timerJob())?.target_device_id, DEVICE_B);
  assert.equal((await timerJob())?.run_at, at(60 + 900).toISOString());
});

test("pause is ignored when nothing is running", async () => {
  const state = await event("pause", { remainingSeconds: 100 });
  assert.equal(state.ignored, true);
  assert.equal(state.status, "idle");
  assert.equal(await timersRepo.getTimer(TODO_ID), null);
});

// ── stop / finish ────────────────────────────────────────────────────────────

test("stop resets to idle and cancels the job; finish marks it finished and cancels the job", async () => {
  await start();
  const stopped = await event("stop", {}, { now: at(10) });
  assert.equal(stopped.status, "idle");
  assert.equal((await timerJob())?.status, "cancelled");

  await start({ now: at(20) });
  assert.equal((await timerJob())?.status, "pending", "a new start re-arms the same job");
  const finished = await event("finish", { remainingSeconds: 0 }, { now: at(30) });
  assert.equal(finished.status, "finished");
  assert.equal((await timerJob())?.status, "cancelled");

  await tick(at(5000));
  assert.equal(fake.messages.length, 0);
});

// ── ordering and delayed events ──────────────────────────────────────────────

test("an old event replayed late is ignored and the state is left alone", async () => {
  await start({ now: at(100) }); // clientEventAt = t+100

  const stalePause = await event(
    "pause",
    { remainingSeconds: 5 },
    { now: at(120), clientEventAt: at(90) }
  );
  assert.equal(stalePause.ignored, true);
  assert.equal(stalePause.status, "running");
  assert.equal((await timerJob())?.status, "pending");

  const sameInstant = await event("stop", {}, { now: at(130), clientEventAt: at(100) });
  assert.equal(sameInstant.ignored, true, "an equal timestamp is not newer");
  assert.equal((await timersRepo.getTimer(TODO_ID))?.status, "running");

  const fresh = await event("pause", { remainingSeconds: 1400 }, { now: at(140), clientEventAt: at(110) });
  assert.equal(fresh.ignored, false);
  assert.equal(fresh.status, "paused");
});

test("an event that arrives more than 60 s late has the delay subtracted from the remaining time", async () => {
  const state = await event(
    "start",
    { remainingSeconds: 600, estimatedSeconds: 600, registrationId: "reg-A" },
    { now: at(0), clientEventAt: at(-90) }
  );
  assert.equal(state.remaining_seconds, 510);
  assert.equal(state.ends_at, at(510).toISOString());
  assert.equal((await timerJob())?.run_at, at(510).toISOString());
});

test("an event at most 60 s late is taken at face value", async () => {
  const state = await event(
    "start",
    { remainingSeconds: 600, estimatedSeconds: 600, registrationId: "reg-A" },
    { now: at(0), clientEventAt: at(-45) }
  );
  assert.equal(state.remaining_seconds, 600);
  assert.equal(state.ends_at, at(600).toISOString());
});

test("an event so late that the time already ran out creates no job and marks the timer finished", async () => {
  const state = await event(
    "start",
    { remainingSeconds: 60, estimatedSeconds: 60, registrationId: "reg-A" },
    { now: at(0), clientEventAt: at(-120) }
  );
  assert.equal(state.status, "finished");
  assert.equal(state.remaining_seconds, 0);
  assert.equal(state.ends_at, null);
  assert.equal(await timerJob(), null);

  await tick(at(5000));
  assert.equal(fake.messages.length, 0);
});

test("a device clock far in the future cannot block later events", async () => {
  await event(
    "start",
    { remainingSeconds: 600, estimatedSeconds: 600, registrationId: "reg-A" },
    { now: at(0), clientEventAt: at(3600) } // wrong clock: one hour ahead
  );
  const pause = await event("pause", { remainingSeconds: 500 }, { now: at(10), clientEventAt: at(10) });
  assert.equal(pause.ignored, false);
  assert.equal(pause.status, "paused");
});

// ── todo lifecycle ───────────────────────────────────────────────────────────

test("completing the todo cancels the timer job and clears the timer", async () => {
  await start();
  await todosService.completeTodo(USER_ID, TODO_ID, {});

  assert.equal((await timerJob())?.status, "cancelled");
  assert.equal((await timersRepo.getTimer(TODO_ID))?.status, "idle");

  await tick(at(1500 + 10));
  assert.equal(fake.messages.length, 0);
});

test("a stale event after completion cannot restart the timer (ordering is kept)", async () => {
  await start({ now: at(100) });
  await todosService.completeTodo(USER_ID, TODO_ID, {});
  const replay = await event("pause", { remainingSeconds: 5 }, { now: at(200), clientEventAt: at(50) });
  assert.equal(replay.ignored, true);
});

test("deleting the todo cancels the job and removes the timer row", async () => {
  await start();
  await todosService.deleteTodo(USER_ID, TODO_ID);

  assert.equal((await timerJob())?.status, "cancelled");
  assert.equal(await timersRepo.getTimer(TODO_ID), null);
});

test("if the timer is no longer running or its end time changed, the old job does not fire", async () => {
  await start();
  // simulate a missed hook: the timer row moved on but the job was not cancelled
  await turso.execute({
    sql: "UPDATE todo_timers SET status = 'paused', ends_at = NULL WHERE todo_id = ?",
    args: [TODO_ID],
  });
  await tick(at(1500 + 10));
  assert.equal(fake.messages.length, 0);
  assert.equal((await timerJob())?.status, "cancelled");

  await start({ now: at(3000) });
  await turso.execute({
    sql: "UPDATE todo_timers SET ends_at = ? WHERE todo_id = ?",
    args: [at(9999).toISOString(), TODO_ID],
  });
  await tick(at(3000 + 1500 + 10));
  assert.equal(fake.messages.length, 0, "ends_at no longer matches run_at");
});

test("a timer end that is more than 5 minutes late is dropped, not sent", async () => {
  await start();
  await tick(at(1500 + 6 * 60));
  assert.equal(fake.messages.length, 0);
  assert.equal((await timerJob())?.status, "missed");
});

// ── HTTP contract ────────────────────────────────────────────────────────────

const auth = () => ({ authorization: `Bearer ${signUserToken(app, USER_ID)}` });
const put = (payload: unknown, headers: Record<string, string> = auth(), id = TODO_ID) =>
  app.inject({
    method: "PUT",
    url: `/todos/${id}/timer`,
    headers,
    payload: payload as object,
  });

test("PUT /todos/:id/timer requires a user JWT and validates the body per action", async () => {
  const now = new Date().toISOString();
  assert.equal((await put({ action: "start" }, {})).statusCode, 401);

  for (const bad of [
    {},
    { action: "dance", clientEventAt: now },
    { action: "start", clientEventAt: now, remainingSeconds: 10 },
    { action: "start", clientEventAt: now, remainingSeconds: 10, estimatedSeconds: 10 },
    { action: "resume", clientEventAt: now, registrationId: "reg-A" },
    { action: "pause", clientEventAt: now },
    { action: "pause", remainingSeconds: -1, clientEventAt: now },
    { action: "stop", clientEventAt: "yesterday" },
    { action: "stop" },
  ]) {
    const res = await put(bad);
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.equal(res.json().error, "bad_input");
  }
});

test("PUT /todos/:id/timer: success body, unknown device, unknown todo and completed todo", async () => {
  const now = () => new Date().toISOString();

  const ok = await put({
    action: "start",
    remainingSeconds: 1500,
    estimatedSeconds: 1500,
    registrationId: "reg-A",
    clientEventAt: now(),
  });
  assert.equal(ok.statusCode, 200);
  const body = ok.json();
  assert.deepEqual(Object.keys(body).sort(), [
    "device_id",
    "ends_at",
    "estimated_seconds",
    "ignored",
    "remaining_seconds",
    "status",
    "todo_id",
  ]);
  assert.equal(body.status, "running");
  assert.equal(body.device_id, DEVICE_A);
  assert.equal(body.ignored, false);
  assert.ok(Date.parse(body.ends_at) > Date.now());

  const replay = await put({ action: "stop", clientEventAt: new Date(Date.now() - 3600_000).toISOString() });
  assert.equal(replay.statusCode, 200, "stale events are acknowledged, not errors");
  assert.equal(replay.json().ignored, true);
  assert.equal(replay.json().status, "running");

  const unknownDevice = await put({
    action: "resume",
    remainingSeconds: 5,
    registrationId: "nope",
    clientEventAt: now(),
  });
  assert.equal(unknownDevice.statusCode, 404);
  assert.deepEqual(unknownDevice.json(), { error: "device_not_found" });

  const unknownTodo = await put(
    { action: "stop", clientEventAt: now() },
    auth(),
    "missing"
  );
  assert.equal(unknownTodo.statusCode, 404);
  assert.deepEqual(unknownTodo.json(), { error: "not_found" });

  await turso.execute("UPDATE todos SET status = 'done' WHERE id = 'todo-1'");
  const completed = await put({
    action: "start",
    remainingSeconds: 5,
    estimatedSeconds: 5,
    registrationId: "reg-A",
    clientEventAt: now(),
  });
  assert.equal(completed.statusCode, 409);
  assert.deepEqual(completed.json(), { error: "todo_completed" });
});

// ── removing the delivered card when the countdown starts or resumes ─────────

const SERIES_ID = "series-root";
const countdown = (extra: Partial<Extra> = {}): Extra => ({
  remainingSeconds: 1500,
  estimatedSeconds: 1500,
  registrationId: "reg-A",
  ...extra,
});

test("start removes the delivered card: ONE data-only dismiss per device, under the todo's tag", async () => {
  await start();

  const sent = await dismissals();
  assert.equal(sent.length, 2, "one message per device of the user (the other device and the starting one)");
  assert.deepEqual(sent.map(targetOf).sort(), ["reg-A", "reg-B"]);
  for (const message of sent) {
    assert.equal(message.notification, undefined, "nothing is shown by the system");
    assert.deepEqual(
      { ...message.data, before: "<time>" },
      { type: "dismiss", id: TODO_ID, tag: `todo:${TODO_ID}`, before: "<time>" }
    );
    assert.equal(message.data?.before, NOW.toISOString());
    assert.equal(message.android?.priority, "high");
    assert.equal(message.android?.ttl, 180_000, "short-lived so a late delivery cannot hit a newer card");
  }
  assert.equal((await timerJob())?.status, "pending", "the end-of-timer job is still scheduled");
});

test("resume removes it too, from whichever device resumes; pause, stop and finish remove nothing", async () => {
  await start();
  await clearPushes();

  await event("pause", { remainingSeconds: 1200 }, { now: at(300) });
  assert.equal((await dismissals()).length, 0, "pause");

  await event("resume", countdown({ remainingSeconds: 1200, registrationId: "reg-B" }), { now: at(600) });
  const sent = await dismissals();
  assert.equal(sent.length, 2, "resume: every device again");
  assert.deepEqual(new Set(sent.map((m) => m.data?.tag)), new Set([`todo:${TODO_ID}`]));
  await clearPushes();

  await event("stop", {}, { now: at(700) });
  await event("finish", {}, { now: at(800) });
  assert.equal((await dismissals()).length, 0, "stop and finish");
});

test("an occurrence of a recurring todo is removed under the series root's tag", async () => {
  await fx.insertTodo(turso, { id: SERIES_ID, title: "Gốc", scheduledDate: "2026-06-19", status: "done" });
  await fx.insertTodo(turso, { id: "occ-1", scheduledDate: "2026-06-20", recurrenceTemplateId: SERIES_ID });

  await event("start", countdown(), { todoId: "occ-1" });

  const sent = await dismissals();
  assert.equal(sent.length, 2);
  for (const message of sent) {
    assert.equal(message.data?.tag, `todo:${SERIES_ID}`);
    assert.equal(message.data?.id, "occ-1");
  }
});

test("a subtask has no card of its own: nothing is removed, the countdown still runs", async () => {
  await fx.insertTodo(turso, { id: "sub-1", parentId: TODO_ID, scheduledDate: null });

  const state = await event("start", countdown(), { todoId: "sub-1" });

  assert.equal(state.status, "running");
  assert.equal((await dismissals()).length, 0);
});

test("the end-of-timer card replaces the old one by itself: no dismiss when at most 4 minutes remain", async () => {
  const state = await event("start", countdown({ remainingSeconds: 240, estimatedSeconds: 240 }));
  assert.equal(state.status, "running");
  assert.equal((await timerJob())?.status, "pending");
  assert.equal((await dismissals()).length, 0, "240 s: the end-of-timer push is due inside the replace window");

  await event("stop", {}, { now: at(10) });
  await event("start", countdown({ remainingSeconds: 241, estimatedSeconds: 241 }), { now: at(20) });
  assert.equal((await dismissals()).length, 2, "241 s: just outside the window, so the card is removed");
});

test("a countdown that has already run out has no end-of-timer card to replace anything: the card is removed", async () => {
  // 100 s left reported, but the event arrives 200 s late: nothing remains, the timer is finished at once.
  const state = await event("start", countdown({ remainingSeconds: 100 }), {
    now: NOW,
    clientEventAt: at(-200),
  });
  assert.equal(state.status, "finished");
  assert.equal(await timerJob(), null);

  assert.equal((await dismissals()).length, 2);

  await clearPushes();
  await event("resume", countdown({ remainingSeconds: 0 }), { now: at(60) });
  assert.equal((await dismissals()).length, 2, "an explicit 0 s left behaves the same");
});

test("an old or replayed event is ignored and removes nothing", async () => {
  await start({ now: at(100) });
  await clearPushes();

  const older = await start({ now: at(110), clientEventAt: at(50) });
  const retry = await start({ now: at(120), clientEventAt: at(100) });

  assert.equal(older.ignored, true);
  assert.equal(retry.ignored, true);
  assert.equal((await dismissals()).length, 0);
});

test("nothing is removed when the event is refused: unknown device, completed todo, unknown todo", async () => {
  await assert.rejects(
    event("start", countdown({ registrationId: "nope" })),
    (error: unknown) => error instanceof timers.TimerServiceError && error.code === "device_not_found"
  );
  await assert.rejects(
    event("start", countdown(), { todoId: "missing" }),
    (error: unknown) => error instanceof timers.TimerServiceError && error.code === "not_found"
  );
  await turso.execute("UPDATE todos SET status = 'done' WHERE id = 'todo-1'");
  await assert.rejects(
    start(),
    (error: unknown) => error instanceof timers.TimerServiceError && error.code === "todo_completed"
  );

  assert.equal((await dismissals()).length, 0);
});

test("the removal never waits for FCM: the timer event is answered while the send is still blocked", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  firebase.setMessagingClientForTests({
    sendEach: async (batch: unknown[]) => {
      await gate;
      return { responses: batch.map(() => ({ success: true })) };
    },
  } as never);

  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    start().then((state) => state.status),
    new Promise<string>((resolve) => {
      timeout = setTimeout(() => resolve("blocked"), 3000);
    }),
  ]);
  clearTimeout(timeout);
  release();
  await cards.flushDismissals();

  assert.equal(outcome, "running");
});

test("a failing dismiss send does not fail PUT /timer, and the response is exactly the same", async () => {
  const startBody = (offsetMs: number) => ({
    action: "start",
    remainingSeconds: 1500,
    estimatedSeconds: 1500,
    registrationId: "reg-A",
    clientEventAt: new Date(Date.now() + offsetMs).toISOString(),
  });
  const normalized = (body: Record<string, unknown>) => ({ ...body, ends_at: "<time>" });

  const healthy = await put(startBody(0));
  assert.equal(healthy.statusCode, 200);
  await cards.flushDismissals();
  assert.equal(raw.messages.filter(isDismiss).length, 2, "the healthy run did send the removal");

  firebase.setMessagingClientForTests({
    sendEach: async () => {
      throw new Error("network down");
    },
  });
  const broken = await put(startBody(1000));
  await assert.doesNotReject(cards.flushDismissals());

  assert.equal(broken.statusCode, 200);
  assert.deepEqual(normalized(broken.json()), normalized(healthy.json()));
  assert.equal((await timerJob())?.status, "pending");
});

test("NOTIFY_DRY_RUN only logs: starting a countdown sends no removal", async () => {
  const { env } = await import("../src/config/env.js");
  env.NOTIFY_DRY_RUN = true;
  try {
    const state = await start();
    assert.equal(state.status, "running");
    assert.equal((await dismissals()).length, 0);
    assert.equal(raw.messages.length, 0);
  } finally {
    env.NOTIFY_DRY_RUN = false;
  }
});

// ── the on-time reminder of a todo that is already being worked on ───────────

const TIMED_ID = "todo-timed";

/** Todo hẹn 10:30 (NOW là 10:00), nhắc giờ đã được hẹn như khi người dùng vừa tạo nó. */
const armTimedTodo = async (flags: { isImportant?: number; isUrgent?: number } = {}) => {
  await fx.insertTodo(turso, {
    id: TIMED_ID,
    title: "Họp nhóm",
    scheduledDate: "2026-06-20",
    time: "10:30",
    ...flags,
  });
  await triggers.onTodoChanged(USER_ID, TIMED_ID, NOW);
  assert.equal((await jobsRepo.getEventJob(USER_ID, "todo_reminder", TIMED_ID))?.status, "pending");
};

const reminderStatus = async () =>
  (await jobsRepo.getEventJob(USER_ID, "todo_reminder", TIMED_ID))?.status;

const startTimed = (now: Date) =>
  event("start", countdown({ remainingSeconds: 3600, estimatedSeconds: 3600 }), { now, todoId: TIMED_ID });

test("a todo whose countdown started before its time is not reminded on time: the job is cancelled when it comes due", async () => {
  await armTimedTodo({ isImportant: 1, isUrgent: 1 });
  await startTimed(at(60));
  assert.equal(await reminderStatus(), "pending", "starting leaves the job alone, so stopping can bring the reminder back");

  await tick(at(1800 + 10)); // 10:30

  assert.equal(fake.messages.length, 0, "no reminder while the user is already working on it");
  assert.equal(await reminderStatus(), "cancelled");

  await tick(at(2100 + 10)); // 10:35: and no +5 minute repeat either (it only follows a sent reminder)
  assert.equal(fake.messages.length, 0);
});

test("a paused countdown counts as started too: the on-time reminder is still cancelled", async () => {
  await armTimedTodo();
  await startTimed(at(60));
  await event("pause", { remainingSeconds: 3000 }, { now: at(600), todoId: TIMED_ID });

  await tick(at(1800 + 10));

  assert.equal(fake.messages.length, 0);
  assert.equal(await reminderStatus(), "cancelled");
});

test("so does a countdown that ran out and was never stopped", async () => {
  await armTimedTodo();
  await startTimed(at(60));
  await event("finish", {}, { now: at(600), todoId: TIMED_ID });
  assert.equal((await timersRepo.getTimer(TIMED_ID))?.status, "finished");

  await tick(at(1800 + 10));

  assert.equal(fake.messages.length, 0);
  assert.equal(await reminderStatus(), "cancelled");
});

test("stopping the countdown (idle) before the time restores the normal on-time reminder and its repeat", async () => {
  await armTimedTodo({ isImportant: 1, isUrgent: 1 });
  await startTimed(at(60));
  await event("stop", {}, { now: at(600), todoId: TIMED_ID });

  await tick(at(1800 + 10));

  assert.equal(fake.messages.length, 2, "both devices are reminded");
  for (const message of fake.messages) {
    assert.equal(message.data?.type, "todo");
    assert.equal(message.data?.id, TIMED_ID);
    assert.equal(message.data?.repeat, undefined);
    assert.equal(message.android?.notification?.tag, `todo:${TIMED_ID}`);
  }
  assert.equal(await reminderStatus(), "sent");

  await clearPushes();
  await tick(at(2100 + 10)); // the +5 minute repeat follows as usual
  assert.deepEqual(fake.messages.map((m) => m.data?.repeat), ["1", "1"]);
});

test("a countdown on ANOTHER todo that is over long before the time does not cancel this todo's reminder", async () => {
  await armTimedTodo();
  // todo-1 counts down 10:01 -> 10:11: nothing is held at 10:30 and nothing is cancelled.
  await event("start", countdown({ remainingSeconds: 600, estimatedSeconds: 600 }), { now: at(60) });

  await tick(at(1800 + 10));

  assert.equal(fake.messages.filter((m) => m.data?.id === TIMED_ID).length, 2);
  assert.equal(await reminderStatus(), "sent");
});

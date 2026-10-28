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
const jobsRepo = await import("../src/repositories/notification-jobs.js");
const schedulesRepo = await import("../src/repositories/checklist-schedules.js");
const habitsRepo = await import("../src/repositories/habits.js");
const { getChangesSince } = await import("../src/repositories/sync.repo.js");
const { processPush } = await import("../src/services/sync.service.js");
const { doneDatesOf } = await import("../src/services/checklist-occurrence-done.js");
const { checkOccurrenceOpen, reconcileChecklistDue } = await import("../src/services/checklist-due.js");
const planner = await import("../src/services/notification-planner.js");
const schedulesService = await import("../src/services/checklist-schedules.js");
const checklistsService = await import("../src/services/checklists.js");
const { autoLogHabitsForCompletedRun } = await import("../src/services/checklist-habit-logs.js");
const { default: Fastify } = await import("fastify");
const { default: userAuth } = await import("../src/plugins/user-auth.js");
const { default: checklistsRoutes } = await import("../src/routes/api/v1/checklists.js");
const { signUserToken } = await import("../src/services/api-auth.js");
const { addDays, localDateOf } = await import("../src/utils/time.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID, OTHER_USER_ID } = fx;
const VN = "Asia/Ho_Chi_Minh";
const A = "tst-rời-nhà"; // 3 steps, "Rời nhà"
const B = "tst-đi-ngủ"; // 2 steps, "Đi ngủ"
const FOREIGN = "tst-foreign"; // belongs to OTHER_USER_ID

const app = Fastify();

before(async () => {
  await applyAllMigrations(turso);
  await app.register(userAuth);
  await app.register(checklistsRoutes, { prefix: "/checklists" });
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
    "checklist_occurrence_marks",
    "checklist_schedule_overrides",
    "checklist_schedules",
    "checklist_run_items",
    "checklist_runs",
    "habit_logs",
    "habits",
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await turso.execute("DELETE FROM checklist_template_items WHERE template_id LIKE 'tst-%'");
  await turso.execute("DELETE FROM checklist_templates WHERE id LIKE 'tst-%'");
  await turso.execute(`DELETE FROM users WHERE id IN ('${USER_ID}', '${OTHER_USER_ID}')`);

  await fx.insertUser(turso, USER_ID);
  await fx.insertUser(turso, OTHER_USER_ID, { timezone: "Pacific/Auckland" });
  await fx.insertTemplateWithItems(turso, { id: A, title: "Rời nhà", itemCount: 3 });
  await fx.insertTemplateWithItems(turso, { id: B, title: "Đi ngủ", itemCount: 2 });
  await fx.insertTemplateWithItems(turso, { id: FOREIGN, userId: OTHER_USER_ID, title: "Của người khác", itemCount: 1 });
});

type Json = Record<string, any>;
type Reply = { status: number; body: Json };

const call = async (
  method: "GET" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
  userId: string = USER_ID
): Promise<Reply> => {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${signUserToken(app, userId)}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Json) : {} };
};

const daily = (overrides: Json = {}): Json => ({
  start_date: "2026-06-01",
  time: "07:30",
  recurrence_type: "daily",
  ...overrides,
});
const putSchedule = (id: string, body: unknown, userId?: string) =>
  call("PUT", `/checklists/templates/${id}/schedule`, body, userId);
const occurrences = (from: string, to: string, userId?: string) =>
  call("GET", `/checklists/occurrences?from=${from}&to=${to}`, undefined, userId);
const putStatus = (id: string, date: string, body: unknown, userId?: string) =>
  call("PUT", `/checklists/templates/${id}/occurrences/${date}/status`, body, userId);
const deleteStatus = (id: string, date: string, userId?: string) =>
  call("DELETE", `/checklists/templates/${id}/occurrences/${date}/status`, undefined, userId);

const liveRows = async (table: string, where = "1=1") =>
  (await turso.execute(`SELECT * FROM ${table} WHERE deleted_at IS NULL AND ${where}`)).rows;

/** Dấu tay với updated_at chọn trước (đường REST luôn dùng giờ máy chủ). */
const insertMark = async (row: {
  id?: string;
  templateId?: string;
  userId?: string;
  localDate: string;
  status: "done" | "open";
  updatedAt?: string;
}): Promise<void> => {
  const at = row.updatedAt ?? "2026-06-01T00:00:00.000Z";
  await turso.execute({
    sql: `INSERT INTO checklist_occurrence_marks
          (id, user_id, template_id, local_date, status, created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    args: [row.id ?? `mark-${row.localDate}`, row.userId ?? USER_ID, row.templateId ?? A, row.localDate, row.status, at, at],
  });
};

const dateOf = (iso: string, timezone = VN): string => localDateOf(new Date(iso), timezone);

// ── pure rule ────────────────────────────────────────────────────────────────

const run = (startedAt: string, completedAt: string, extra: Json = {}) => ({
  user_id: USER_ID,
  template_id: A,
  started_at: startedAt,
  completed_at: completedAt,
  ...extra,
});
const mark = (local_date: string, status: "done" | "open", updated_at: string, extra: Json = {}) => ({
  user_id: USER_ID,
  template_id: A,
  local_date,
  status,
  updated_at,
  ...extra,
});
const doneOf = (runs: Json[], marks: Json[], timezone = VN) =>
  [...doneDatesOf({ userId: USER_ID, templateId: A }, runs as never, marks as never, timezone)].sort();

test("a run belongs to the day it STARTED: 23:30 -> 00:30 counts for the first day only", () => {
  // 23:30 on 2 June in Vietnam, finished 00:30 on 3 June.
  const spanning = run("2026-06-02T16:30:00.000Z", "2026-06-02T17:30:00.000Z");
  assert.equal(dateOf(spanning.started_at), "2026-06-02");
  assert.equal(dateOf(spanning.completed_at), "2026-06-03");
  assert.deepEqual(doneOf([spanning], []), ["2026-06-02"]);
});

test("the day is the user's LOCAL day of the start, not the UTC day", () => {
  const r = run("2026-06-02T17:30:00.000Z", "2026-06-02T18:00:00.000Z"); // 00:30 on the 3rd in VN
  assert.deepEqual(doneOf([r], [], VN), ["2026-06-03"]);
  assert.deepEqual(doneOf([r], [], "America/New_York"), ["2026-06-02"]);
});

test("two runs on one day are one done day; runs on different days are different days", () => {
  const runs = [
    run("2026-06-02T01:00:00.000Z", "2026-06-02T01:10:00.000Z"),
    run("2026-06-02T09:00:00.000Z", "2026-06-02T09:10:00.000Z"),
    run("2026-06-03T01:00:00.000Z", "2026-06-03T01:10:00.000Z"),
  ];
  assert.deepEqual(doneOf(runs, []), ["2026-06-02", "2026-06-03"]);
});

test("only the user's own runs and marks of this checklist count; broken timestamps are ignored", () => {
  const runs = [
    run("2026-06-02T01:00:00.000Z", "2026-06-02T01:10:00.000Z", { user_id: OTHER_USER_ID }),
    run("2026-06-03T01:00:00.000Z", "2026-06-03T01:10:00.000Z", { template_id: B }),
    run("not a date", "2026-06-04T01:10:00.000Z"),
  ];
  const marks = [
    mark("2026-06-05", "done", "2026-06-05T01:00:00.000Z", { user_id: OTHER_USER_ID }),
    mark("2026-06-06", "done", "2026-06-06T01:00:00.000Z", { template_id: B }),
  ];
  assert.deepEqual(doneOf(runs, marks), []);
});

test("a manual 'done' makes the day done with or without runs", () => {
  assert.deepEqual(doneOf([], [mark("2026-06-02", "done", "2026-06-02T05:00:00.000Z")]), ["2026-06-02"]);
  const r = run("2026-06-02T01:00:00.000Z", "2026-06-02T01:10:00.000Z");
  assert.deepEqual(doneOf([r], [mark("2026-06-02", "done", "2026-06-02T05:00:00.000Z")]), ["2026-06-02"]);
});

test("a manual 'open' hides runs completed BEFORE it, but a run completed after it makes the day done again", () => {
  const first = run("2026-06-02T01:00:00.000Z", "2026-06-02T01:10:00.000Z");
  const open = mark("2026-06-02", "open", "2026-06-02T02:00:00.000Z");
  assert.deepEqual(doneOf([first], [open]), [], "done once, then reset by hand");

  const second = run("2026-06-02T09:00:00.000Z", "2026-06-02T09:10:00.000Z");
  assert.deepEqual(doneOf([first, second], [open]), ["2026-06-02"], "the second run of the day");

  const straddling = run("2026-06-02T01:30:00.000Z", "2026-06-02T03:00:00.000Z"); // started before, finished after
  assert.deepEqual(doneOf([straddling], [open]), ["2026-06-02"]);
});

test("a manual 'open' on a day nobody ran, or with an unreadable time, stays open", () => {
  assert.deepEqual(doneOf([], [mark("2026-06-02", "open", "2026-06-02T02:00:00.000Z")]), []);
  const r = run("2026-06-02T01:00:00.000Z", "2026-06-02T01:10:00.000Z");
  assert.deepEqual(doneOf([r], [mark("2026-06-02", "open", "garbage")]), []);
});

test("a mark only decides its own day", () => {
  const r = run("2026-06-03T01:00:00.000Z", "2026-06-03T01:10:00.000Z");
  assert.deepEqual(doneOf([r], [mark("2026-06-02", "open", "2026-06-02T02:00:00.000Z")]), ["2026-06-03"]);
});

// ── REST ─────────────────────────────────────────────────────────────────────

test("every status endpoint requires a login", async () => {
  for (const method of ["PUT", "DELETE"] as const) {
    const res = await app.inject({ method, url: `/checklists/templates/${A}/occurrences/2026-06-02/status`, payload: { status: "done" } });
    assert.equal(res.statusCode, 401, method);
  }
});

test("PUT marks a day done without any run; GET /occurrences reports done + manual; DELETE goes back to automatic", async () => {
  await putSchedule(A, daily());

  const put = await putStatus(A, "2026-06-02", { status: "done" });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, { checklistId: A, date: "2026-06-02", manual: "done", done: true });

  const items = (await occurrences("2026-06-01", "2026-06-03")).body.items as Json[];
  assert.deepEqual(items.map((i) => [i.date, i.done, i.manual]), [
    ["2026-06-01", false, null],
    ["2026-06-02", true, "done"],
    ["2026-06-03", false, null],
  ]);

  const del = await deleteStatus(A, "2026-06-02");
  assert.equal(del.status, 204);
  const after = (await occurrences("2026-06-02", "2026-06-02")).body.items[0];
  assert.deepEqual([after.done, after.manual], [false, null]);
  assert.equal((await deleteStatus(A, "2026-06-02")).status, 204, "idempotent");
});

test("PUT 'open' turns a day with a completed run back into not done; DELETE returns it to automatic", async () => {
  await putSchedule(A, daily());
  await fx.insertRun(turso, { id: "r1", templateId: A, completedAt: "2026-06-02T03:00:00.000Z" });
  assert.equal((await occurrences("2026-06-02", "2026-06-02")).body.items[0].done, true);

  const put = await putStatus(A, "2026-06-02", { status: "open" });
  assert.deepEqual(put.body, { checklistId: A, date: "2026-06-02", manual: "open", done: false });
  const item = (await occurrences("2026-06-02", "2026-06-02")).body.items[0];
  assert.deepEqual([item.done, item.manual], [false, "open"]);

  await deleteStatus(A, "2026-06-02");
  const back = (await occurrences("2026-06-02", "2026-06-02")).body.items[0];
  assert.deepEqual([back.done, back.manual], [true, null]);
});

test("setting the mark again updates the same row instead of adding one", async () => {
  await putSchedule(A, daily());
  await putStatus(A, "2026-06-02", { status: "done" });
  await putStatus(A, "2026-06-02", { status: "open" });
  await putStatus(A, "2026-06-02", { status: "done" });
  const rows = await liveRows("checklist_occurrence_marks");
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as Json).status, "done");
});

test("through GET /occurrences a run that crosses midnight is done on its START day only", async () => {
  await putSchedule(A, daily());
  await fx.insertRun(turso, {
    id: "r-night",
    templateId: A,
    startedAt: "2026-06-02T16:30:00.000Z", // 23:30 on the 2nd
    completedAt: "2026-06-02T17:30:00.000Z", // 00:30 on the 3rd
  });
  const items = (await occurrences("2026-06-02", "2026-06-03")).body.items as Json[];
  assert.deepEqual(items.map((i) => [i.date, i.done]), [["2026-06-02", true], ["2026-06-03", false]]);
});

test("a run still in progress, or abandoned, makes nothing done", async () => {
  await putSchedule(A, daily());
  await fx.insertRun(turso, { id: "r-live", templateId: A, status: "in_progress", startedAt: "2026-06-02T03:00:00.000Z" });
  await fx.insertRun(turso, { id: "r-ab", templateId: A, status: "abandoned", startedAt: "2026-06-03T03:00:00.000Z", completedAt: "2026-06-03T04:00:00.000Z" });
  const items = (await occurrences("2026-06-02", "2026-06-03")).body.items as Json[];
  assert.deepEqual(items.map((i) => i.done), [false, false]);
});

test("validation: bad status or date is 400, a day that is not an occurrence is 400, no schedule or someone else's checklist is 404", async () => {
  await putSchedule(A, daily({ start_date: "2026-06-10", recurrence_end_date: "2026-06-20" }));

  assert.equal((await putStatus(A, "2026-06-12", { status: "maybe" })).status, 400);
  assert.equal((await putStatus(A, "2026-06-12", {})).status, 400);
  assert.equal((await putStatus(A, "2026-02-30", { status: "done" })).status, 400);
  assert.equal((await putStatus(A, "12-06-2026", { status: "done" })).status, 400);
  assert.equal((await deleteStatus(A, "nope")).status, 400);

  const before = await putStatus(A, "2026-06-09", { status: "done" });
  assert.equal(before.status, 400);
  assert.equal(before.body.error, "not_an_occurrence");
  assert.equal((await putStatus(A, "2026-06-21", { status: "done" })).body.error, "not_an_occurrence");

  assert.equal((await putStatus(B, "2026-06-12", { status: "done" })).status, 404, "no schedule");
  assert.equal((await putStatus(FOREIGN, "2026-06-12", { status: "done" })).status, 404);
  assert.equal((await deleteStatus(FOREIGN, "2026-06-12")).status, 404);
  assert.equal((await liveRows("checklist_occurrence_marks")).length, 0);
});

test("marks are per user: another user's mark on the same shared checklist does not show up", async () => {
  await fx.insertSystemTemplate(turso, { id: "tst-sys", title: "Mẫu hệ thống", itemCount: 1 });
  await putSchedule("tst-sys", daily());
  await putSchedule("tst-sys", daily(), OTHER_USER_ID);
  await putStatus("tst-sys", "2026-06-02", { status: "done" }, OTHER_USER_ID);

  assert.equal((await occurrences("2026-06-02", "2026-06-02")).body.items[0].done, false);
  assert.equal((await occurrences("2026-06-02", "2026-06-02", OTHER_USER_ID)).body.items[0].done, true);
});

// ── reminders, expiry, habits ────────────────────────────────────────────────

const tomorrow = (): string => addDays(localDateOf(new Date(), VN), 1);
const dueJob = (date: string) => jobsRepo.getOccurrenceJob(USER_ID, "checklist_due", A, date);

test("marking a day done cancels its reminder; clearing the mark or marking it open brings it back", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  const date = tomorrow();
  await putSchedule(A, daily({ start_date: date }));
  assert.equal((await dueJob(date))?.status, "pending");

  await putStatus(A, date, { status: "done" });
  assert.equal((await dueJob(date))?.status, "cancelled", "done by hand -> no reminder");

  await deleteStatus(A, date);
  assert.equal((await dueJob(date))?.status, "pending", "back to automatic -> reminded again");

  await putStatus(A, date, { status: "done" });
  await putStatus(A, date, { status: "open" });
  assert.equal((await dueJob(date))?.status, "pending", "reset by hand -> reminded again");
});

test("a late checklist is never nudged repeatedly, whatever the mark says", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  const NOW = new Date("2026-06-20T01:00:00.000Z"); // 08:00 in Vietnam, schedule at 07:30
  await schedulesRepo.upsertSchedule(USER_ID, A, {
    start_date: "2026-06-20", time: "07:30", recurrence_type: "daily", recurrence_interval: 1,
    recurrence_days_of_week: null, recurrence_end_date: null, enabled: true,
  });
  const nudges = async () =>
    (await fx.jobsFor(turso, USER_ID, "AND kind = 'checklist_overdue'")).length;

  await reconcileChecklistDue(USER_ID, A, NOW);
  assert.equal(await nudges(), 0, "late and not done -> no nudge is armed");
  assert.equal((await dueJob("2026-06-20"))?.status, "pending", "the 30-minute-late reminder itself is still sent");

  await insertMark({ localDate: "2026-06-20", status: "done" });
  await reconcileChecklistDue(USER_ID, A, NOW);
  assert.equal(await nudges(), 0);
  assert.equal((await dueJob("2026-06-20"))?.status, "cancelled");

  await turso.execute("UPDATE checklist_occurrence_marks SET status = 'open'");
  await reconcileChecklistDue(USER_ID, A, NOW);
  assert.equal(await nudges(), 0, "reset by hand -> still no nudge");
  assert.equal((await dueJob("2026-06-20"))?.status, "pending", "reset by hand -> reminded again");
});

test("the planner and the pre-send check both honour the mark", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  const NOW = new Date("2026-06-20T00:00:00.000Z"); // 07:00 in Vietnam
  await schedulesRepo.upsertSchedule(USER_ID, A, {
    start_date: "2026-06-20", time: "07:30", recurrence_type: "daily", recurrence_interval: 1,
    recurrence_days_of_week: null, recurrence_end_date: null, enabled: true,
  });
  await insertMark({ localDate: "2026-06-20", status: "done" });

  await planner.planAllUsers(NOW);
  assert.equal(await dueJob("2026-06-20"), null, "no job for the day that is already done");
  assert.ok(await dueJob("2026-06-21"), "tomorrow is planned as usual");
  assert.equal(await checkOccurrenceOpen(USER_ID, A, "2026-06-20", VN), null);
  assert.ok(await checkOccurrenceOpen(USER_ID, A, "2026-06-21", VN));

  await turso.execute("DELETE FROM checklist_occurrence_marks");
  assert.ok(await checkOccurrenceOpen(USER_ID, A, "2026-06-20", VN), "mark gone -> the send check passes again");
});

test("a run that starts at 23:30 and ends at 00:30 does not silence the NEXT day's reminder", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  await schedulesRepo.upsertSchedule(USER_ID, A, {
    start_date: "2026-06-19", time: "07:30", recurrence_type: "daily", recurrence_interval: 1,
    recurrence_days_of_week: null, recurrence_end_date: null, enabled: true,
  });
  await fx.insertRun(turso, {
    id: "r-night",
    templateId: A,
    startedAt: "2026-06-19T16:30:00.000Z", // 23:30 on the 19th
    completedAt: "2026-06-19T17:30:00.000Z", // 00:30 on the 20th
  });

  const NOW = new Date("2026-06-19T17:40:00.000Z"); // 00:40 on the 20th
  await reconcileChecklistDue(USER_ID, A, NOW);

  assert.equal((await dueJob("2026-06-20"))?.status, "pending", "the 20th is still to do");
  assert.equal(await checkOccurrenceOpen(USER_ID, A, "2026-06-19", VN), null, "the 19th is done");
  assert.ok(await checkOccurrenceOpen(USER_ID, A, "2026-06-20", VN));
});

test("a one-off checklist marked done on its day is finished: the schedule goes away, like a completed run", async () => {
  const today = localDateOf(new Date(), VN);
  await putSchedule(A, daily({ start_date: today, recurrence_type: null }));
  assert.equal((await call("GET", `/checklists/templates/${A}/schedule`)).status, 200);

  const put = await putStatus(A, today, { status: "done" });
  assert.equal(put.status, 200);

  assert.equal((await call("GET", `/checklists/templates/${A}/schedule`)).status, 404);
  assert.deepEqual((await occurrences(today, today)).body.items, []);
});

test("a repeating checklist is never finished by a mark", async () => {
  const today = localDateOf(new Date(), VN);
  await putSchedule(A, daily({ start_date: today }));
  await putStatus(A, today, { status: "done" });
  assert.equal((await call("GET", `/checklists/templates/${A}/schedule`)).status, 200);
});

const linkHabit = async (templateId = A): Promise<string> => {
  await fx.insertHabit(turso, { id: "habit-1" });
  await turso.execute({ sql: "UPDATE habits SET checklist_template_id = ? WHERE id = 'habit-1'", args: [templateId] });
  return "habit-1";
};

test("marking a day done ticks the habit linked to the checklist for THAT day; resetting it keeps the log", async () => {
  const habitId = await linkHabit();
  await putSchedule(A, daily());

  await putStatus(A, "2026-06-02", { status: "done" });
  assert.equal((await habitsRepo.getLog(habitId, "2026-06-02"))?.completed, 1);

  await putStatus(A, "2026-06-02", { status: "open" });
  assert.equal((await habitsRepo.getLog(habitId, "2026-06-02"))?.completed, 1, "history is not rewritten");
  assert.equal(await habitsRepo.getLog(habitId, "2026-06-03"), null);
});

test("a run that crosses midnight ticks the habit on the day it STARTED", async () => {
  const habitId = await linkHabit();
  await autoLogHabitsForCompletedRun(USER_ID, {
    template_id: A,
    status: "completed",
    started_at: "2026-06-19T16:30:00.000Z", // 23:30 on the 19th
    completed_at: "2026-06-19T17:30:00.000Z", // 00:30 on the 20th
    updated_at: "2026-06-19T17:30:00.000Z",
    deleted_at: null,
  });
  assert.equal((await habitsRepo.getLog(habitId, "2026-06-19"))?.completed, 1);
  assert.equal(await habitsRepo.getLog(habitId, "2026-06-20"), null);
});

test("deleting the checklist removes its marks too", async () => {
  await turso.execute({ sql: "UPDATE checklist_templates SET user_id = ?, is_system = 0 WHERE id = ?", args: [USER_ID, A] });
  await putSchedule(A, daily());
  await putStatus(A, "2026-06-02", { status: "done" });

  await checklistsService.deleteTemplate(USER_ID, A);

  assert.equal((await liveRows("checklist_occurrence_marks")).length, 0);
  const tombstone = await schedulesRepo.listLiveMarksForUsers([USER_ID], "2026-01-01", "2026-12-31");
  assert.deepEqual(tombstone, []);
});

test("the service rejects an unknown checklist without touching the table", async () => {
  await assert.rejects(
    () => schedulesService.putOccurrenceStatus(USER_ID, "tst-missing", "2026-06-02", "done"),
    (e: unknown) => e instanceof schedulesService.ScheduleServiceError && e.code === "not_found"
  );
  assert.equal((await turso.execute("SELECT * FROM checklist_occurrence_marks")).rows.length, 0);
});

// ── sync ─────────────────────────────────────────────────────────────────────

const NOW = "2026-06-01T00:00:00.000Z";
const LATER = "2026-06-02T12:00:00.000Z";
const EARLIER = "2026-05-30T00:00:00.000Z";

const markPayload = (id: string, overrides: Json = {}): Json => ({
  id,
  template_id: A,
  local_date: "2026-06-02",
  status: "done",
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});
const push = (op: "create" | "update" | "delete", payload: Json, userId = USER_ID) =>
  processPush(userId, [{ op, type: "checklist_occurrence_mark", payload } as never]);

test("sync: a pushed mark is stored, shown over REST, and returned by pull", async () => {
  await putSchedule(A, daily());
  const [result] = await push("create", markPayload("mark-1"));
  assert.deepEqual(result, { id: "mark-1", status: "applied" });

  const item = (await occurrences("2026-06-02", "2026-06-02")).body.items[0];
  assert.deepEqual([item.done, item.manual], [true, "done"]);

  const pulled = (await getChangesSince(USER_ID, null)).checklist_occurrence_marks as Json[];
  assert.equal(pulled.length, 1);
  assert.deepEqual(
    { ...pulled[0] },
    { id: "mark-1", user_id: USER_ID, template_id: A, local_date: "2026-06-02", status: "done", created_at: NOW, updated_at: NOW, deleted_at: null }
  );
});

test("sync: a pushed mark cancels the reminder of that day and ticks the linked habit", async () => {
  await fx.insertDevice(turso, USER_ID, "reg-A", { id: "device-A" });
  const habitId = await linkHabit();
  const date = tomorrow();
  await putSchedule(A, daily({ start_date: date }));
  assert.equal((await dueJob(date))?.status, "pending");

  await push("create", markPayload("mark-1", { local_date: date, updated_at: new Date().toISOString() }));

  assert.equal((await dueJob(date))?.status, "cancelled");
  assert.equal((await habitsRepo.getLog(habitId, date))?.completed, 1);
});

test("sync: a mark works for a day the app marked before it has any schedule rows on the server", async () => {
  // The app sends the mark and the schedule in one batch, in either order.
  const [result] = await push("create", markPayload("mark-early"));
  assert.equal(result.status, "applied");
  assert.equal((await liveRows("checklist_occurrence_marks")).length, 1);
});

test("sync: an invalid mark is bad_input and nothing is written", async () => {
  const bad: Json[] = [
    markPayload("m1", { status: "maybe" }),
    markPayload("m2", { status: undefined }),
    markPayload("m3", { local_date: "2026-02-30" }),
    markPayload("m4", { local_date: "02/06/2026" }),
    markPayload("m5", { template_id: "" }),
    markPayload("m6", { template_id: undefined }),
  ];
  for (const payload of bad) {
    const [result] = await push("create", payload);
    assert.deepEqual(result, { id: payload.id, status: "error", error: "bad_input" }, String(payload.id));
  }
  assert.equal((await turso.execute("SELECT * FROM checklist_occurrence_marks")).rows.length, 0);
});

test("sync: a mark for someone else's checklist is not written", async () => {
  await push("create", markPayload("mark-x", { template_id: FOREIGN }));
  assert.equal((await turso.execute("SELECT * FROM checklist_occurrence_marks")).rows.length, 0);
});

test("sync: another user's mark id cannot be taken over", async () => {
  await fx.insertSystemTemplate(turso, { id: "tst-sys", title: "Mẫu hệ thống", itemCount: 1 });
  await push("create", markPayload("theirs", { template_id: "tst-sys" }), OTHER_USER_ID);

  const [update] = await push("update", markPayload("theirs", { template_id: "tst-sys", status: "open", updated_at: LATER }));
  assert.equal(update.status, "error");
  assert.equal(update.error, "forbidden");
  const [del] = await push("delete", { id: "theirs", updated_at: LATER, deleted_at: LATER });
  assert.equal(del.error, "forbidden");
  assert.equal(((await liveRows("checklist_occurrence_marks"))[0] as Json).status, "done");
});

test("sync: Last-Write-Wins - an older push does not overwrite a newer mark", async () => {
  await push("create", markPayload("mark-1", { status: "open", updated_at: LATER }));
  await push("update", markPayload("mark-1", { status: "done", updated_at: EARLIER }));
  assert.equal(((await liveRows("checklist_occurrence_marks"))[0] as Json).status, "open");

  await push("update", markPayload("mark-1", { status: "done", updated_at: "2026-06-03T00:00:00.000Z" }));
  assert.equal(((await liveRows("checklist_occurrence_marks"))[0] as Json).status, "done");
});

test("sync: two devices marking the same day end up with ONE row, the newer mark wins", async () => {
  await push("create", markPayload("device-1-id", { status: "done", updated_at: NOW }));
  await push("create", markPayload("device-2-id", { status: "open", updated_at: LATER }));

  const rows = await liveRows("checklist_occurrence_marks");
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as Json).id, "device-1-id", "merged into the existing row");
  assert.equal((rows[0] as Json).status, "open");
  assert.equal((rows[0] as Json).updated_at, LATER);

  await push("create", markPayload("device-3-id", { status: "done", updated_at: EARLIER }));
  assert.equal(((await liveRows("checklist_occurrence_marks"))[0] as Json).status, "open", "an older mark loses");
});

test("sync: a mark pushed with an explicit time decides 'completed again after the reset'", async () => {
  await putSchedule(A, daily());
  await fx.insertRun(turso, { id: "r1", templateId: A, startedAt: "2026-06-02T01:00:00.000Z", completedAt: "2026-06-02T01:10:00.000Z" });
  await push("create", markPayload("mark-1", { status: "open", updated_at: "2026-06-02T02:00:00.000Z" }));
  assert.equal((await occurrences("2026-06-02", "2026-06-02")).body.items[0].done, false);

  await fx.insertRun(turso, { id: "r2", templateId: A, startedAt: "2026-06-02T09:00:00.000Z", completedAt: "2026-06-02T09:10:00.000Z" });
  assert.equal((await occurrences("2026-06-02", "2026-06-02")).body.items[0].done, true, "second run of the day");
});

test("sync: deleting a mark leaves a tombstone in the delta, is idempotent, and the day goes back to automatic", async () => {
  await putSchedule(A, daily());
  await fx.insertRun(turso, { id: "r1", templateId: A, startedAt: "2026-06-02T01:00:00.000Z", completedAt: "2026-06-02T01:10:00.000Z" });
  await push("create", markPayload("mark-1", { status: "open", updated_at: "2026-06-02T02:00:00.000Z" }));
  assert.equal((await occurrences("2026-06-02", "2026-06-02")).body.items[0].done, false);

  const [del] = await push("delete", { id: "mark-1", updated_at: LATER, deleted_at: LATER });
  assert.deepEqual(del, { id: "mark-1", status: "applied" });
  assert.equal((await occurrences("2026-06-02", "2026-06-02")).body.items[0].done, true);

  const delta = await getChangesSince(USER_ID, NOW);
  assert.ok(((delta.checklist_occurrence_marks as Json[]).find((m) => m.id === "mark-1") as Json).deleted_at);
  assert.equal((await getChangesSince(USER_ID, null)).checklist_occurrence_marks.length, 0, "no `since` -> live rows only");

  assert.equal((await push("delete", { id: "mark-1", updated_at: LATER, deleted_at: LATER }))[0].status, "applied");
  assert.equal((await push("delete", { id: "never-existed", updated_at: LATER, deleted_at: LATER }))[0].status, "applied");
});

test("sync: a mark pushed again after being deleted brings the same row back", async () => {
  await push("create", markPayload("mark-1", { updated_at: NOW }));
  await push("delete", { id: "mark-1", updated_at: LATER, deleted_at: LATER });
  await push("create", markPayload("mark-new-id", { status: "open", updated_at: "2026-06-03T00:00:00.000Z" }));

  const all = await turso.execute("SELECT * FROM checklist_occurrence_marks");
  assert.equal(all.rows.length, 1);
  const row = all.rows[0] as unknown as Json;
  assert.equal(row.id, "mark-1");
  assert.equal(row.status, "open");
  assert.equal(row.deleted_at, null);
});

test("sync: deleting the checklist through sync removes its marks and they appear as tombstones", async () => {
  await turso.execute({ sql: "UPDATE checklist_templates SET user_id = ?, is_system = 0 WHERE id = ?", args: [USER_ID, A] });
  await push("create", markPayload("mark-1"));

  const [del] = await processPush(USER_ID, [
    { op: "delete", type: "checklist_template", payload: { id: A, updated_at: LATER, deleted_at: LATER } } as never,
  ]);
  assert.equal(del.status, "applied");

  assert.equal((await liveRows("checklist_occurrence_marks")).length, 0);
  const delta = await getChangesSince(USER_ID, NOW);
  assert.ok(((delta.checklist_occurrence_marks as Json[]).find((m) => m.id === "mark-1") as Json).deleted_at);
});

test("deleting a schedule keeps the marks: they belong to the checklist's days, not to the schedule", async () => {
  await putSchedule(A, daily());
  await putStatus(A, "2026-06-02", { status: "done" });
  await call("DELETE", `/checklists/templates/${A}/schedule`);
  assert.equal((await liveRows("checklist_occurrence_marks")).length, 1);
});

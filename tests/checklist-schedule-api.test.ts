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
const { getChangesSince } = await import("../src/repositories/sync.repo.js");
const { processPush } = await import("../src/services/sync.service.js");
const { default: Fastify } = await import("fastify");
const { default: userAuth } = await import("../src/plugins/user-auth.js");
const { default: checklistsRoutes } = await import("../src/routes/api/v1/checklists.js");
const { signUserToken } = await import("../src/services/api-auth.js");
const { addDays, localDateOf } = await import("../src/utils/time.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const fx = await import("./helpers/notification-fixtures.js");

const { USER_ID, OTHER_USER_ID } = fx;
const A = "tst-rời-nhà"; // 3 steps, "Rời nhà"
const B = "tst-đi-ngủ"; // 2 steps, "Đi ngủ"
const SYS = "tst-sys"; // shared system checklist, 1 step
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
    "checklist_schedule_overrides",
    "checklist_schedules",
    "checklist_run_items",
    "checklist_runs",
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
  await fx.insertSystemTemplate(turso, { id: SYS, title: "Mẫu hệ thống", itemCount: 1 });
});

const auth = (userId = USER_ID) => ({
  authorization: `Bearer ${signUserToken(app, userId)}`,
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
    headers: auth(userId),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Json) : {} };
};

const putSchedule = (id: string, body: unknown, userId?: string) =>
  call("PUT", `/checklists/templates/${id}/schedule`, body, userId);
const getSchedule = (id: string, userId?: string) =>
  call("GET", `/checklists/templates/${id}/schedule`, undefined, userId);
const deleteSchedule = (id: string, userId?: string) =>
  call("DELETE", `/checklists/templates/${id}/schedule`, undefined, userId);
const occurrences = (from: string, to: string, userId?: string) =>
  call("GET", `/checklists/occurrences?from=${from}&to=${to}`, undefined, userId);
const putOccurrence = (id: string, date: string, body: unknown, userId?: string) =>
  call("PUT", `/checklists/templates/${id}/occurrences/${date}`, body, userId);
const deleteOccurrence = (id: string, date: string, userId?: string) =>
  call("DELETE", `/checklists/templates/${id}/occurrences/${date}`, undefined, userId);

const daily = (overrides: Json = {}): Json => ({
  start_date: "2026-06-01",
  time: "07:30",
  recurrence_type: "daily",
  ...overrides,
});

const liveRows = async (table: string, where = "1=1") =>
  (await turso.execute(`SELECT * FROM ${table} WHERE deleted_at IS NULL AND ${where}`)).rows;

// ── auth ─────────────────────────────────────────────────────────────────────

test("every schedule endpoint requires a login", async () => {
  const calls: Array<[string, string]> = [
    ["GET", `/checklists/templates/${A}/schedule`],
    ["PUT", `/checklists/templates/${A}/schedule`],
    ["DELETE", `/checklists/templates/${A}/schedule`],
    ["PUT", `/checklists/templates/${A}/occurrences/2026-06-02`],
    ["DELETE", `/checklists/templates/${A}/occurrences/2026-06-02`],
    ["GET", "/checklists/occurrences?from=2026-06-01&to=2026-06-02"],
  ];
  for (const [method, url] of calls) {
    const res = await app.inject({ method: method as "GET", url });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
});

// ── PUT / GET / DELETE schedule ──────────────────────────────────────────────

test("PUT creates the schedule and answers with it; GET returns the same", async () => {
  const put = await putSchedule(A, daily({ recurrence_interval: 2, recurrence_end_date: "2026-12-31" }));

  assert.equal(put.status, 200);
  const { schedule } = put.body;
  assert.equal(schedule.template_id, A);
  assert.equal(schedule.start_date, "2026-06-01");
  assert.equal(schedule.time, "07:30");
  assert.equal(schedule.recurrence_type, "daily");
  assert.equal(schedule.recurrence_interval, 2);
  assert.equal(schedule.recurrence_days_of_week, null);
  assert.equal(schedule.recurrence_end_date, "2026-12-31");
  assert.equal(schedule.enabled, true, "enabled defaults to true and is a boolean");
  assert.equal(typeof schedule.id, "string");
  assert.equal(typeof schedule.created_at, "string");
  assert.equal(typeof schedule.updated_at, "string");
  assert.equal("user_id" in schedule, false, "no server-only fields");
  assert.equal("deleted_at" in schedule, false);

  const get = await getSchedule(A);
  assert.equal(get.status, 200);
  assert.deepEqual(get.body, { schedule });
});

test("input is normalised the same way for every kind of repeat", async () => {
  const cases: Array<[string, Json, Json]> = [
    [
      "no repeat drops interval and weekdays but keeps the end date",
      { start_date: "2026-06-01", time: "07:30", recurrence_interval: 3, recurrence_days_of_week: "1,2", recurrence_end_date: "2026-07-01" },
      { recurrence_type: null, recurrence_interval: null, recurrence_days_of_week: null, recurrence_end_date: "2026-07-01" },
    ],
    [
      "explicit null type is the same as no repeat",
      { start_date: "2026-06-01", time: "07:30", recurrence_type: null, recurrence_interval: 3 },
      { recurrence_type: null, recurrence_interval: null, recurrence_days_of_week: null, recurrence_end_date: null },
    ],
    [
      "daily defaults the interval to 1 and drops weekdays",
      daily({ recurrence_days_of_week: "1,2" }),
      { recurrence_type: "daily", recurrence_interval: 1, recurrence_days_of_week: null },
    ],
    [
      "custom keeps the interval",
      daily({ recurrence_type: "custom", recurrence_interval: 10 }),
      { recurrence_type: "custom", recurrence_interval: 10, recurrence_days_of_week: null },
    ],
    [
      "weekly sorts and de-duplicates weekdays",
      daily({ recurrence_type: "weekly", recurrence_days_of_week: "5,1,3,1" }),
      { recurrence_type: "weekly", recurrence_interval: 1, recurrence_days_of_week: "1,3,5" },
    ],
    [
      "weekly without weekdays keeps null",
      daily({ recurrence_type: "weekly" }),
      { recurrence_type: "weekly", recurrence_interval: 1, recurrence_days_of_week: null },
    ],
  ];
  for (const [label, body, expected] of cases) {
    const res = await putSchedule(A, body);
    assert.equal(res.status, 200, label);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(res.body.schedule[key], value, `${label}: ${key}`);
    }
  }
});

const invalidBodies: Array<[string, unknown]> = [
  ["a missing start_date", { time: "07:30", recurrence_type: "daily" }],
  ["a missing time", { start_date: "2026-06-01", recurrence_type: "daily" }],
  ["a time without a leading zero", daily({ time: "7:30" })],
  ["24:00", daily({ time: "24:00" })],
  ["minutes 60", daily({ time: "07:60" })],
  ["a time with seconds", daily({ time: "07:30:00" })],
  ["a non-existent date", daily({ start_date: "2026-02-30" })],
  ["a malformed date", daily({ start_date: "2026-6-1" })],
  ["a non-existent end date", daily({ recurrence_end_date: "2026-13-01" })],
  ["an end date before the start date", daily({ recurrence_end_date: "2026-05-31" })],
  ["an unknown repeat type", daily({ recurrence_type: "monthly" })],
  ["interval 0", daily({ recurrence_interval: 0 })],
  ["interval 366", daily({ recurrence_interval: 366 })],
  ["a fractional interval", daily({ recurrence_interval: 1.5 })],
  ["a string interval", daily({ recurrence_interval: "2" })],
  ["weekday 0", daily({ recurrence_type: "weekly", recurrence_days_of_week: "0" })],
  ["weekday 8", daily({ recurrence_type: "weekly", recurrence_days_of_week: "8" })],
  ["an empty weekday entry", daily({ recurrence_type: "weekly", recurrence_days_of_week: "1,,3" })],
  ["a trailing comma", daily({ recurrence_type: "weekly", recurrence_days_of_week: "1,3," })],
  ["a non-boolean enabled", daily({ enabled: "yes" })],
  ["a body that is an array", ["nope"]],
];

for (const [label, body] of invalidBodies) {
  test(`PUT schedule rejects ${label} with 400 bad_input and writes nothing`, async () => {
    const res = await putSchedule(A, body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "bad_input");
    assert.ok(Array.isArray(res.body.issues));
    assert.equal((await liveRows("checklist_schedules")).length, 0);
  });
}

test("an end date equal to the start date is allowed", async () => {
  const res = await putSchedule(A, daily({ recurrence_end_date: "2026-06-01" }));
  assert.equal(res.status, 200);
});

test("a second PUT replaces the schedule in place: one row, same id, new values", async () => {
  const first = await putSchedule(A, daily());
  const second = await putSchedule(A, daily({ time: "21:00", recurrence_type: "weekly", recurrence_days_of_week: "6,7" }));

  assert.equal(second.status, 200);
  assert.equal(second.body.schedule.id, first.body.schedule.id);
  assert.equal(second.body.schedule.time, "21:00");
  assert.equal(second.body.schedule.created_at, first.body.schedule.created_at);
  assert.equal((await liveRows("checklist_schedules")).length, 1);
});

test("enabled:false keeps the schedule but turns it off, and it disappears from occurrences", async () => {
  await putSchedule(A, daily());
  assert.equal((await occurrences("2026-06-01", "2026-06-03")).body.items.length, 3);

  const off = await putSchedule(A, daily({ enabled: false }));
  assert.equal(off.body.schedule.enabled, false);
  assert.equal((await getSchedule(A)).body.schedule.enabled, false);
  assert.deepEqual((await occurrences("2026-06-01", "2026-06-03")).body.items, []);
});

test("DELETE is 204, removes the schedule, is idempotent, and PUT revives it", async () => {
  const created = await putSchedule(A, daily());
  assert.equal((await deleteSchedule(A)).status, 204);
  assert.equal((await getSchedule(A)).status, 404);
  assert.equal((await getSchedule(A)).body.error, "not_found");
  assert.equal((await deleteSchedule(A)).status, 204, "deleting again is fine");
  assert.equal((await deleteSchedule(B)).status, 204, "deleting a schedule that never existed is fine");

  const revived = await putSchedule(A, daily({ time: "09:15" }));
  assert.equal(revived.status, 200);
  assert.equal(revived.body.schedule.time, "09:15");
  assert.equal(revived.body.schedule.id, created.body.schedule.id, "the same row comes back");
  assert.equal((await liveRows("checklist_schedules")).length, 1);
});

test("GET schedule is 404 for a checklist that has none", async () => {
  const res = await getSchedule(A);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "not_found");
});

test("an unknown checklist and another user's checklist are both 404 on every endpoint", async () => {
  for (const id of ["tst-does-not-exist", FOREIGN]) {
    assert.equal((await getSchedule(id)).status, 404, `GET ${id}`);
    assert.equal((await putSchedule(id, daily())).status, 404, `PUT ${id}`);
    assert.equal((await deleteSchedule(id)).status, 404, `DELETE ${id}`);
    assert.equal((await putOccurrence(id, "2026-06-02", { time: "08:00" })).status, 404, `PUT occ ${id}`);
    assert.equal((await deleteOccurrence(id, "2026-06-02")).status, 404, `DELETE occ ${id}`);
  }
  assert.equal((await liveRows("checklist_schedules")).length, 0);
});

test("a system checklist can be scheduled, per user, without touching the shared template", async () => {
  const mine = await putSchedule(SYS, daily({ time: "06:00" }));
  const theirs = await putSchedule(SYS, daily({ time: "22:00" }), OTHER_USER_ID);
  assert.equal(mine.status, 200);
  assert.equal(theirs.status, 200);

  assert.equal((await getSchedule(SYS)).body.schedule.time, "06:00");
  assert.equal((await getSchedule(SYS, OTHER_USER_ID)).body.schedule.time, "22:00");

  await deleteSchedule(SYS);
  assert.equal((await getSchedule(SYS)).status, 404);
  assert.equal((await getSchedule(SYS, OTHER_USER_ID)).status, 200, "the other user's schedule is untouched");
  const template = await turso.execute({ sql: "SELECT deleted_at, updated_at FROM checklist_templates WHERE id = ?", args: [SYS] });
  assert.equal((template.rows[0] as any).deleted_at, null);
});

test("a user cannot see or change another user's schedule", async () => {
  await putSchedule(SYS, daily({ time: "22:00" }), OTHER_USER_ID);
  assert.equal((await getSchedule(SYS)).status, 404);
  assert.deepEqual((await occurrences("2026-06-01", "2026-06-05")).body.items, []);
});

test("GET template includes the schedule, or null", async () => {
  const none = await call("GET", `/checklists/templates/${A}`);
  assert.equal(none.status, 200);
  assert.equal(none.body.schedule, null);
  assert.equal(none.body.items.length, 3);
  assert.equal(none.body.template.id, A);

  const { schedule } = (await putSchedule(A, daily())).body;
  const withSchedule = await call("GET", `/checklists/templates/${A}`);
  assert.deepEqual(withSchedule.body.schedule, schedule);

  await deleteSchedule(A);
  assert.equal((await call("GET", `/checklists/templates/${A}`)).body.schedule, null);
});

test("deleting a checklist removes its schedule and overrides from every listing", async () => {
  await putSchedule(A, daily());
  await putOccurrence(A, "2026-06-03", { time: "09:00" });

  assert.equal((await call("DELETE", `/checklists/templates/${A}`)).status, 204);

  assert.equal((await liveRows("checklist_schedules")).length, 0);
  assert.equal((await liveRows("checklist_schedule_overrides")).length, 0);
  assert.deepEqual((await occurrences("2026-06-01", "2026-06-05")).body.items, []);
});

test("PUT/DELETE schedule creates and cancels the reminder job", async () => {
  const tomorrow = addDays(localDateOf(new Date(), "Asia/Ho_Chi_Minh"), 1);
  await putSchedule(A, daily({ start_date: tomorrow }));
  const created = await jobsRepo.getOccurrenceJob(USER_ID, "checklist_due", A, tomorrow);
  assert.equal(created?.status, "pending");

  await deleteSchedule(A);
  const cancelled = await jobsRepo.getOccurrenceJob(USER_ID, "checklist_due", A, tomorrow);
  assert.equal(cancelled?.status, "cancelled");
});

// ── GET /occurrences ─────────────────────────────────────────────────────────

test("occurrences are returned in the documented shape, sorted by date, time then title", async () => {
  await putSchedule(A, daily({ time: "08:00", recurrence_end_date: "2099-06-02" }));
  await putSchedule(B, daily({ time: "07:00" }));

  const res = await occurrences("2099-06-01", "2099-06-02");

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    items: [
      { checklistId: B, title: "Đi ngủ", stepCount: 2, date: "2099-06-01", time: "07:00", overridden: false, done: false },
      { checklistId: A, title: "Rời nhà", stepCount: 3, date: "2099-06-01", time: "08:00", overridden: false, done: false },
      { checklistId: B, title: "Đi ngủ", stepCount: 2, date: "2099-06-02", time: "07:00", overridden: false, done: false },
      { checklistId: A, title: "Rời nhà", stepCount: 3, date: "2099-06-02", time: "08:00", overridden: false, done: false },
    ],
  });
});

test("same date and time: ties are broken by title", async () => {
  await putSchedule(A, daily({ time: "08:00", recurrence_type: null, start_date: "2099-06-01" }));
  await putSchedule(B, daily({ time: "08:00", recurrence_type: null, start_date: "2099-06-01" }));
  const titles = (await occurrences("2099-06-01", "2099-06-01")).body.items.map((i: Json) => i.title);
  assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b)));
  assert.equal(titles.length, 2);
});

test("repeat rules are expanded: weekly days, interval, end date, and a one-off", async () => {
  await putSchedule(A, daily({ recurrence_type: "weekly", recurrence_days_of_week: "1,3", start_date: "2099-06-01" }));
  await putSchedule(B, daily({ recurrence_type: "custom", recurrence_interval: 3, recurrence_end_date: "2099-06-07", start_date: "2099-06-01" }));
  await putSchedule(SYS, daily({ recurrence_type: null, start_date: "2099-06-04" }));

  const items = (await occurrences("2099-06-01", "2099-06-10")).body.items as Json[];
  const datesOf = (id: string) => items.filter((i) => i.checklistId === id).map((i) => i.date);

  assert.deepEqual(datesOf(A), ["2099-06-01", "2099-06-03", "2099-06-08", "2099-06-10"]);
  assert.deepEqual(datesOf(B), ["2099-06-01", "2099-06-04", "2099-06-07"]);
  assert.deepEqual(datesOf(SYS), ["2099-06-04"]);
});

test("only the requested window is returned, including across a month boundary", async () => {
  await putSchedule(A, daily());
  const items = (await occurrences("2026-06-29", "2026-07-02")).body.items as Json[];
  assert.deepEqual(items.map((i) => i.date), ["2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02"]);
  assert.deepEqual((await occurrences("2026-05-20", "2026-05-31")).body.items, [], "before the schedule starts");
});

test("a schedule that has not started yet is not listed before its start date", async () => {
  await putSchedule(A, daily({ start_date: "2026-06-10" }));
  const items = (await occurrences("2026-06-08", "2026-06-11")).body.items as Json[];
  assert.deepEqual(items.map((i) => i.date), ["2026-06-10", "2026-06-11"]);
});

const badRanges: Array<[string, string]> = [
  ["missing parameters", "/checklists/occurrences"],
  ["a missing to", "/checklists/occurrences?from=2026-06-01"],
  ["a missing from", "/checklists/occurrences?to=2026-06-01"],
  ["a malformed date", "/checklists/occurrences?from=2026-6-1&to=2026-06-05"],
  ["a non-existent date", "/checklists/occurrences?from=2026-02-30&to=2026-03-05"],
  ["from after to", "/checklists/occurrences?from=2026-06-05&to=2026-06-01"],
  ["63 days", "/checklists/occurrences?from=2026-06-01&to=2026-08-02"],
  ["a whole year", "/checklists/occurrences?from=2026-01-01&to=2026-12-31"],
];

for (const [label, url] of badRanges) {
  test(`GET occurrences rejects ${label}`, async () => {
    const res = await call("GET", url);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "bad_input");
  });
}

test("GET occurrences accepts exactly 62 days and a single day", async () => {
  await putSchedule(A, daily());
  const wide = await occurrences("2026-06-01", "2026-08-01");
  assert.equal(wide.status, 200);
  assert.equal(wide.body.items.length, 62);
  const one = await occurrences("2026-06-05", "2026-06-05");
  assert.equal(one.body.items.length, 1);
});

test("a per-day override changes that day's time, is flagged, and leaves the others alone", async () => {
  await putSchedule(A, daily());
  const put = await putOccurrence(A, "2026-06-02", { time: "21:15" });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, { checklistId: A, date: "2026-06-02", time: "21:15", overridden: true });

  const items = (await occurrences("2026-06-01", "2026-06-03")).body.items as Json[];
  assert.deepEqual(
    items.map((i) => [i.date, i.time, i.overridden]),
    [
      ["2026-06-01", "07:30", false],
      ["2026-06-02", "21:15", true],
      ["2026-06-03", "07:30", false],
    ]
  );
});

test("overriding twice keeps one row with the latest time; deleting restores the schedule time", async () => {
  await putSchedule(A, daily());
  await putOccurrence(A, "2026-06-02", { time: "21:15" });
  await putOccurrence(A, "2026-06-02", { time: "22:45" });
  assert.equal((await liveRows("checklist_schedule_overrides")).length, 1);
  assert.equal(
    (await occurrences("2026-06-02", "2026-06-02")).body.items[0].time,
    "22:45"
  );

  assert.equal((await deleteOccurrence(A, "2026-06-02")).status, 204);
  const restored = (await occurrences("2026-06-02", "2026-06-02")).body.items[0];
  assert.equal(restored.time, "07:30");
  assert.equal(restored.overridden, false);
  assert.equal((await deleteOccurrence(A, "2026-06-02")).status, 204, "idempotent");
  assert.equal((await deleteOccurrence(A, "2026-06-09")).status, 204, "a day that never had one");
});

test("an override on a day that is not an occurrence is refused with 400 not_an_occurrence", async () => {
  await putSchedule(A, daily({ recurrence_type: "weekly", recurrence_days_of_week: "1", start_date: "2026-06-01" }));

  const res = await putOccurrence(A, "2026-06-02", { time: "08:00" }); // a Tuesday
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "not_an_occurrence");
  assert.equal((await liveRows("checklist_schedule_overrides")).length, 0);

  assert.equal((await putOccurrence(A, "2026-06-01", { time: "08:00" })).status, 200, "a Monday is fine");
  assert.equal((await putOccurrence(A, "2026-05-25", { time: "08:00" })).body.error, "not_an_occurrence", "before the start");
});

test("an override needs a schedule: 404 without one, 400 while it is disabled", async () => {
  assert.equal((await putOccurrence(A, "2026-06-02", { time: "08:00" })).status, 404);

  await putSchedule(A, daily({ enabled: false }));
  const res = await putOccurrence(A, "2026-06-02", { time: "08:00" });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "not_an_occurrence");
});

test("override input is validated", async () => {
  await putSchedule(A, daily());
  for (const [label, date, body] of [
    ["a bad time", "2026-06-02", { time: "25:00" }],
    ["a missing time", "2026-06-02", {}],
    ["a bad date", "2026-6-2", { time: "08:00" }],
    ["a non-existent date", "2026-02-30", { time: "08:00" }],
  ] as Array<[string, string, unknown]>) {
    const res = await putOccurrence(A, date, body);
    assert.equal(res.status, 400, label);
    assert.equal(res.body.error, "bad_input", label);
  }
  assert.equal((await deleteOccurrence(A, "2026-6-2")).status, 400);
  assert.equal((await liveRows("checklist_schedule_overrides")).length, 0);
});

test("deleting the schedule drops its overrides; a new schedule starts clean", async () => {
  await putSchedule(A, daily());
  await putOccurrence(A, "2026-06-02", { time: "21:15" });

  await deleteSchedule(A);
  assert.equal((await liveRows("checklist_schedule_overrides")).length, 0);

  await putSchedule(A, daily());
  const item = (await occurrences("2026-06-02", "2026-06-02")).body.items[0];
  assert.equal(item.time, "07:30");
  assert.equal(item.overridden, false);
});

test("an override left behind for a day the schedule no longer covers is ignored", async () => {
  await putSchedule(A, daily());
  await putOccurrence(A, "2099-06-04", { time: "21:15" });
  await putSchedule(A, daily({ recurrence_end_date: "2099-06-03" }));

  const items = (await occurrences("2099-06-01", "2099-06-10")).body.items as Json[];
  assert.deepEqual(items.map((i) => i.date), ["2099-06-01", "2099-06-02", "2099-06-03"]);
});

test("done means at least one COMPLETED run that local day", async () => {
  await putSchedule(A, daily());
  // 2026-06-02 in Vietnam
  await fx.insertRun(turso, { id: "r-ok", templateId: A, completedAt: "2026-06-02T03:00:00.000Z" });
  // abandoned, deleted and other-checklist runs on 2026-06-03 do not count
  await fx.insertRun(turso, { id: "r-ab", templateId: A, status: "abandoned", completedAt: "2026-06-03T03:00:00.000Z" });
  await fx.insertRun(turso, { id: "r-del", templateId: A, completedAt: "2026-06-03T04:00:00.000Z", deletedAt: "2026-06-03T05:00:00.000Z" });
  await fx.insertRun(turso, { id: "r-b", templateId: B, completedAt: "2026-06-03T06:00:00.000Z" });
  // another user's run of the same shared template does not count either
  await fx.insertRun(turso, { id: "r-other", templateId: A, userId: OTHER_USER_ID, completedAt: "2026-06-04T03:00:00.000Z" });

  const items = (await occurrences("2026-06-01", "2026-06-04")).body.items as Json[];
  assert.deepEqual(
    items.map((i) => [i.date, i.done]),
    [
      ["2026-06-01", false],
      ["2026-06-02", true],
      ["2026-06-03", false],
      ["2026-06-04", false],
    ]
  );
});

test("done uses the user's own day: 17:30 UTC is already the next day in Vietnam", async () => {
  await putSchedule(A, daily());
  await fx.insertRun(turso, { id: "r-late", templateId: A, completedAt: "2026-06-02T17:30:00.000Z" }); // 00:30 on the 3rd

  const items = (await occurrences("2026-06-02", "2026-06-03")).body.items as Json[];
  assert.deepEqual(items.map((i) => [i.date, i.done]), [["2026-06-02", false], ["2026-06-03", true]]);
});

test("another time zone: the same instant belongs to a different local day", async () => {
  // OTHER_USER_ID is in Pacific/Auckland (UTC+12 in June).
  await fx.insertTemplateWithItems(turso, { id: "tst-nz", userId: OTHER_USER_ID, title: "Buổi sáng", itemCount: 1 });
  await putSchedule("tst-nz", daily(), OTHER_USER_ID);
  await fx.insertRun(turso, { id: "r-nz", templateId: "tst-nz", userId: OTHER_USER_ID, completedAt: "2026-06-02T13:00:00.000Z" }); // 01:00 on the 3rd

  const items = (await occurrences("2026-06-02", "2026-06-03", OTHER_USER_ID)).body.items as Json[];
  assert.deepEqual(items.map((i) => [i.date, i.done]), [["2026-06-02", false], ["2026-06-03", true]]);
});

test("stepCount ignores deleted steps; a checklist with no steps reports 0", async () => {
  await putSchedule(A, daily({ recurrence_type: null, start_date: "2099-06-01" }));
  await turso.execute({ sql: "UPDATE checklist_template_items SET deleted_at = ? WHERE id = ?", args: ["2099-06-01T00:00:00.000Z", `${A}-item-1`] });
  assert.equal((await occurrences("2099-06-01", "2099-06-01")).body.items[0].stepCount, 2);

  await fx.insertTemplateWithItems(turso, { id: "tst-empty", title: "Trống", itemCount: 0 });
  await putSchedule("tst-empty", daily({ recurrence_type: null, start_date: "2099-06-01" }));
  const empty = (await occurrences("2099-06-01", "2099-06-01")).body.items.find((i: Json) => i.checklistId === "tst-empty");
  assert.equal(empty.stepCount, 0);
});

// ── sync ─────────────────────────────────────────────────────────────────────

const NOW = "2026-06-01T00:00:00.000Z";
const LATER = "2026-06-02T00:00:00.000Z";
const EARLIER = "2026-05-30T00:00:00.000Z";

const schedulePayload = (id: string, overrides: Json = {}): Json => ({
  id,
  template_id: A,
  start_date: "2026-06-01",
  time: "07:30",
  recurrence_type: "daily",
  recurrence_interval: 1,
  recurrence_days_of_week: null,
  recurrence_end_date: null,
  enabled: true,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const overridePayload = (id: string, overrides: Json = {}): Json => ({
  id,
  template_id: A,
  local_date: "2026-06-02",
  time: "21:15",
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const push = (type: "checklist_schedule" | "checklist_schedule_override", op: "create" | "update" | "delete", payload: Json) =>
  processPush(USER_ID, [{ op, type, payload } as never]);

test("sync: a pushed schedule is stored, visible over REST and in the pull delta", async () => {
  const [result] = await push("checklist_schedule", "create", schedulePayload("sched-1"));
  assert.deepEqual(result, { id: "sched-1", status: "applied" });

  assert.equal((await getSchedule(A)).body.schedule.id, "sched-1");
  assert.equal((await occurrences("2026-06-01", "2026-06-01")).body.items.length, 1);

  const live = await getChangesSince(USER_ID, null);
  const row = live.checklist_schedules.find((s) => s.id === "sched-1") as Json;
  assert.ok(row);
  assert.equal(row.template_id, A);
  assert.equal(row.enabled, true, "booleans on the wire");
  assert.equal(row.user_id, USER_ID, "pulled rows carry user_id like every other synced table");
});

test("sync: the pulled schedule carries every field the app needs", async () => {
  await push("checklist_schedule", "create", schedulePayload("sched-1", { recurrence_type: "weekly", recurrence_days_of_week: "3,1", recurrence_interval: 2, recurrence_end_date: "2026-12-31", enabled: false }));
  const row = (await getChangesSince(USER_ID, null)).checklist_schedules[0] as Json;
  assert.equal(row.recurrence_type, "weekly");
  assert.equal(row.recurrence_days_of_week, "1,3", "normalised like the REST route");
  assert.equal(row.recurrence_interval, 2);
  assert.equal(row.recurrence_end_date, "2026-12-31");
  assert.equal(row.enabled, false);
  assert.equal(row.deleted_at, null);
});

test("sync: the server keeps one schedule per checklist and tells the app to merge in place", async () => {
  await putSchedule(A, daily({ time: "07:30" })); // REST created it first
  const restId = (await getSchedule(A)).body.schedule.id as string;

  const [result] = await push("checklist_schedule", "create", schedulePayload("other-device-id", { time: "09:00", updated_at: "2999-01-01T00:00:00.000Z" }));

  assert.equal(result.status, "applied");
  const rows = await liveRows("checklist_schedules");
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as any).id, restId, "merged into the existing row");
  assert.equal((rows[0] as any).time, "09:00");
});

test("sync: Last-Write-Wins - an older push does not overwrite a newer schedule", async () => {
  await push("checklist_schedule", "create", schedulePayload("sched-1", { time: "09:00", updated_at: LATER }));
  await push("checklist_schedule", "update", schedulePayload("sched-1", { time: "05:00", updated_at: EARLIER }));
  assert.equal((await getSchedule(A)).body.schedule.time, "09:00");

  await push("checklist_schedule", "update", schedulePayload("sched-1", { time: "10:00", updated_at: "2026-06-03T00:00:00.000Z" }));
  assert.equal((await getSchedule(A)).body.schedule.time, "10:00");
});

test("sync: an invalid schedule is bad_input and nothing is written", async () => {
  const bad: Json[] = [
    schedulePayload("s1", { time: "7:30" }),
    schedulePayload("s2", { start_date: "2026-02-30" }),
    schedulePayload("s3", { recurrence_type: "monthly" }),
    schedulePayload("s4", { recurrence_interval: 0 }),
    schedulePayload("s5", { recurrence_days_of_week: "9", recurrence_type: "weekly" }),
    schedulePayload("s6", { recurrence_end_date: "2026-05-01" }),
    schedulePayload("s7", { template_id: "" }),
    schedulePayload("s8", { template_id: undefined }),
  ];
  for (const payload of bad) {
    const [result] = await push("checklist_schedule", "create", payload);
    assert.deepEqual(result, { id: payload.id, status: "error", error: "bad_input" }, String(payload.id));
  }
  assert.equal((await liveRows("checklist_schedules")).length, 0);
});

test("sync: a schedule for someone else's checklist is not written", async () => {
  await push("checklist_schedule", "create", schedulePayload("sched-x", { template_id: FOREIGN }));
  const all = await turso.execute("SELECT * FROM checklist_schedules");
  assert.equal(all.rows.length, 0);
});

test("sync: a schedule for a system checklist is allowed", async () => {
  const [result] = await push("checklist_schedule", "create", schedulePayload("sched-sys", { template_id: SYS }));
  assert.equal(result.status, "applied");
  assert.equal((await getSchedule(SYS)).status, 200);
});

test("sync: another user's schedule id cannot be taken over", async () => {
  await processPush(OTHER_USER_ID, [{ op: "create", type: "checklist_schedule", payload: schedulePayload("theirs", { template_id: SYS }) } as never]);

  const [update] = await push("checklist_schedule", "update", schedulePayload("theirs", { template_id: SYS, time: "01:00", updated_at: LATER }));
  assert.equal(update.status, "error");
  assert.equal(update.error, "forbidden");
  const [del] = await push("checklist_schedule", "delete", { id: "theirs", updated_at: LATER, deleted_at: LATER });
  assert.equal(del.error, "forbidden");
  assert.equal((await getSchedule(SYS, OTHER_USER_ID)).body.schedule.time, "07:30");
});

test("sync: deleting a schedule leaves a tombstone in the delta, removes its overrides, and is idempotent", async () => {
  await push("checklist_schedule", "create", schedulePayload("sched-1"));
  await push("checklist_schedule_override", "create", overridePayload("ov-1"));
  const before = LATER;

  const [del] = await push("checklist_schedule", "delete", { id: "sched-1", updated_at: before, deleted_at: before });
  assert.deepEqual(del, { id: "sched-1", status: "applied" });

  const delta = await getChangesSince(USER_ID, NOW);
  const tombstone = delta.checklist_schedules.find((s) => s.id === "sched-1") as Json;
  assert.ok(tombstone.deleted_at, "pull with `since` returns the soft-deleted row");
  const overrideTombstone = delta.checklist_schedule_overrides.find((s) => s.id === "ov-1") as Json;
  assert.ok(overrideTombstone.deleted_at, "its overrides are removed with it");

  const full = await getChangesSince(USER_ID, null);
  assert.equal(full.checklist_schedules.length, 0, "no `since` -> live rows only");

  const [again] = await push("checklist_schedule", "delete", { id: "sched-1", updated_at: before, deleted_at: before });
  assert.equal(again.status, "applied");
  const [unknown] = await push("checklist_schedule", "delete", { id: "never-existed", updated_at: before, deleted_at: before });
  assert.equal(unknown.status, "applied");
});

test("sync: a pushed override is stored, merged by (checklist, date), and shows up in occurrences", async () => {
  await push("checklist_schedule", "create", schedulePayload("sched-1"));
  const [first] = await push("checklist_schedule_override", "create", overridePayload("ov-1"));
  assert.equal(first.status, "applied");
  let item = (await occurrences("2026-06-02", "2026-06-02")).body.items[0];
  assert.equal(item.time, "21:15");
  assert.equal(item.overridden, true);

  await push("checklist_schedule_override", "create", overridePayload("ov-from-other-device", { time: "22:00", updated_at: LATER }));
  assert.equal((await liveRows("checklist_schedule_overrides")).length, 1, "one override per (checklist, date)");
  item = (await occurrences("2026-06-02", "2026-06-02")).body.items[0];
  assert.equal(item.time, "22:00");

  const pulled = (await getChangesSince(USER_ID, null)).checklist_schedule_overrides;
  assert.equal(pulled.length, 1);
  assert.equal((pulled[0] as Json).local_date, "2026-06-02");
});

test("sync: override validation and Last-Write-Wins", async () => {
  await push("checklist_schedule", "create", schedulePayload("sched-1"));
  for (const payload of [
    overridePayload("o1", { time: "25:00" }),
    overridePayload("o2", { local_date: "2026-02-30" }),
    overridePayload("o3", { template_id: "" }),
  ]) {
    const [result] = await push("checklist_schedule_override", "create", payload);
    assert.deepEqual(result, { id: payload.id, status: "error", error: "bad_input" });
  }

  await push("checklist_schedule_override", "create", overridePayload("ov-1", { time: "21:00", updated_at: LATER }));
  await push("checklist_schedule_override", "update", overridePayload("ov-1", { time: "03:00", updated_at: EARLIER }));
  assert.equal((await occurrences("2026-06-02", "2026-06-02")).body.items[0].time, "21:00");
});

test("sync: deleting an override restores the schedule time", async () => {
  await push("checklist_schedule", "create", schedulePayload("sched-1"));
  await push("checklist_schedule_override", "create", overridePayload("ov-1"));
  await push("checklist_schedule_override", "delete", { id: "ov-1", updated_at: LATER, deleted_at: LATER });

  const item = (await occurrences("2026-06-02", "2026-06-02")).body.items[0];
  assert.equal(item.time, "07:30");
  assert.equal(item.overridden, false);
});

test("sync: deleting a checklist soft-deletes its schedule and overrides, and the delta says so", async () => {
  await push("checklist_schedule", "create", schedulePayload("sched-1"));
  await push("checklist_schedule_override", "create", overridePayload("ov-1"));

  const [del] = await processPush(USER_ID, [{ op: "delete", type: "checklist_template", payload: { id: A, updated_at: LATER, deleted_at: LATER } } as never]);
  assert.equal(del.status, "applied");

  assert.equal((await liveRows("checklist_schedules")).length, 0);
  assert.equal((await liveRows("checklist_schedule_overrides")).length, 0);
  const delta = await getChangesSince(USER_ID, NOW);
  assert.ok((delta.checklist_schedules[0] as Json).deleted_at);
  assert.ok((delta.checklist_schedule_overrides[0] as Json).deleted_at);
});

test("sync: pushing a schedule and an override creates the reminder job through the same hook", async () => {
  const tomorrow = addDays(localDateOf(new Date(), "Asia/Ho_Chi_Minh"), 1);
  await push("checklist_schedule", "create", schedulePayload("sched-1", { start_date: tomorrow }));
  assert.equal((await jobsRepo.getOccurrenceJob(USER_ID, "checklist_due", A, tomorrow))?.status, "pending");

  await push("checklist_schedule_override", "create", overridePayload("ov-1", { local_date: tomorrow, time: "21:00" }));
  const job = await jobsRepo.getOccurrenceJob(USER_ID, "checklist_due", A, tomorrow);
  assert.equal(job?.status, "pending");
  assert.ok(job?.run_at.includes("T14:00:00"), "21:00 in Vietnam is 14:00 UTC");

  await push("checklist_schedule", "update", schedulePayload("sched-1", { start_date: tomorrow, enabled: false, updated_at: "2999-01-01T00:00:00.000Z" }));
  assert.equal((await jobsRepo.getOccurrenceJob(USER_ID, "checklist_due", A, tomorrow))?.status, "cancelled");
});

test("the stored schedule row is the one the repository reads back", async () => {
  await putSchedule(A, daily({ recurrence_type: "weekly", recurrence_days_of_week: "7,1" }));
  const row = await schedulesRepo.getLiveSchedule(USER_ID, A);
  assert.equal(row?.recurrence_days_of_week, "1,7");
  assert.equal(row?.enabled, 1);
});

// ── pause (paused_from .. paused_until) ──────────────────────────────────────

// Far future so the schedule is neither expired nor "today" for the reminder planner.
const FAR = "2099-06";
const day = (n: number): string => `${FAR}-${String(n).padStart(2, "0")}`;
const pausedDaily = (overrides: Json = {}): Json =>
  daily({
    start_date: day(1),
    recurrence_end_date: day(10),
    paused_from: day(4),
    paused_until: day(7),
    ...overrides,
  });

test("pause: PUT stores the window, echoes it, and the timeline skips exactly those days", async () => {
  const put = await putSchedule(A, pausedDaily());

  assert.equal(put.status, 200);
  assert.equal(put.body.schedule.paused_from, day(4));
  assert.equal(put.body.schedule.paused_until, day(7));
  assert.equal((await getSchedule(A)).body.schedule.paused_until, day(7));
  assert.equal((await call("GET", `/checklists/templates/${A}`)).body.schedule.paused_from, day(4));

  const items = (await occurrences(day(1), day(10))).body.items as Json[];
  assert.deepEqual(
    items.map((i) => i.date),
    [day(1), day(2), day(3), day(8), day(9), day(10)]
  );
});

test("pause: a schedule that was never paused reports a null window", async () => {
  const put = await putSchedule(A, daily());
  assert.equal(put.body.schedule.paused_from, null);
  assert.equal(put.body.schedule.paused_until, null);
});

test("pause: editing the schedule without mentioning pause keeps the window; null clears it", async () => {
  await putSchedule(A, pausedDaily());

  const edited = await putSchedule(A, daily({ start_date: day(1), recurrence_end_date: day(10), time: "09:00" }));
  assert.equal(edited.body.schedule.time, "09:00");
  assert.equal(edited.body.schedule.paused_from, day(4), "pause survives an unrelated edit");
  assert.equal(edited.body.schedule.paused_until, day(7));

  const cleared = await putSchedule(A, pausedDaily({ paused_from: null, paused_until: null }));
  assert.equal(cleared.body.schedule.paused_from, null);
  assert.equal(cleared.body.schedule.paused_until, null);
  assert.equal(((await occurrences(day(4), day(7))).body.items as Json[]).length, 4, "days are back right away");
});

test("pause: the window can be shortened (resume early)", async () => {
  await putSchedule(A, pausedDaily());
  await putSchedule(A, pausedDaily({ paused_until: day(5) })); // shows again on the 6th

  const items = (await occurrences(day(1), day(10))).body.items as Json[];
  assert.deepEqual(
    items.map((i) => i.date),
    [day(1), day(2), day(3), day(6), day(7), day(8), day(9), day(10)]
  );
});

test("pause: invalid windows are rejected with bad_input", async () => {
  const bad: Json[] = [
    pausedDaily({ paused_until: null }), // half a pair
    pausedDaily({ paused_from: null }),
    pausedDaily({ paused_from: day(8), paused_until: day(7) }), // reversed
    pausedDaily({ paused_from: "2099-02-30" }), // not a real date
    pausedDaily({ paused_until: "7/6" }), // wrong format
  ];
  for (const body of bad) {
    const res = await putSchedule(A, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error, "bad_input");
  }
  assert.equal((await liveRows("checklist_schedules")).length, 0);
});

test("pause: re-creating a deleted schedule starts from scratch, not paused", async () => {
  await putSchedule(A, pausedDaily());
  await deleteSchedule(A);

  const again = await putSchedule(A, daily({ start_date: day(1), recurrence_end_date: day(10) }));
  assert.equal(again.body.schedule.paused_from, null);
  assert.equal(again.body.schedule.paused_until, null);
  assert.equal(((await occurrences(day(1), day(10))).body.items as Json[]).length, 10);
});

test("pause: a paused day cannot get a time override, an unpaused one can", async () => {
  await putSchedule(A, pausedDaily());

  const paused = await putOccurrence(A, day(5), { time: "09:00" });
  assert.equal(paused.status, 400);
  assert.equal(paused.body.error, "not_an_occurrence");

  assert.equal((await putOccurrence(A, day(8), { time: "09:00" })).status, 200);
});

test("pause: the reminder job of a paused day is cancelled and comes back when the pause is lifted", async () => {
  const today = localDateOf(new Date(), "Asia/Ho_Chi_Minh");
  const tomorrow = addDays(today, 1);
  await putSchedule(A, daily({ start_date: tomorrow }));
  assert.equal((await jobsRepo.getOccurrenceJob(USER_ID, "checklist_due", A, tomorrow))?.status, "pending");

  await putSchedule(A, daily({ start_date: tomorrow, paused_from: today, paused_until: tomorrow }));
  assert.equal((await jobsRepo.getOccurrenceJob(USER_ID, "checklist_due", A, tomorrow))?.status, "cancelled");

  await putSchedule(A, daily({ start_date: tomorrow, paused_from: null, paused_until: null }));
  assert.equal((await jobsRepo.getOccurrenceJob(USER_ID, "checklist_due", A, tomorrow))?.status, "pending");
});

test("pause: a window that ends before tomorrow leaves tomorrow's reminder alone", async () => {
  const today = localDateOf(new Date(), "Asia/Ho_Chi_Minh");
  const tomorrow = addDays(today, 1);
  await putSchedule(A, daily({ start_date: today, paused_from: today, paused_until: today }));
  assert.equal((await jobsRepo.getOccurrenceJob(USER_ID, "checklist_due", A, tomorrow))?.status, "pending");
  assert.equal(await jobsRepo.getOccurrenceJob(USER_ID, "checklist_due", A, today), null);
});

test("pause sync: a pushed window is stored, pulled with the schedule, and applied to the timeline", async () => {
  const [result] = await push("checklist_schedule", "create", schedulePayload("sched-p", {
    start_date: day(1),
    recurrence_end_date: day(10),
    paused_from: day(4),
    paused_until: day(7),
  }));
  assert.deepEqual(result, { id: "sched-p", status: "applied" });

  const row = (await getChangesSince(USER_ID, null)).checklist_schedules[0] as Json;
  assert.equal(row.paused_from, day(4));
  assert.equal(row.paused_until, day(7));
  const items = (await occurrences(day(1), day(10))).body.items as Json[];
  assert.deepEqual(items.map((i) => i.date), [day(1), day(2), day(3), day(8), day(9), day(10)]);
});

test("pause sync: an older app that omits the fields does not lift the pause; explicit nulls do", async () => {
  await push("checklist_schedule", "create", schedulePayload("sched-p", { start_date: day(1), paused_from: day(4), paused_until: day(7) }));

  await push("checklist_schedule", "update", schedulePayload("sched-p", { start_date: day(1), time: "08:00", updated_at: LATER }));
  let row = (await getChangesSince(USER_ID, null)).checklist_schedules[0] as Json;
  assert.equal(row.time, "08:00");
  assert.equal(row.paused_from, day(4), "omitted -> unchanged");
  assert.equal(row.paused_until, day(7));

  await push("checklist_schedule", "update", schedulePayload("sched-p", {
    start_date: day(1), paused_from: null, paused_until: null, updated_at: "2026-06-03T00:00:00.000Z",
  }));
  row = (await getChangesSince(USER_ID, null)).checklist_schedules[0] as Json;
  assert.equal(row.paused_from, null);
  assert.equal(row.paused_until, null);
});

test("pause sync: a half-set or reversed window is bad_input and nothing is written", async () => {
  const bad: Json[] = [
    schedulePayload("p1", { paused_from: day(4) }),
    schedulePayload("p2", { paused_until: day(7) }),
    schedulePayload("p3", { paused_from: day(8), paused_until: day(7) }),
    schedulePayload("p4", { paused_from: "nope", paused_until: day(7) }),
  ];
  for (const payload of bad) {
    const [result] = await push("checklist_schedule", "create", payload);
    assert.deepEqual(result, { id: payload.id, status: "error", error: "bad_input" }, String(payload.id));
  }
  assert.equal((await liveRows("checklist_schedules")).length, 0);
});

test("pause sync: an older pause push loses to a newer one (Last-Write-Wins)", async () => {
  await push("checklist_schedule", "create", schedulePayload("sched-p", {
    start_date: day(1), paused_from: day(4), paused_until: day(7), updated_at: LATER,
  }));
  await push("checklist_schedule", "update", schedulePayload("sched-p", {
    start_date: day(1), paused_from: null, paused_until: null, updated_at: EARLIER,
  }));
  assert.equal((await getSchedule(A)).body.schedule.paused_from, day(4));
});

test("pause sync: reviving a deleted schedule without pause fields starts unpaused", async () => {
  await push("checklist_schedule", "create", schedulePayload("sched-p", { start_date: day(1), paused_from: day(4), paused_until: day(7) }));
  await push("checklist_schedule", "delete", { id: "sched-p", updated_at: LATER, deleted_at: LATER });

  await push("checklist_schedule", "create", schedulePayload("sched-p", { start_date: day(1), updated_at: "2026-06-03T00:00:00.000Z" }));
  const schedule = (await getSchedule(A)).body.schedule;
  assert.equal(schedule.paused_from, null);
  assert.equal(schedule.paused_until, null);
});

test("pause sync: a pushed pause cancels the reminder job through the same hook", async () => {
  const today = localDateOf(new Date(), "Asia/Ho_Chi_Minh");
  const tomorrow = addDays(today, 1);
  await push("checklist_schedule", "create", schedulePayload("sched-p", { start_date: tomorrow }));
  assert.equal((await jobsRepo.getOccurrenceJob(USER_ID, "checklist_due", A, tomorrow))?.status, "pending");

  await push("checklist_schedule", "update", schedulePayload("sched-p", {
    start_date: tomorrow, paused_from: today, paused_until: tomorrow, updated_at: "2999-01-01T00:00:00.000Z",
  }));
  assert.equal((await jobsRepo.getOccurrenceJob(USER_ID, "checklist_due", A, tomorrow))?.status, "cancelled");
});

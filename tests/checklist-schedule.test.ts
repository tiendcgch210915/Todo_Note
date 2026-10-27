import assert from "node:assert/strict";
import { test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";

const {
  baseOccurrenceDates,
  isOccurrenceDate,
  isValidCalendarDate,
  occurrencesBetween,
  rangeDays,
  toScheduleRule,
  MAX_OCCURRENCE_RANGE_DAYS,
} = await import("../src/services/checklist-schedule.js");
const { completedLocalDates, creatableSlots, dueSlotsFor } = await import(
  "../src/services/checklist-due.js"
);
const { isoWeekdayOf, nextRecurrenceDateAfter, parseWeekdays } = await import(
  "../src/utils/recurrence.js"
);
const { addDays } = await import("../src/utils/time.js");
const { LATENESS_MS } = await import("../src/config/notification-policy.js");
type ScheduleRule = import("../src/services/checklist-schedule.js").ScheduleRule;

const rule = (overrides: Partial<ScheduleRule> = {}): ScheduleRule => ({
  templateId: "tpl-1",
  startDate: "2026-06-22", // a Monday
  time: "07:30",
  recurrenceType: null,
  recurrenceInterval: null,
  recurrenceDaysOfWeek: null,
  recurrenceEndDate: null,
  enabled: true,
  pausedFrom: null,
  pausedUntil: null,
  ...overrides,
});

const dates =(r: ScheduleRule, from: string, to: string): string[] =>
  baseOccurrenceDates(r, from, to);

test("sanity: 2026-06-22 is a Monday and the helpers agree", () => {
  assert.equal(isoWeekdayOf("2026-06-22"), 1);
  assert.equal(isoWeekdayOf("2026-06-28"), 7);
  assert.deepEqual(parseWeekdays("5,1,3,3"), [1, 3, 5]);
});

// ── no repeat ────────────────────────────────────────────────────────────────

test("no repeat: exactly one occurrence, on the start date", () => {
  assert.deepEqual(dates(rule(), "2026-06-01", "2026-07-31"), ["2026-06-22"]);
  assert.deepEqual(dates(rule(), "2026-06-22", "2026-06-22"), ["2026-06-22"]);
  assert.deepEqual(dates(rule(), "2026-06-23", "2026-07-31"), []);
  assert.deepEqual(dates(rule(), "2026-06-01", "2026-06-21"), []);
});

test("a disabled schedule has no occurrences; a bad range or bad date has none either", () => {
  assert.deepEqual(dates(rule({ enabled: false, recurrenceType: "daily" }), "2026-06-22", "2026-06-30"), []);
  assert.deepEqual(dates(rule({ recurrenceType: "daily" }), "2026-06-30", "2026-06-22"), []);
  assert.deepEqual(dates(rule({ recurrenceType: "daily" }), "nope", "2026-06-30"), []);
  assert.deepEqual(dates(rule({ startDate: "garbage", recurrenceType: "daily" }), "2026-06-01", "2026-06-30"), []);
});

// ── daily / custom ───────────────────────────────────────────────────────────

test("daily: every day from the start date", () => {
  const r = rule({ recurrenceType: "daily", recurrenceInterval: 1 });
  assert.deepEqual(dates(r, "2026-06-20", "2026-06-25"), ["2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25"]);
});

test("daily with interval 3 and custom behave the same: every N days from the start", () => {
  for (const type of ["daily", "custom"] as const) {
    const r = rule({ recurrenceType: type, recurrenceInterval: 3 });
    assert.deepEqual(dates(r, "2026-06-01", "2026-07-05"), [
      "2026-06-22", "2026-06-25", "2026-06-28", "2026-07-01", "2026-07-04",
    ]);
  }
});

test("a missing interval means 1", () => {
  const r = rule({ recurrenceType: "daily", recurrenceInterval: null });
  assert.equal(dates(r, "2026-06-22", "2026-06-24").length, 3);
});

// ── weekly ───────────────────────────────────────────────────────────────────

test("weekly on Monday, Wednesday and Friday", () => {
  const r = rule({ recurrenceType: "weekly", recurrenceInterval: 1, recurrenceDaysOfWeek: "1,3,5" });
  assert.deepEqual(dates(r, "2026-06-22", "2026-07-03"), [
    "2026-06-22", "2026-06-24", "2026-06-26",
    "2026-06-29", "2026-07-01", "2026-07-03",
  ]);
});

test("weekly with all seven weekdays equals daily", () => {
  const weekly = rule({ recurrenceType: "weekly", recurrenceInterval: 1, recurrenceDaysOfWeek: "1,2,3,4,5,6,7" });
  const daily = rule({ recurrenceType: "daily", recurrenceInterval: 1 });
  assert.deepEqual(dates(weekly, "2026-06-22", "2026-08-01"), dates(daily, "2026-06-22", "2026-08-01"));
});

test("weekly without weekdays repeats on the start date's weekday", () => {
  const r = rule({ recurrenceType: "weekly", recurrenceInterval: 1, recurrenceDaysOfWeek: null });
  assert.deepEqual(dates(r, "2026-06-01", "2026-07-20"), [
    "2026-06-22", "2026-06-29", "2026-07-06", "2026-07-13", "2026-07-20",
  ]);
});

test("weekly every 2 weeks on Tuesday and Thursday keeps the two-week blocks", () => {
  const r = rule({
    startDate: "2026-06-23", // Tuesday
    recurrenceType: "weekly",
    recurrenceInterval: 2,
    recurrenceDaysOfWeek: "2,4",
  });
  assert.deepEqual(dates(r, "2026-06-01", "2026-07-31"), [
    "2026-06-23", "2026-06-25", // week of 22 Jun
    "2026-07-07", "2026-07-09", // two weeks later
    "2026-07-21", "2026-07-23",
  ]);
});

test("like the first todo of a series, the start date is always an occurrence even off the chosen weekdays", () => {
  const r = rule({
    startDate: "2026-06-24", // Wednesday, but only Mon/Fri are chosen
    recurrenceType: "weekly",
    recurrenceInterval: 1,
    recurrenceDaysOfWeek: "1,5",
  });
  assert.deepEqual(dates(r, "2026-06-22", "2026-07-03"), [
    "2026-06-24", "2026-06-26", "2026-06-29", "2026-07-03",
  ]);
});

// ── end date ─────────────────────────────────────────────────────────────────

test("the until date is inclusive and nothing appears after it", () => {
  const r = rule({ recurrenceType: "daily", recurrenceInterval: 1, recurrenceEndDate: "2026-06-24" });
  assert.deepEqual(dates(r, "2026-06-22", "2026-07-30"), ["2026-06-22", "2026-06-23", "2026-06-24"]);
  assert.deepEqual(dates(r, "2026-06-25", "2026-07-30"), []);
});

test("an until date that skips the next step ends the series", () => {
  const r = rule({ recurrenceType: "custom", recurrenceInterval: 5, recurrenceEndDate: "2026-07-01" });
  assert.deepEqual(dates(r, "2026-06-01", "2026-12-31"), ["2026-06-22", "2026-06-27"]);
});

test("a start date after the until date yields nothing", () => {
  const r = rule({ recurrenceType: "daily", recurrenceInterval: 1, recurrenceEndDate: "2026-06-20" });
  assert.deepEqual(dates(r, "2026-06-01", "2026-12-31"), []);
  assert.deepEqual(dates(rule({ recurrenceEndDate: "2026-06-20" }), "2026-06-01", "2026-12-31"), []);
});

// ── month / year boundaries ──────────────────────────────────────────────────

test("daily crosses month, year and leap-day boundaries correctly", () => {
  const r = rule({ startDate: "2027-12-29", recurrenceType: "daily", recurrenceInterval: 1 });
  assert.deepEqual(dates(r, "2027-12-30", "2028-01-02"), ["2027-12-30", "2027-12-31", "2028-01-01", "2028-01-02"]);

  const leap = rule({ startDate: "2028-02-27", recurrenceType: "daily", recurrenceInterval: 1 });
  assert.deepEqual(dates(leap, "2028-02-27", "2028-03-01"), ["2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01"]);

  const plain = rule({ startDate: "2027-02-27", recurrenceType: "daily", recurrenceInterval: 1 });
  assert.deepEqual(dates(plain, "2027-02-27", "2027-03-01"), ["2027-02-27", "2027-02-28", "2027-03-01"]);
});

test("weekly across a year boundary", () => {
  const r = rule({
    startDate: "2026-12-28", // Monday
    recurrenceType: "weekly",
    recurrenceInterval: 1,
    recurrenceDaysOfWeek: "1,4",
  });
  assert.deepEqual(dates(r, "2026-12-28", "2027-01-07"), [
    "2026-12-28", "2026-12-31", "2027-01-04", "2027-01-07",
  ]);
});

// ── overrides ────────────────────────────────────────────────────────────────

test("an override changes the time of that one day and marks it overridden", () => {
  const r = rule({ recurrenceType: "daily", recurrenceInterval: 1 });
  const result = occurrencesBetween(r, [{ localDate: "2026-06-23", time: "09:45" }], "2026-06-22", "2026-06-24");
  assert.deepEqual(result, [
    { checklistId: "tpl-1", date: "2026-06-22", time: "07:30", overridden: false },
    { checklistId: "tpl-1", date: "2026-06-23", time: "09:45", overridden: true },
    { checklistId: "tpl-1", date: "2026-06-24", time: "07:30", overridden: false },
  ]);
});

test("an override on a day that is not an occurrence is ignored (and never invents one)", () => {
  const r = rule({ recurrenceType: "weekly", recurrenceInterval: 1, recurrenceDaysOfWeek: "1" });
  const result = occurrencesBetween(r, [{ localDate: "2026-06-23", time: "09:00" }], "2026-06-22", "2026-06-29");
  assert.deepEqual(result.map((o) => o.date), ["2026-06-22", "2026-06-29"]);
  assert.ok(result.every((o) => !o.overridden));
});

test("a disabled schedule ignores its overrides too", () => {
  const r = rule({ recurrenceType: "daily", enabled: false });
  assert.deepEqual(occurrencesBetween(r, [{ localDate: "2026-06-23", time: "09:00" }], "2026-06-22", "2026-06-30"), []);
});

test("isOccurrenceDate checks the rule only, not the overrides", () => {
  const r = rule({ recurrenceType: "weekly", recurrenceInterval: 1, recurrenceDaysOfWeek: "1,3" });
  assert.equal(isOccurrenceDate(r, "2026-06-24"), true);
  assert.equal(isOccurrenceDate(r, "2026-06-23"), false);
  assert.equal(isOccurrenceDate(r, "2026-06-15"), false, "before the start");
});

// ── the fast-forward must never change the answer ───────────────────────────

/** Reference: walk the todo-style chain from the start date, no shortcuts. */
const bruteForce = (r: ScheduleRule, from: string, to: string): string[] => {
  if (!r.enabled || r.startDate > to) return [];
  if (r.recurrenceEndDate && r.startDate > r.recurrenceEndDate) return [];
  const out: string[] = [];
  const keep = (d: string) => {
    if (d >= from && d <= to && (!r.recurrenceEndDate || d <= r.recurrenceEndDate)) out.push(d);
  };
  keep(r.startDate);
  if (!r.recurrenceType) return out;
  let cursor = r.startDate;
  for (let i = 0; i < 100_000; i++) {
    const next = nextRecurrenceDateAfter(
      {
        type: r.recurrenceType,
        interval: r.recurrenceInterval,
        daysOfWeek: r.recurrenceDaysOfWeek,
        endDate: r.recurrenceEndDate,
      },
      cursor
    );
    if (!next || next > to) break;
    keep(next);
    cursor = next;
  }
  return out;
};

test("fast-forward equals the brute-force chain on hundreds of random schedules", () => {
  let seed = 12345;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const types = ["daily", "weekly", "custom", null] as const;
  const dayLists = [null, "1", "7", "1,3,5", "2,4", "6,7", "1,2,3,4,5,6,7", "3,3,1"];

  let checked = 0;
  for (let i = 0; i < 600; i++) {
    const startDate = addDays("2024-01-01", rnd(1100));
    const type = types[rnd(types.length)];
    const interval = 1 + rnd(6);
    const days = dayLists[rnd(dayLists.length)];
    const endDate = rnd(3) === 0 ? addDays(startDate, rnd(500)) : null;
    const r = rule({
      startDate,
      recurrenceType: type,
      recurrenceInterval: interval,
      recurrenceDaysOfWeek: type === "weekly" ? days : null,
      recurrenceEndDate: endDate,
    });
    const from = addDays(startDate, rnd(900) - 60);
    const to = addDays(from, rnd(MAX_OCCURRENCE_RANGE_DAYS));
    assert.deepEqual(
      baseOccurrenceDates(r, from, to),
      bruteForce(r, from, to),
      JSON.stringify({ r, from, to })
    );
    checked++;
  }
  assert.equal(checked, 600);
});

test("a schedule that started years ago still expands a two-day window quickly", () => {
  const r = rule({
    startDate: "2005-03-01",
    recurrenceType: "weekly",
    recurrenceInterval: 2,
    recurrenceDaysOfWeek: "1,3,5",
  });
  const started = performance.now();
  for (let i = 0; i < 200; i++) baseOccurrenceDates(r, "2026-10-10", "2026-10-11");
  assert.ok(performance.now() - started < 500, "200 expansions should take far less than half a second");
});

// ── helpers ──────────────────────────────────────────────────────────────────

test("calendar validation and range size", () => {
  assert.equal(isValidCalendarDate("2026-02-28"), true);
  assert.equal(isValidCalendarDate("2028-02-29"), true);
  assert.equal(isValidCalendarDate("2026-02-29"), false);
  assert.equal(isValidCalendarDate("2026-13-01"), false);
  assert.equal(isValidCalendarDate("26-01-01"), false);
  assert.equal(rangeDays("2026-06-01", "2026-06-01"), 1);
  assert.equal(rangeDays("2026-06-01", "2026-07-31"), 61);
  assert.equal(rangeDays("2026-06-01", "2026-08-01"), MAX_OCCURRENCE_RANGE_DAYS);
  assert.equal(MAX_OCCURRENCE_RANGE_DAYS, 62);
});

test("toScheduleRule maps a database row", () => {
  assert.deepEqual(
    toScheduleRule({
      template_id: "t",
      start_date: "2026-06-22",
      time: "07:30",
      recurrence_type: "weekly",
      recurrence_interval: 2,
      recurrence_days_of_week: "1,3",
      recurrence_end_date: null,
      enabled: 1,
    }),
    {
      templateId: "t",
      startDate: "2026-06-22",
      time: "07:30",
      recurrenceType: "weekly",
      recurrenceInterval: 2,
      recurrenceDaysOfWeek: "1,3",
      recurrenceEndDate: null,
      enabled: true,
      pausedFrom: null,
      pausedUntil: null,
    }
  );
});

// ── time zones: slots, done days and lateness ────────────────────────────────

test("slots are converted to UTC in the user's zone, including midnight crossings", () => {
  const r = rule({ startDate: "2026-06-22", time: "00:30", recurrenceType: "daily", recurrenceInterval: 1 });

  const vn = dueSlotsFor(r, [], new Set(), "Asia/Ho_Chi_Minh", "2026-06-22", "2026-06-23");
  assert.deepEqual(vn.map((s) => s.runAt.toISOString()), [
    "2026-06-21T17:30:00.000Z", // 00:30 in Vietnam is the PREVIOUS UTC day
    "2026-06-22T17:30:00.000Z",
  ]);

  const ny = dueSlotsFor(r, [], new Set(), "America/New_York", "2026-06-22", "2026-06-22");
  assert.equal(ny[0].runAt.toISOString(), "2026-06-22T04:30:00.000Z"); // EDT = UTC-4

  const auckland = dueSlotsFor(r, [], new Set(), "Pacific/Auckland", "2026-06-22", "2026-06-22");
  assert.equal(auckland[0].runAt.toISOString(), "2026-06-21T12:30:00.000Z"); // NZST = UTC+12
});

test("the same schedule shifts by an hour across a DST change but keeps its local time", () => {
  const r = rule({ startDate: "2026-03-07", time: "07:00", recurrenceType: "daily", recurrenceInterval: 1 });
  const slots = dueSlotsFor(r, [], new Set(), "America/New_York", "2026-03-07", "2026-03-09");
  assert.deepEqual(slots.map((s) => s.runAt.toISOString()), [
    "2026-03-07T12:00:00.000Z", // EST
    "2026-03-08T11:00:00.000Z", // DST starts that day: EDT
    "2026-03-09T11:00:00.000Z",
  ]);
});

test("overrides change the UTC instant of that day only", () => {
  const r = rule({ time: "07:00", recurrenceType: "daily", recurrenceInterval: 1 });
  const slots = dueSlotsFor(
    r,
    [{ localDate: "2026-06-23", time: "21:15" }],
    new Set(),
    "Asia/Ho_Chi_Minh",
    "2026-06-22",
    "2026-06-23"
  );
  assert.deepEqual(slots.map((s) => [s.date, s.time, s.runAt.toISOString()]), [
    ["2026-06-22", "07:00", "2026-06-22T00:00:00.000Z"],
    ["2026-06-23", "21:15", "2026-06-23T14:15:00.000Z"],
  ]);
});

test("a day that already has a completed run is dropped from the slots", () => {
  const r = rule({ recurrenceType: "daily", recurrenceInterval: 1 });
  const done = new Set(["2026-06-23"]);
  const slots = dueSlotsFor(r, [], done, "Asia/Ho_Chi_Minh", "2026-06-22", "2026-06-24");
  assert.deepEqual(slots.map((s) => s.date), ["2026-06-22", "2026-06-24"]);
});

test("a completion belongs to the user's LOCAL day, not the UTC day", () => {
  // 2026-06-20T17:30Z is already 21 June in Vietnam but still 20 June in New York.
  assert.deepEqual([...completedLocalDates(["2026-06-20T17:30:00.000Z"], "Asia/Ho_Chi_Minh")], ["2026-06-21"]);
  assert.deepEqual([...completedLocalDates(["2026-06-20T17:30:00.000Z"], "America/New_York")], ["2026-06-20"]);
  assert.deepEqual([...completedLocalDates(["not a date"], "Asia/Ho_Chi_Minh")], []);
});

test("slots already beyond the 30 minute lateness window are not created", () => {
  const r = rule({ time: "07:00", recurrenceType: "daily", recurrenceInterval: 1 });
  const slots = dueSlotsFor(r, [], new Set(), "Asia/Ho_Chi_Minh", "2026-06-22", "2026-06-23");
  const runAt = slots[0].runAt.getTime(); // 2026-06-22T00:00Z
  assert.equal(LATENESS_MS.checklist_due, 30 * 60_000);
  assert.equal(creatableSlots(slots, new Date(runAt - 60_000)).length, 2, "not yet due");
  assert.equal(creatableSlots(slots, new Date(runAt + 30 * 60_000)).length, 2, "exactly at the limit");
  assert.equal(creatableSlots(slots, new Date(runAt + 30 * 60_000 + 1)).length, 1, "just past it");
});

// ── pause (paused_from .. paused_until) ──────────────────────────────────────

const daily = (overrides: Partial<ScheduleRule> = {}): ScheduleRule =>
  rule({ startDate: "2026-06-01", recurrenceType: "daily", recurrenceInterval: 1, ...overrides });

test("pause: daily 1st..10th paused 4th..7th keeps 1-3, drops 4-7, shows again on the 8th", () => {
  const paused = daily({
    recurrenceEndDate: "2026-06-10",
    pausedFrom: "2026-06-04",
    pausedUntil: "2026-06-07",
  });
  assert.deepEqual(dates(paused, "2026-06-01", "2026-06-30"), [
    "2026-06-01",
    "2026-06-02",
    "2026-06-03",
    "2026-06-08",
    "2026-06-09",
    "2026-06-10",
  ]);
});

test("pause: both ends are inclusive and a one-day pause drops exactly that day", () => {
  const range = daily({ pausedFrom: "2026-06-04", pausedUntil: "2026-06-07" });
  assert.deepEqual(dates(range, "2026-06-03", "2026-06-08"), ["2026-06-03", "2026-06-08"]);

  const oneDay = daily({ pausedFrom: "2026-06-05", pausedUntil: "2026-06-05" });
  assert.deepEqual(dates(oneDay, "2026-06-04", "2026-06-06"), ["2026-06-04", "2026-06-06"]);
});

test("pause: a window that does not intersect the queried range changes nothing", () => {
  const paused = daily({ pausedFrom: "2026-07-01", pausedUntil: "2026-07-05" });
  assert.deepEqual(dates(paused, "2026-06-01", "2026-06-03"), ["2026-06-01", "2026-06-02", "2026-06-03"]);
  // Querying inside the window directly (the timeline for a single paused day) is empty.
  assert.deepEqual(dates(paused, "2026-07-03", "2026-07-03"), []);
});

test("pause: weekly weekdays skip only the occurrences inside the window", () => {
  const weekly = rule({
    startDate: "2026-06-01", // Monday
    recurrenceType: "weekly",
    recurrenceInterval: 1,
    recurrenceDaysOfWeek: "1,3",
    pausedFrom: "2026-06-08",
    pausedUntil: "2026-06-10",
  });
  // Mon 1, Wed 3, [Mon 8, Wed 10 paused], Mon 15, Wed 17
  assert.deepEqual(dates(weekly, "2026-06-01", "2026-06-17"), [
    "2026-06-01",
    "2026-06-03",
    "2026-06-15",
    "2026-06-17",
  ]);
});

test("pause: a half-set or malformed window is ignored instead of hiding the schedule", () => {
  const all = ["2026-06-01", "2026-06-02", "2026-06-03"];
  assert.deepEqual(dates(daily({ pausedFrom: "2026-06-01", pausedUntil: null }), "2026-06-01", "2026-06-03"), all);
  assert.deepEqual(dates(daily({ pausedFrom: null, pausedUntil: "2026-06-03" }), "2026-06-01", "2026-06-03"), all);
  assert.deepEqual(dates(daily({ pausedFrom: "x", pausedUntil: "y" }), "2026-06-01", "2026-06-03"), all);
});

test("pause: a paused day is not an occurrence, carries no override and is not overridable", () => {
  const paused = daily({ pausedFrom: "2026-06-04", pausedUntil: "2026-06-07" });
  assert.equal(isOccurrenceDate(paused, "2026-06-03"), true);
  assert.equal(isOccurrenceDate(paused, "2026-06-04"), false);
  assert.equal(isOccurrenceDate(paused, "2026-06-08"), true);

  const occurrences = occurrencesBetween(
    paused,
    [
      { localDate: "2026-06-05", time: "09:00" }, // orphan override of a paused day
      { localDate: "2026-06-08", time: "10:00" },
    ],
    "2026-06-04",
    "2026-06-09"
  );
  assert.deepEqual(
    occurrences.map((o) => [o.date, o.time, o.overridden]),
    [
      ["2026-06-08", "10:00", true],
      ["2026-06-09", "07:30", false],
    ]
  );
});

test("pause: a one-off schedule paused on its day has no occurrence at all", () => {
  const once = rule({ startDate: "2026-06-22", pausedFrom: "2026-06-20", pausedUntil: "2026-06-25" });
  assert.deepEqual(dates(once, "2026-06-01", "2026-07-31"), []);
});

test("pause: the due-slot planner input (dueSlotsFor) skips paused days and resumes after", () => {
  const paused = daily({ pausedFrom: "2026-06-04", pausedUntil: "2026-06-07" });
  const slots = dueSlotsFor(paused, [], new Set(), "Asia/Ho_Chi_Minh", "2026-06-03", "2026-06-08");
  assert.deepEqual(slots.map((s) => s.date), ["2026-06-03", "2026-06-08"]);
});

test("pause: toScheduleRule maps paused_from/paused_until and defaults to not paused", () => {
  const base = {
    template_id: "tpl-1",
    start_date: "2026-06-01",
    time: "07:30",
    recurrence_type: "daily" as const,
    recurrence_interval: 1,
    recurrence_days_of_week: null,
    recurrence_end_date: null,
    enabled: 1,
  };
  const withPause = toScheduleRule({ ...base, paused_from: "2026-06-04", paused_until: "2026-06-07" });
  assert.equal(withPause.pausedFrom, "2026-06-04");
  assert.equal(withPause.pausedUntil, "2026-06-07");
  const without = toScheduleRule(base);
  assert.equal(without.pausedFrom, null);
  assert.equal(without.pausedUntil, null);
});

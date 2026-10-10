import assert from "node:assert/strict";
import { test } from "node:test";

import {
  habitSummaryTime,
  isEveningTimeAllowed,
  isValidTimeZone,
  localDateOf,
  localDateTimeToUtc,
} from "../src/utils/time.js";
import {
  digestRunAt,
  resolveSettings,
} from "../src/services/notification-schedule.js";
import { UpdateNotificationSettingsSchema } from "../src/schemas/api/notification-settings.js";

const utc = (date: string, hhmm: string, timeZone: string): string =>
  localDateTimeToUtc(date, hhmm, timeZone).toISOString();

test("local time converts to UTC for a fixed-offset zone (Vietnam, UTC+7)", () => {
  assert.equal(utc("2026-10-10", "07:00", "Asia/Ho_Chi_Minh"), "2026-10-10T00:00:00.000Z");
  assert.equal(utc("2026-10-10", "17:30", "Asia/Ho_Chi_Minh"), "2026-10-10T10:30:00.000Z");
});

test("a local time before 07:00 lands on the PREVIOUS UTC day (midnight crossing)", () => {
  assert.equal(utc("2026-10-10", "05:00", "Asia/Ho_Chi_Minh"), "2026-10-09T22:00:00.000Z");
  assert.equal(utc("2026-10-10", "00:00", "Asia/Ho_Chi_Minh"), "2026-10-09T17:00:00.000Z");
  // and a western zone crosses the other way
  assert.equal(utc("2026-10-10", "23:30", "America/Los_Angeles"), "2026-10-11T06:30:00.000Z");
});

test("zones ahead of UTC by more than 12h and DST zones are handled", () => {
  // NZST (+12) in June, NZDT (+13) in October
  assert.equal(utc("2026-06-20", "07:00", "Pacific/Auckland"), "2026-06-19T19:00:00.000Z");
  assert.equal(utc("2026-10-10", "07:00", "Pacific/Auckland"), "2026-10-09T18:00:00.000Z");
  // New York: EDT (-4) in July, EST (-5) in January
  assert.equal(utc("2026-07-04", "07:00", "America/New_York"), "2026-07-04T11:00:00.000Z");
  assert.equal(utc("2026-01-04", "07:00", "America/New_York"), "2026-01-04T12:00:00.000Z");
});

test("a local time on the day DST ends/starts still maps to a single instant", () => {
  // 2026-11-01 01:30 happens twice in New York; the first (EDT) occurrence is used.
  assert.equal(utc("2026-11-01", "01:30", "America/New_York"), "2026-11-01T05:30:00.000Z");
  // 2026-03-08 02:30 does not exist; the result must be a real, nearby instant.
  const skipped = localDateTimeToUtc("2026-03-08", "02:30", "America/New_York").getTime();
  const expected = Date.parse("2026-03-08T07:30:00.000Z");
  assert.ok(Math.abs(skipped - expected) <= 60 * 60 * 1000);
});

test("localDateOf gives the user's calendar date, not the UTC date", () => {
  const instant = new Date("2026-10-09T18:30:00.000Z");
  assert.equal(localDateOf(instant, "Asia/Ho_Chi_Minh"), "2026-10-10");
  assert.equal(localDateOf(instant, "America/Los_Angeles"), "2026-10-09");
});

test("habit summary time is evening_time + 30 minutes, capped at 23:59", () => {
  assert.equal(habitSummaryTime("17:00"), "17:30");
  assert.equal(habitSummaryTime("17:45"), "18:15");
  assert.equal(habitSummaryTime("23:29"), "23:59");
  assert.equal(habitSummaryTime("23:45"), "23:59"); // defensive cap, never stored
});

test("evening_time is rejected when +30 minutes would pass 23:59", () => {
  assert.equal(isEveningTimeAllowed("23:29"), true);
  assert.equal(isEveningTimeAllowed("23:30"), false);
  assert.equal(isEveningTimeAllowed("23:59"), false);
  assert.equal(isEveningTimeAllowed("17:00"), true);
  assert.equal(isEveningTimeAllowed("25:00"), false);
});

test("time zone validation accepts IANA names and rejects junk", () => {
  assert.equal(isValidTimeZone("Asia/Ho_Chi_Minh"), true);
  assert.equal(isValidTimeZone("America/New_York"), true);
  assert.equal(isValidTimeZone("Mars/Base"), false);
  assert.equal(isValidTimeZone(""), false);
});

test("settings default to 07:00 / 17:00 / Asia/Ho_Chi_Minh and survive bad stored values", () => {
  const defaults = resolveSettings({ timezone: null, morning_time: null, evening_time: null });
  assert.deepEqual(defaults, {
    timezone: "Asia/Ho_Chi_Minh",
    morningTime: "07:00",
    eveningTime: "17:00",
    habitSummaryTime: "17:30",
  });
  const garbage = resolveSettings({ timezone: "Nope/Nope", morning_time: "7am", evening_time: "99:99" });
  assert.equal(garbage.timezone, "Asia/Ho_Chi_Minh");
  assert.equal(garbage.morningTime, "07:00");
  assert.equal(garbage.eveningTime, "17:00");
});

test("digest run_at follows the user's zone and the three digest times", () => {
  const vn = resolveSettings({ timezone: "Asia/Ho_Chi_Minh", morning_time: "06:30", evening_time: "21:00" });
  assert.equal(digestRunAt("digest_morning", "2026-06-20", vn).toISOString(), "2026-06-19T23:30:00.000Z");
  assert.equal(digestRunAt("digest_todos", "2026-06-20", vn).toISOString(), "2026-06-20T14:00:00.000Z");
  assert.equal(digestRunAt("digest_habits", "2026-06-20", vn).toISOString(), "2026-06-20T14:30:00.000Z");
});

test("the settings schema validates format, evening limit and time zone", () => {
  const ok = UpdateNotificationSettingsSchema.safeParse({
    morningTime: "07:00",
    eveningTime: "23:29",
    timezone: "Asia/Ho_Chi_Minh",
  });
  assert.equal(ok.success, true);

  for (const bad of [
    { morningTime: "7:00", eveningTime: "17:00", timezone: "Asia/Ho_Chi_Minh" },
    { morningTime: "07:00", eveningTime: "23:30", timezone: "Asia/Ho_Chi_Minh" },
    { morningTime: "07:00", eveningTime: "17:00", timezone: "Mars/Base" },
    { morningTime: "07:00", eveningTime: "17:00" },
  ]) {
    assert.equal(UpdateNotificationSettingsSchema.safeParse(bad).success, false);
  }
});

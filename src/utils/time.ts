import {
  HABIT_SUMMARY_OFFSET_MINUTES,
  LAST_MINUTE_OF_DAY,
} from "../config/notification-policy.js";

export const nowISO = (): string => new Date().toISOString();

export const todayDate = (): string => new Date().toISOString().slice(0, 10);

export const DEFAULT_TIME_ZONE = "Asia/Ho_Chi_Minh";

export type LocalNowParts = {
  date: string;
  hhmm: string;
  hour: number;
  minute: number;
  timezone: string;
};

const localPartsFormatter = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const formatLocalNowParts = (timeZone: string, now: Date): LocalNowParts => {
  const formatter = localPartsFormatter(timeZone);
  const parts = new Map(
    formatter
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const year = parts.get("year") ?? "1970";
  const month = parts.get("month") ?? "01";
  const day = parts.get("day") ?? "01";
  const hour = Number(parts.get("hour") ?? 0);
  const minute = Number(parts.get("minute") ?? 0);
  return {
    date: `${year}-${month}-${day}`,
    hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    hour,
    minute,
    timezone: timeZone,
  };
};

export const getLocalNowParts = (
  timeZone: string | null | undefined,
  now: Date = new Date()
): LocalNowParts => {
  try {
    return formatLocalNowParts(timeZone || DEFAULT_TIME_ZONE, now);
  } catch {
    return formatLocalNowParts(DEFAULT_TIME_ZONE, now);
  }
};

// Date math UTC. Input/output dạng "YYYY-MM-DD".
export const addDays = (d: string, n: number): string => {
  const dt = new Date(d + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};

export const dayDiff = (a: string, b: string): number => {
  const ta = new Date(a + "T00:00:00Z").getTime();
  const tb = new Date(b + "T00:00:00Z").getTime();
  return Math.round((tb - ta) / 86_400_000);
};

export const daysInRange = (from: string, to: string): string[] => {
  const out: string[] = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
};

export const isoWeekday = (date: string): number => {
  const day = new Date(date + "T00:00:00Z").getUTCDay();
  return day === 0 ? 7 : day;
};

export const startOfIsoWeek = (date: string): string =>
  addDays(date, 1 - isoWeekday(date));

// ── Giờ địa phương <-> UTC (dùng cho lịch thông báo) ────────────────────────

export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** IANA time zone mà Intl của Node hiểu được (ví dụ "Asia/Ho_Chi_Minh"). */
export const isValidTimeZone = (timeZone: string): boolean => {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
};

export const hhmmToMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export const minutesToHhmm = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

/** Độ lệch (ms) của `timeZone` so với UTC tại thời điểm `utcMs` (giờ địa phương - UTC). */
const zoneOffsetMs = (utcMs: number, timeZone: string): number => {
  const seconds = Math.floor(utcMs / 1000) * 1000;
  const parts = new Map(
    localPartsFormatter(timeZone)
      .formatToParts(new Date(seconds))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  const asUtc = Date.UTC(
    parts.get("year") ?? 1970,
    (parts.get("month") ?? 1) - 1,
    parts.get("day") ?? 1,
    parts.get("hour") ?? 0,
    parts.get("minute") ?? 0,
    0
  );
  return asUtc - Math.floor(seconds / 60_000) * 60_000;
};

/**
 * Đổi "ngày YYYY-MM-DD lúc HH:mm theo giờ địa phương của `timeZone`" sang thời
 * điểm UTC. Đúng cả khi giờ địa phương rơi sang ngày UTC khác và khi đổi giờ mùa
 * hè (DST); giờ không tồn tại trong khoảng chuyển DST được đẩy lùi/tiến theo
 * quy tắc của múi giờ đó.
 */
export const localDateTimeToUtc = (
  date: string,
  hhmm: string,
  timeZone: string
): Date => {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const first = wallAsUtc - zoneOffsetMs(wallAsUtc, timeZone);
  const second = wallAsUtc - zoneOffsetMs(first, timeZone);
  return new Date(second);
};

/** Ngày địa phương (YYYY-MM-DD) của một thời điểm UTC trong `timeZone`. */
export const localDateOf = (at: Date, timeZone: string): string =>
  getLocalNowParts(timeZone, at).date;

/** Giờ gửi tổng kết thói quen: evening_time + 30 phút, tối đa 23:59. */
export const habitSummaryTime = (eveningTime: string): string =>
  minutesToHhmm(
    Math.min(
      hhmmToMinutes(eveningTime) + HABIT_SUMMARY_OFFSET_MINUTES,
      LAST_MINUTE_OF_DAY
    )
  );

/** evening_time hợp lệ nếu cộng 30 phút vẫn chưa vượt 23:59 (tức <= 23:29). */
export const isEveningTimeAllowed = (eveningTime: string): boolean =>
  HHMM_RE.test(eveningTime) &&
  hhmmToMinutes(eveningTime) + HABIT_SUMMARY_OFFSET_MINUTES <= LAST_MINUTE_OF_DAY;

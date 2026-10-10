/**
 * Giờ gửi tổng kết của một người dùng. Hàm thuần, không đụng DB.
 * Múi giờ lấy từ `users.timezone`; giờ sáng/tối từ `notification_settings` (có mặc định).
 */
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type DigestKind,
} from "../config/notification-policy.js";
import {
  HHMM_RE,
  habitSummaryTime,
  isValidTimeZone,
  localDateTimeToUtc,
} from "../utils/time.js";

export type ResolvedSettings = {
  timezone: string;
  morningTime: string;
  eveningTime: string;
  /** evening_time + 30 phút (tối đa 23:59); luôn tính, không lưu. */
  habitSummaryTime: string;
};

export const resolveSettings = (input: {
  timezone: string | null | undefined;
  morning_time: string | null | undefined;
  evening_time: string | null | undefined;
}): ResolvedSettings => {
  const timezone =
    input.timezone && isValidTimeZone(input.timezone)
      ? input.timezone
      : DEFAULT_NOTIFICATION_SETTINGS.timezone;
  const morningTime =
    input.morning_time && HHMM_RE.test(input.morning_time)
      ? input.morning_time
      : DEFAULT_NOTIFICATION_SETTINGS.morningTime;
  const eveningTime =
    input.evening_time && HHMM_RE.test(input.evening_time)
      ? input.evening_time
      : DEFAULT_NOTIFICATION_SETTINGS.eveningTime;
  return {
    timezone,
    morningTime,
    eveningTime,
    habitSummaryTime: habitSummaryTime(eveningTime),
  };
};

/** Giờ địa phương mỗi loại tổng kết được gửi. */
export const digestLocalTime = (
  kind: DigestKind,
  settings: ResolvedSettings
): string => {
  switch (kind) {
    case "digest_morning":
      return settings.morningTime;
    case "digest_todos":
      return settings.eveningTime;
    case "digest_habits":
      return settings.habitSummaryTime;
  }
};

/** Thời điểm UTC gửi tổng kết `kind` cho ngày địa phương `localDate`. */
export const digestRunAt = (
  kind: DigestKind,
  localDate: string,
  settings: ResolvedSettings
): Date =>
  localDateTimeToUtc(localDate, digestLocalTime(kind, settings), settings.timezone);

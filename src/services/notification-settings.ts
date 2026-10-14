import * as settingsRepo from "../repositories/notification-settings.js";
import * as usersRepo from "../repositories/users.js";
import type { UpdateNotificationSettingsInput } from "../schemas/api/notification-settings.js";
import {
  planUser,
  recomputePendingDigests,
} from "./notification-planner.js";
import { resolveSettings } from "./notification-schedule.js";
import { onUserSettingsChanged } from "./notification-triggers.js";

export class NotificationSettingsError extends Error {
  constructor(public code: "not_found") {
    super(code);
  }
}

export type NotificationSettingsView = {
  morningTime: string;
  eveningTime: string;
  /** evening_time + 30 phút, tối đa 23:59; chỉ đọc. */
  habitSummaryTime: string;
  /** Giờ thông báo rà soát cuối ngày (mặc định 21:30). */
  reviewTime: string;
  timezone: string;
};

const toView = (
  ctx: settingsRepo.UserNotificationContext
): NotificationSettingsView => {
  const settings = resolveSettings(ctx);
  return {
    morningTime: settings.morningTime,
    eveningTime: settings.eveningTime,
    habitSummaryTime: settings.habitSummaryTime,
    reviewTime: settings.reviewTime,
    timezone: settings.timezone,
  };
};

const requireActiveContext = async (
  userId: string
): Promise<settingsRepo.UserNotificationContext> => {
  const ctx = await settingsRepo.getUserContext(userId);
  if (!ctx || !ctx.active) throw new NotificationSettingsError("not_found");
  return ctx;
};

export const getNotificationSettings = async (
  userId: string
): Promise<NotificationSettingsView> => toView(await requireActiveContext(userId));

/**
 * Lưu cài đặt. Múi giờ nằm ở `users.timezone` (đồng bộ xuống app qua sync như cũ); giờ sáng/tối/rà soát
 * ở notification_settings. Sau đó dời run_at của tổng kết chưa gửi và bổ sung job còn thiếu.
 */
export const updateNotificationSettings = async (
  userId: string,
  input: UpdateNotificationSettingsInput
): Promise<NotificationSettingsView> => {
  const ctx = await requireActiveContext(userId);

  await settingsRepo.upsertSettings(
    userId,
    input.morningTime,
    input.eveningTime,
    input.reviewTime
  );
  if (ctx.timezone !== input.timezone) {
    await usersRepo.updateUserProfile(userId, { timezone: input.timezone });
  }

  await recomputePendingDigests(userId);
  await planUser(userId);
  // Đổi múi giờ còn dời giờ của job lịch checklist và mốc nhắc lặp của todo.
  if (ctx.timezone !== input.timezone) await onUserSettingsChanged(userId);

  return toView(await requireActiveContext(userId));
};

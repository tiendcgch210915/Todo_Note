import * as notificationsRepo from "../repositories/notifications.js";
import {
  pushLogger,
  sendFirebasePush,
  type PushMessage,
  type PushResult,
} from "./firebase.js";

export class NotificationServiceError extends Error {
  constructor(public code: "not_found" | "bad_input") {
    super(code);
  }
}

export type NotificationSender = (message: PushMessage) => Promise<PushResult>;

let notificationSender: NotificationSender = sendFirebasePush;

export const setNotificationSenderForTests = (
  sender: NotificationSender | null
): void => {
  notificationSender = sender ?? sendFirebasePush;
};

export type RegisterDeviceInput = {
  registrationId: string;
  kind: notificationsRepo.DeviceKind;
  platform: notificationsRepo.DevicePlatform;
};

/** Create or refresh the caller's device registration (bumps last_seen_at). */
export const registerDevice = async (
  userId: string,
  input: RegisterDeviceInput
): Promise<notificationsRepo.UserDeviceRow> => {
  const registrationId = input.registrationId.trim();
  if (registrationId.length === 0) {
    throw new NotificationServiceError("bad_input");
  }
  const exists = await notificationsRepo.activeUserExists(userId);
  if (!exists) throw new NotificationServiceError("not_found");
  return notificationsRepo.upsertUserDevice(userId, {
    ...input,
    registrationId,
  });
};

/** Remove one of the caller's own registrations (logout). Idempotent. */
export const unregisterDevice = async (
  userId: string,
  registrationId: string
): Promise<number> => {
  const trimmed = registrationId.trim();
  if (trimmed.length === 0) throw new NotificationServiceError("bad_input");
  return notificationsRepo.deleteUserDevice(userId, trimmed);
};

/** Legacy `register-token` endpoint: a bare FCM registration token. */
export const registerToken = async (
  userId: string,
  token: string
): Promise<notificationsRepo.UserDeviceRow> =>
  registerDevice(userId, {
    registrationId: token,
    kind: "token",
    platform: "android",
  });

const sendToUser = async (input: {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}): Promise<PushResult & { deviceCount: number }> => {
  const devices = await notificationsRepo.listDevicesByUser(input.userId);
  if (devices.length === 0) {
    return {
      successCount: 0,
      failureCount: 0,
      invalidDeviceIds: [],
      deviceCount: 0,
    };
  }

  const result = await notificationSender({
    devices: devices.map((device) => ({
      id: device.id,
      registrationId: device.registration_id,
      kind: device.kind,
    })),
    title: input.title,
    body: input.body,
    data: input.data,
  });

  if (result.invalidDeviceIds.length > 0) {
    await notificationsRepo.deleteDevicesByIds(result.invalidDeviceIds);
  }

  return { ...result, deviceCount: devices.length };
};

export type NotifyUserInput = {
  title: string;
  body: string;
  /** Every value must be a string (FCM data payload); `type` and `id` are required. */
  data: { type: string; id: string } & Record<string, string>;
};

export type NotifyUserResult = {
  devices: number;
  sent: number;
  failed: number;
  /** Registrations FCM reported dead and that were deleted. */
  removed: number;
  /** Set when nothing could be attempted (bad input, DB/SDK failure). */
  error?: string;
};

/**
 * Push a notification to every device of `userId`.
 * Never throws: a failure here must not break the caller's own request. Use
 * `await` when you need the summary (scripts, tests) or call
 * `notifyUserInBackground` to fire and forget.
 */
export const notifyUser = async (
  userId: string,
  input: NotifyUserInput
): Promise<NotifyUserResult> => {
  try {
    const { type, id } = input.data ?? {};
    if (!type || !id) {
      throw new NotificationServiceError("bad_input");
    }
    const result = await sendToUser({ userId, ...input });
    return {
      devices: result.deviceCount,
      sent: result.successCount,
      failed: result.failureCount,
      removed: result.invalidDeviceIds.length,
    };
  } catch (error) {
    pushLogger.error(
      {
        userId,
        errorName: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      "notifyUser failed"
    );
    return {
      devices: 0,
      sent: 0,
      failed: 0,
      removed: 0,
      error: error instanceof Error ? error.message : "unknown",
    };
  }
};

/** Fire-and-forget variant of `notifyUser` for use inside request handlers. */
export const notifyUserInBackground = (
  userId: string,
  input: NotifyUserInput
): void => {
  void notifyUser(userId, input);
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_STALE_DEVICE_DAYS = 30;

/**
 * Delete (or, with dryRun, only count) device registrations whose app has not
 * checked in via POST /devices for more than `days` days. Not scheduled
 * automatically; run `npm run devices:cleanup` by hand.
 */
export const cleanupStaleDevices = async (
  days: number = DEFAULT_STALE_DEVICE_DAYS,
  options: { dryRun?: boolean; now?: Date } = {}
): Promise<{ cutoff: string; count: number; dryRun: boolean }> => {
  if (!Number.isFinite(days) || days <= 0) {
    throw new NotificationServiceError("bad_input");
  }
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  const dryRun = options.dryRun ?? false;
  const count = dryRun
    ? await notificationsRepo.countStaleDevices(cutoff)
    : await notificationsRepo.deleteStaleDevices(cutoff);
  return { cutoff, count, dryRun };
};

const MORNING_PLAN_BODY =
  "Hôm nay là một ngày mới. Hãy dành vài phút lên kế hoạch để bắt đầu thật chủ động nhé!";
const EVENING_DONE_BODY =
  "Tuyệt vời! Bạn đã hoàn thành toàn bộ todos hôm nay. Hãy tận hưởng một buổi tối nhẹ nhàng nhé!";

export const sendMorningNotifications = async (
  date: string
): Promise<{ users: number; sent: number; skipped: number; failed: number }> => {
  const userIds = await notificationsRepo.listActiveUserIds();
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const userId of userIds) {
    const claimed = await notificationsRepo.claimNotificationDelivery({
      userId,
      kind: "morning",
      dedupeKey: `morning:${userId}:${date}`,
    });
    if (!claimed) {
      skipped++;
      continue;
    }

    try {
      const count = await notificationsRepo.countImportantUrgentTodosForDate(
        userId,
        date
      );
      const result = await sendToUser({
        userId,
        title: "Chào buổi sáng!",
        body:
          count > 0
            ? `Bạn có ${count} todos quan trọng & khẩn cấp cần thực hiện ngay. Hãy bắt tay vào việc ngay thôi nào!`
            : MORNING_PLAN_BODY,
        data: { type: "morning", date, count: String(count) },
      });
      if (result.deviceCount > 0) sent++;
    } catch {
      failed++;
    }
  }

  return { users: userIds.length, sent, skipped, failed };
};

export const sendEveningNotifications = async (
  date: string
): Promise<{ users: number; sent: number; skipped: number; failed: number }> => {
  const userIds = await notificationsRepo.listActiveUserIds();
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const userId of userIds) {
    const claimed = await notificationsRepo.claimNotificationDelivery({
      userId,
      kind: "evening",
      dedupeKey: `evening:${userId}:${date}`,
    });
    if (!claimed) {
      skipped++;
      continue;
    }

    try {
      const count = await notificationsRepo.countRemainingTodosForDate(
        userId,
        date
      );
      const result = await sendToUser({
        userId,
        title: "Tổng kết ngày",
        body:
          count > 0
            ? `Bạn hiện còn ${count} todos cần hoàn thiện để có 1 ngày trọn vẹn và năng suất!`
            : EVENING_DONE_BODY,
        data: { type: "evening", date, count: String(count) },
      });
      if (result.deviceCount > 0) sent++;
    } catch {
      failed++;
    }
  }

  return { users: userIds.length, sent, skipped, failed };
};

export const sendTodoReminderNotifications = async (
  date: string,
  hhmm: string
): Promise<{ todos: number; sent: number; skipped: number; failed: number }> => {
  const dueTodos = await notificationsRepo.listDueTodoReminders(date, hhmm);
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const todo of dueTodos) {
    const claimed = await notificationsRepo.claimNotificationDelivery({
      userId: todo.user_id,
      todoId: todo.id,
      kind: "todo_reminder",
      dedupeKey: `todo_reminder:${todo.id}:${date}:${hhmm}`,
    });
    if (!claimed) {
      skipped++;
      continue;
    }

    try {
      const result = await sendToUser({
        userId: todo.user_id,
        title: "Nhắc nhở todo",
        body: `Đã đến giờ: ${todo.title}`,
        data: {
          type: "todo_reminder",
          todo_id: todo.id,
          scheduled_date: todo.scheduled_date,
          time: todo.time,
        },
      });
      if (result.deviceCount > 0) sent++;
    } catch {
      failed++;
    }
  }

  return { todos: dueTodos.length, sent, skipped, failed };
};

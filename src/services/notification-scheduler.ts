import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env.js";
import {
  getVietnamNowParts,
  VIETNAM_TIME_ZONE,
} from "../utils/vietnam-time.js";
import { isPushConfigured } from "./firebase.js";
import {
  sendEveningNotifications,
  sendMorningNotifications,
  sendTodoReminderNotifications,
} from "./notifications.js";

let interval: NodeJS.Timeout | null = null;
let running = false;

export const runNotificationTick = async (
  now: Date = new Date()
): Promise<void> => {
  const { date, hhmm } = getVietnamNowParts(now);

  if (hhmm === "08:00") {
    await sendMorningNotifications(date);
  }
  if (hhmm === "17:00") {
    await sendEveningNotifications(date);
  }

  await sendTodoReminderNotifications(date, hhmm);
};

export const startNotificationScheduler = (
  logger: FastifyBaseLogger
): void => {
  if (!env.NOTIFICATIONS_ENABLED) {
    logger.info(
      { timezone: VIETNAM_TIME_ZONE },
      "Notification scheduler disabled"
    );
    return;
  }
  if (interval) return;

  if (!isPushConfigured()) {
    logger.warn(
      "NOTIFICATIONS_ENABLED=true but Firebase credentials are not loaded (check GOOGLE_APPLICATION_CREDENTIALS); pushes will be skipped"
    );
  }

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runNotificationTick();
    } catch (error) {
      logger.error({ err: error }, "Notification scheduler tick failed");
    } finally {
      running = false;
    }
  };

  interval = setInterval(() => {
    void tick();
  }, 60_000);
  interval.unref();
  void tick();

  logger.info(
    { timezone: VIETNAM_TIME_ZONE },
    "Notification scheduler started"
  );
};

export const stopNotificationSchedulerForTests = (): void => {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  running = false;
};

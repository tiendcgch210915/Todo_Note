import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env.js";
import { isPushConfigured } from "./firebase.js";
import { runTick } from "./notification-tick.js";

let interval: NodeJS.Timeout | null = null;
let running = false;

/**
 * Bộ hẹn giờ trong tiến trình: gọi `runTick` mỗi 60 giây khi NOTIFY_INPROCESS_TICK=true.
 * Chỉ hoạt động khi instance đang thức; Render free ngủ khi rảnh nên vẫn cần cron bên ngoài
 * gọi POST /internal/notifications/tick. Chạy cả hai cùng lúc hoặc nhiều instance đều an toàn
 * vì mỗi job chỉ một bên giành được.
 */
export const startNotificationScheduler = (
  logger: FastifyBaseLogger
): void => {
  if (!env.NOTIFY_INPROCESS_TICK) {
    logger.info(
      "In-process notification tick disabled (set NOTIFY_INPROCESS_TICK=true or call POST /internal/notifications/tick)"
    );
    return;
  }
  if (interval) return;

  if (!env.NOTIFY_DRY_RUN && !isPushConfigured()) {
    logger.warn(
      "NOTIFY_INPROCESS_TICK=true but Firebase credentials are not loaded (check GOOGLE_APPLICATION_CREDENTIALS); jobs stay pending until push is configured"
    );
  }

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const summary = await runTick({ dryRun: env.NOTIFY_DRY_RUN, logger });
      const worked =
        summary.planned +
        summary.backfilled +
        summary.claimed +
        summary.missed +
        summary.recovered;
      if (worked > 0) logger.info(summary, "Notification tick");
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
    { dryRun: env.NOTIFY_DRY_RUN },
    "Notification in-process tick started"
  );
};

export const stopNotificationSchedulerForTests = (): void => {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  running = false;
};

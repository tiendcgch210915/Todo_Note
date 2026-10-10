import type { FastifyBaseLogger } from "fastify";
import { LOOPS } from "../config/notification-policy.js";
import { env } from "../config/env.js";
import { isPushConfigured } from "./firebase.js";
import {
  createNotificationLoops,
  type NotificationLoops,
} from "./notification-loops.js";
import { runDispatch, runMaintenance } from "./notification-tick.js";

let loops: NotificationLoops | null = null;

/**
 * Vòng lặp trong tiến trình khi NOTIFY_INPROCESS_TICK=true:
 *  - vòng NHANH mỗi NOTIFY_FAST_LOOP_SECONDS (mặc định 3 s): chỉ gửi job đến hạn;
 *  - vòng CHẬM mỗi 60 s: planner + dọn dẹp.
 * Chỉ hoạt động khi instance đang thức; Render free ngủ khi rảnh nên cron ngoài gọi
 * POST /internal/notifications/tick vẫn là dự phòng (tick làm cả hai việc). Chạy cùng cron ngoài
 * hoặc nhiều instance đều an toàn vì mỗi job chỉ một bên giành được.
 *
 * Trả về true nếu vòng lặp đã được bật (để server đăng ký xử lý tín hiệu tắt máy).
 */
export const startNotificationScheduler = (
  logger: FastifyBaseLogger
): boolean => {
  if (!env.NOTIFY_INPROCESS_TICK) {
    logger.info(
      "In-process notification loops disabled (set NOTIFY_INPROCESS_TICK=true or call POST /internal/notifications/tick)"
    );
    return false;
  }
  if (loops) return true;

  if (!env.NOTIFY_DRY_RUN && !isPushConfigured()) {
    logger.warn(
      "NOTIFY_INPROCESS_TICK=true but Firebase credentials are not loaded (check GOOGLE_APPLICATION_CREDENTIALS); jobs stay pending until push is configured"
    );
  }

  const dryRun = env.NOTIFY_DRY_RUN;
  loops = createNotificationLoops({
    // Mỗi job gửi xong tự ghi một dòng "notification sent" (xem logSent), nên vòng nhanh không
    // cần log tổng kết thêm.
    dispatch: () => runDispatch({ dryRun, logger }),
    maintain: async () => {
      const summary = await runMaintenance({ dryRun, logger });
      const worked =
        summary.planned +
        summary.backfilled +
        summary.missed +
        summary.recovered +
        summary.stuck_failed +
        summary.purged;
      if (worked > 0) logger.info(summary, "Notification maintenance");
    },
    fastSeconds: env.NOTIFY_FAST_LOOP_SECONDS,
    logger,
  });
  loops.start();

  logger.info(
    {
      dryRun,
      fast_loop_seconds: env.NOTIFY_FAST_LOOP_SECONDS,
      maintenance_seconds: LOOPS.maintenanceSeconds,
    },
    "Notification in-process loops started"
  );
  return true;
};

/** Dừng sạch: ngừng hẹn giờ và chờ nhịp đang chạy kết thúc (tối đa LOOPS.stopTimeoutMs). */
export const stopNotificationScheduler = async (): Promise<void> => {
  const current = loops;
  loops = null;
  if (current) await current.stop();
};

export const stopNotificationSchedulerForTests = (): void => {
  void stopNotificationScheduler();
};

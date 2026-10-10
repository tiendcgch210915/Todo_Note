/**
 * Hai vòng lặp trong tiến trình cho thông báo. Module này KHÔNG import env/firebase để test được
 * mà không cần cấu hình; việc nối với runDispatch/runMaintenance nằm ở notification-scheduler.ts.
 *
 *  - Vòng NHANH (`dispatch`, mỗi `fastSeconds`): chỉ gửi job đến hạn -> độ trễ cỡ vài giây.
 *  - Vòng CHẬM (`maintain`, mỗi 60 giây): planner + dọn dẹp.
 *
 * Đảm bảo của mỗi vòng:
 *  - Không bao giờ chồng nhịp: nhịp trước chưa xong thì nhịp kế bị BỎ (không xếp hàng).
 *  - Lỗi (DB, FCM, ...) chỉ được ghi log rồi thử lại ở nhịp sau; vòng lặp không bao giờ chết.
 *  - Log lỗi bị giới hạn (một dòng mỗi `errorLogIntervalMs`, kèm số lần đã gộp) để DB sập
 *    không làm ngập log mỗi vài giây.
 *  - `stop()` ngừng hẹn giờ và chờ nhịp đang chạy kết thúc (có giới hạn thời gian), để một job
 *    đã gửi xong kịp được ghi `sent` thay vì kẹt `processing` rồi bị gửi lại.
 */
import { LOOPS } from "../config/notification-policy.js";

export type LoopLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

export type NotificationLoopsOptions = {
  /** Đường nhanh: gửi job đến hạn. */
  dispatch: () => Promise<unknown>;
  /** Planner + dọn dẹp. */
  maintain: () => Promise<unknown>;
  fastSeconds: number;
  maintenanceSeconds?: number;
  logger: LoopLogger;
  errorLogIntervalMs?: number;
  stopTimeoutMs?: number;
  /** Đồng hồ (ms) dùng để giới hạn tần suất log lỗi; tiêm vào khi test. */
  clock?: () => number;
};

export type LoopStats = {
  /** Số nhịp đã bắt đầu chạy. */
  runs: number;
  /** Số nhịp bị bỏ vì nhịp trước chưa xong. */
  skipped: number;
  /** Số nhịp kết thúc bằng lỗi. */
  failures: number;
};

export type LoopName = "fast" | "maintenance";

export type NotificationLoops = {
  /** Chạy ngay một nhịp mỗi vòng (catch-up sau khi khởi động) rồi hẹn giờ. Gọi lại là no-op. */
  start: () => void;
  /** Ngừng hẹn giờ và chờ các nhịp đang chạy (tối đa stopTimeoutMs). Gọi lại là no-op. */
  stop: () => Promise<void>;
  /** Chờ các nhịp đang chạy kết thúc (không chờ nhịp chưa bắt đầu). */
  idle: () => Promise<void>;
  stats: () => Record<LoopName, LoopStats>;
};

export const createNotificationLoops = (
  options: NotificationLoopsOptions
): NotificationLoops => {
  const clock = options.clock ?? Date.now;
  const errorLogIntervalMs = options.errorLogIntervalMs ?? LOOPS.errorLogIntervalMs;
  const stopTimeoutMs = options.stopTimeoutMs ?? LOOPS.stopTimeoutMs;
  const intervals: Record<LoopName, number> = {
    fast: options.fastSeconds * 1000,
    maintenance: (options.maintenanceSeconds ?? LOOPS.maintenanceSeconds) * 1000,
  };

  let started = false;
  let stopped = false;

  const makeLoop = (name: LoopName, task: () => Promise<unknown>) => {
    const stats: LoopStats = { runs: 0, skipped: 0, failures: 0 };
    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight: Promise<void> | null = null;
    let lastErrorLogAt = Number.NEGATIVE_INFINITY;
    let suppressed = 0;

    const reportError = (error: unknown): void => {
      const now = clock();
      if (now - lastErrorLogAt < errorLogIntervalMs) {
        suppressed++;
        return;
      }
      options.logger.error(
        {
          loop: name,
          errorName: error instanceof Error ? error.name : "unknown",
          errorMessage: error instanceof Error ? error.message : String(error),
          suppressed_since_last_log: suppressed,
        },
        "Notification loop beat failed; will retry on the next beat"
      );
      lastErrorLogAt = now;
      suppressed = 0;
    };

    const beat = (): void => {
      if (stopped) return;
      if (inFlight) {
        stats.skipped++; // nhịp trước chưa xong: bỏ nhịp này, không xếp hàng
        return;
      }
      stats.runs++;
      inFlight = (async () => {
        try {
          await task();
        } catch (error) {
          stats.failures++;
          reportError(error);
        }
      })().finally(() => {
        inFlight = null;
      });
    };

    return {
      stats,
      start: (): void => {
        timer = setInterval(beat, intervals[name]);
        timer.unref();
        beat();
      },
      halt: (): void => {
        if (timer) clearInterval(timer);
        timer = null;
      },
      running: (): Promise<void> => inFlight ?? Promise.resolve(),
    };
  };

  const fast = makeLoop("fast", options.dispatch);
  const maintenance = makeLoop("maintenance", options.maintain);
  const all = [fast, maintenance];

  const idle = async (): Promise<void> => {
    await Promise.all(all.map((loop) => loop.running()));
  };

  return {
    start: (): void => {
      if (started || stopped) return;
      started = true;
      for (const loop of all) loop.start();
    },

    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      for (const loop of all) loop.halt();

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const gaveUp = new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), stopTimeoutMs);
      });
      const outcome = await Promise.race([idle().then(() => "idle" as const), gaveUp]);
      if (timeout) clearTimeout(timeout);
      if (outcome === "timeout") {
        options.logger.warn(
          { stop_timeout_ms: stopTimeoutMs },
          "Notification loops did not finish in time; leaving them to the stuck-job recovery"
        );
      }
    },

    idle,

    stats: () => ({ fast: { ...fast.stats }, maintenance: { ...maintenance.stats } }),
  };
};

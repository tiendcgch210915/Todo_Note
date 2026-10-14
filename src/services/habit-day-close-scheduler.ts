import type { FastifyBaseLogger } from "fastify";
import {
  closeHabitDaysForAllUsers,
  type CloseAllResult,
} from "./habit-day-close.js";

let interval: NodeJS.Timeout | null = null;
let running = false;

export const runHabitDayCloseTick = (
  now: Date = new Date()
): Promise<CloseAllResult> => closeHabitDaysForAllUsers(now);

/**
 * Mỗi phút quét một lần. Công việc thật chỉ phát sinh với người dùng mà ngày địa phương vừa
 * sang ngày mới (so với cursor), nên các phút còn lại chỉ tốn một truy vấn. Vì dựa cursor chứ
 * không so khớp đúng "00:00", lần tick ngay lúc khởi động cũng bù được đêm mà instance ngủ.
 */
export const startHabitDayCloseScheduler = (logger: FastifyBaseLogger): void => {
  if (interval) return;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await runHabitDayCloseTick();
      if (result.habits > 0 || result.failed > 0) {
        logger.info(result, "Habit days closed");
      }
    } catch (error) {
      logger.error({ err: error }, "Habit day close tick failed");
    } finally {
      running = false;
    }
  };

  interval = setInterval(() => {
    void tick();
  }, 60_000);
  interval.unref();
  void tick();

  logger.info("Habit day close scheduler started");
};

export const stopHabitDayCloseSchedulerForTests = (): void => {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  running = false;
};

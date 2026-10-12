import { getChangesSince, type SyncChanges } from "../repositories/sync.repo.js";
import { ensureHabitDaysClosedSafe } from "./habit-day-close.js";

const DEFAULT_RETRY_DELAYS_MS = [100, 300] as const;

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
};

const errorChain = (error: unknown): ErrorLike[] => {
  const chain: ErrorLike[] = [];
  const seen = new Set<unknown>();
  let current = error;

  while (
    current !== null &&
    typeof current === "object" &&
    !seen.has(current)
  ) {
    seen.add(current);
    const errorLike = current as ErrorLike;
    chain.push(errorLike);
    current = errorLike.cause;
  }

  return chain;
};

export const isTransientSyncPullError = (error: unknown): boolean => {
  const transientCodes = new Set([
    "SERVER_ERROR",
    "HRANA_CLOSED_ERROR",
    "HRANA_WEBSOCKET_ERROR",
    "HTTP_TIMEOUT",
    "NETWORK_ERROR",
    "UNKNOWN",
  ]);
  const transientMessage =
    /(?:fetch failed|network|socket|connection|timed? ?out|timeout|temporar|service unavailable|http status (?:408|425|429|5\d\d))/i;

  return errorChain(error).some((item) => {
    const code = typeof item.code === "string" ? item.code : "";
    const message = typeof item.message === "string" ? item.message : "";
    return transientCodes.has(code) || transientMessage.test(message);
  });
};

export const withSyncPullRetry = async <T>(
  operation: (attempt: number) => Promise<T>,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))
): Promise<T> => {
  let attempt = 0;

  while (true) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (
        attempt >= retryDelaysMs.length ||
        !isTransientSyncPullError(error)
      ) {
        throw error;
      }

      await sleep(retryDelaysMs[attempt]);
      attempt += 1;
    }
  }
};

export const pullSyncChanges = async (
  userId: string,
  since: string | null
): Promise<SyncChanges> => {
  // Trước khi đọc: nếu ngày địa phương của người dùng vừa sang ngày mới và job nền chưa kịp
  // chạy (instance mới thức dậy), điền dòng completed=0 để chúng nằm ngay trong lần pull này.
  await ensureHabitDaysClosedSafe(userId);
  return withSyncPullRetry(() => getChangesSince(userId, since));
};

import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { runTick } from "../../services/notification-tick.js";

export type InternalNotificationRoutesOptions = {
  /** NOTIFY_TICK_SECRET. Thiếu/rỗng = từ chối MỌI yêu cầu. */
  secret?: string;
  /** NOTIFY_DRY_RUN. */
  dryRun?: boolean;
};

const digest = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

/**
 * So sánh thời gian hằng định: băm cả hai về cùng độ dài rồi timingSafeEqual,
 * nên không lộ độ dài hay phần đúng của bí mật qua thời gian phản hồi.
 */
export const secretMatches = (
  provided: unknown,
  expected: string | undefined
): boolean => {
  if (!expected) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  return timingSafeEqual(digest(provided), digest(expected));
};

/**
 * POST /internal/notifications/tick — không dùng JWT người dùng; chỉ bí mật trong header
 * `x-notify-tick-secret`. Phản hồi là số đếm, không chứa dữ liệu cá nhân.
 */
const internalNotificationRoutes: FastifyPluginAsync<
  InternalNotificationRoutesOptions
> = async (app, options) => {
  app.post("/tick", async (req, reply) => {
    if (!secretMatches(req.headers["x-notify-tick-secret"], options.secret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return runTick({ dryRun: options.dryRun ?? false, logger: req.log });
  });
};

export default internalNotificationRoutes;

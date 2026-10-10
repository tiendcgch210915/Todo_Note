import type { FastifyInstance, FastifyReply } from "fastify";
import { UpdateNotificationSettingsSchema } from "../../../schemas/api/notification-settings.js";
import * as settings from "../../../services/notification-settings.js";

const mapErr = (error: unknown, reply: FastifyReply): FastifyReply => {
  if (error instanceof settings.NotificationSettingsError) {
    return reply.code(404).send({ error: "not_found" });
  }
  throw error;
};

export default async function notificationSettingsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireUser);

  // GET /notification-settings
  app.get("/", async (req, reply) => {
    try {
      return await settings.getNotificationSettings(req.userId);
    } catch (error) {
      return mapErr(error, reply);
    }
  });

  // PUT /notification-settings  { morningTime, eveningTime, timezone }
  app.put("/", async (req, reply) => {
    const parsed = UpdateNotificationSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      return await settings.updateNotificationSettings(req.userId, parsed.data);
    } catch (error) {
      return mapErr(error, reply);
    }
  });
}

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  RegisterDeviceSchema,
  UnregisterDeviceSchema,
} from "../../../schemas/api/devices.js";
import * as notifications from "../../../services/notifications.js";

const mapErr = (error: unknown, reply: FastifyReply): FastifyReply => {
  if (error instanceof notifications.NotificationServiceError) {
    if (error.code === "not_found") return reply.code(404).send({ error: "not_found" });
    if (error.code === "bad_input") return reply.code(400).send({ error: "bad_input" });
  }
  throw error;
};

export default async function deviceRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireUser);

  // Register / refresh this device. Call on app start and whenever the FID/token
  // changes; every call bumps last_seen_at.
  app.post("/", async (req, reply) => {
    const parsed = RegisterDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }

    try {
      const device = await notifications.registerDevice(req.userId, parsed.data);
      return {
        ok: true,
        device_id: device.id,
        last_seen_at: device.last_seen_at,
      };
    } catch (error) {
      return mapErr(error, reply);
    }
  });

  // Unregister this device (logout). Only ever touches the caller's own rows.
  app.delete("/", async (req, reply) => {
    const parsed = UnregisterDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }

    try {
      const deleted = await notifications.unregisterDevice(
        req.userId,
        parsed.data.registrationId
      );
      return { ok: true, deleted };
    } catch (error) {
      return mapErr(error, reply);
    }
  });
}

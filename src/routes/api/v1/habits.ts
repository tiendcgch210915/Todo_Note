import type { FastifyInstance, FastifyReply } from "fastify";
import {
  CreateHabitSchema,
  UpdateHabitSchema,
  LogHabitSchema,
  PatchLogSchema,
  ListHabitsQuerySchema,
  CalendarRangeQuerySchema,
} from "../../../schemas/api/habits.js";
import * as habits from "../../../services/habits.js";
import { ensureHabitDaysClosedSafe } from "../../../services/habit-day-close.js";

const IsoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

const mapErr = (e: unknown, reply: FastifyReply): FastifyReply => {
  if (e instanceof habits.ServiceError) {
    if (e.code === "not_found") return reply.code(404).send({ error: "not_found" });
    if (e.code === "archived") return reply.code(400).send({ error: "archived" });
    if (e.code === "invalid_range")
      return reply.code(400).send({ error: "invalid_range" });
    if (e.code === "invalid_checklist")
      return reply.code(400).send({ error: "invalid_checklist" });
  }
  throw e;
};

export default async function habitsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireUser);
  // Đọc habit/log/lịch sau nửa đêm phải thấy ngay các dòng "không hoàn thành" của ngày vừa qua,
  // kể cả khi job nền chưa kịp chạy. Chỉ cho GET; ghi không cần.
  app.addHook("preHandler", async (req) => {
    if (req.method === "GET" && req.userId) {
      await ensureHabitDaysClosedSafe(req.userId);
    }
  });

  // POST /
  app.post("/", async (req, reply) => {
    const parsed = CreateHabitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const habit = await habits.createHabit(req.userId, parsed.data);
      return reply.code(201).send({ habit });
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // GET /
  app.get("/", async (req, reply) => {
    const parsed = ListHabitsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    const items = await habits.listHabits(req.userId, parsed.data);
    return { items };
  });

  // GET /calendar — đặt trước /:id
  app.get("/calendar", async (req, reply) => {
    const parsed = CalendarRangeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      return await habits.getCalendar(req.userId, parsed.data);
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // GET /:id
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    try {
      return await habits.getHabitDetail(req.userId, req.params.id);
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // PATCH /:id
  app.patch<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const parsed = UpdateHabitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const habit = await habits.updateHabit(req.userId, req.params.id, parsed.data);
      return { habit };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // DELETE /:id
  app.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    try {
      await habits.deleteHabit(req.userId, req.params.id);
      return reply.code(204).send();
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // POST /:id/archive
  app.post<{ Params: { id: string } }>("/:id/archive", async (req, reply) => {
    try {
      const habit = await habits.archiveHabit(req.userId, req.params.id);
      return { habit };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // POST /:id/unarchive
  app.post<{ Params: { id: string } }>("/:id/unarchive", async (req, reply) => {
    try {
      const habit = await habits.unarchiveHabit(req.userId, req.params.id);
      return { habit };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // POST /:id/logs
  app.post<{ Params: { id: string } }>("/:id/logs", async (req, reply) => {
    const parsed = LogHabitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const result = await habits.logHabit(req.userId, req.params.id, parsed.data);
      return reply.code(201).send(result);
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // PATCH /:id/logs/:log_date
  app.patch<{ Params: { id: string; log_date: string } }>(
    "/:id/logs/:log_date",
    async (req, reply) => {
      if (!IsoDateRegex.test(req.params.log_date)) {
        return reply.code(400).send({ error: "bad_input" });
      }
      const parsed = PatchLogSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "bad_input", issues: parsed.error.issues });
      }
      try {
        const result = await habits.patchLog(
          req.userId,
          req.params.id,
          req.params.log_date,
          parsed.data
        );
        return result;
      } catch (e) {
        return mapErr(e, reply);
      }
    }
  );

  // DELETE /:id/logs/:log_date
  app.delete<{ Params: { id: string; log_date: string } }>(
    "/:id/logs/:log_date",
    async (req, reply) => {
      if (!IsoDateRegex.test(req.params.log_date)) {
        return reply.code(400).send({ error: "bad_input" });
      }
      try {
        const result = await habits.removeLog(
          req.userId,
          req.params.id,
          req.params.log_date
        );
        return result;
      } catch (e) {
        return mapErr(e, reply);
      }
    }
  );

  // GET /:id/logs?from&to
  app.get<{ Params: { id: string } }>("/:id/logs", async (req, reply) => {
    const parsed = CalendarRangeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const items = await habits.getHabitLogs(
        req.userId,
        req.params.id,
        parsed.data
      );
      return { items };
    } catch (e) {
      return mapErr(e, reply);
    }
  });
}

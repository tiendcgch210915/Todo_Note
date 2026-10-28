import type { FastifyInstance, FastifyReply } from "fastify";
import {
  CreateCategorySchema,
  UpdateCategorySchema,
  ListCategoriesQuerySchema,
  CreateTemplateSchema,
  UpdateTemplateSchema,
  UpsertTemplateItemSchema,
  PatchTemplateItemSchema,
  ReorderItemsSchema,
  ReorderTemplatesSchema,
  ListTemplatesQuerySchema,
  StartRunSchema,
  CompleteRunSchema,
  UpdateRunItemSchema,
  ListRunsQuerySchema,
} from "../../../schemas/api/checklists.js";
import {
  OccurrenceDateParamSchema,
  OccurrencesQuerySchema,
  PutChecklistScheduleSchema,
  PutOccurrenceSchema,
  PutOccurrenceStatusSchema,
} from "../../../schemas/api/checklist-schedules.js";
import * as checklists from "../../../services/checklists.js";
import * as schedules from "../../../services/checklist-schedules.js";

const mapErr = (e: unknown, reply: FastifyReply): FastifyReply => {
  if (e instanceof schedules.ScheduleServiceError) {
    if (e.code === "not_found") return reply.code(404).send({ error: "not_found" });
    if (e.code === "not_an_occurrence")
      return reply.code(400).send({ error: "not_an_occurrence" });
  }
  if (e instanceof checklists.ServiceError) {
    if (e.code === "not_found") return reply.code(404).send({ error: "not_found" });
    if (e.code === "duplicate") return reply.code(409).send({ error: "duplicate" });
    if (e.code === "invalid_category")
      return reply.code(400).send({ error: "invalid_category" });
    if (e.code === "incomplete_required")
      return reply.code(409).send({ error: "incomplete_required" });
  }
  if (e instanceof Error && e.message === "bad_cursor") {
    return reply.code(400).send({ error: "bad_cursor" });
  }
  throw e;
};

export default async function checklistsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireUser);

  // ===== Categories =====

  app.get("/categories", async (req, reply) => {
    const parsed = ListCategoriesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    return checklists.listCategories(req.userId, parsed.data);
  });

  app.get<{ Params: { id: string } }>("/categories/:id", async (req, reply) => {
    try {
      return await checklists.getCategoryDetail(req.userId, req.params.id);
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  app.post("/categories", async (req, reply) => {
    const parsed = CreateCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const created = await checklists.createCategory(req.userId, parsed.data);
      return reply.code(201).send(created);
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/categories/:id", async (req, reply) => {
    const parsed = UpdateCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const category = await checklists.updateCategory(
        req.userId,
        req.params.id,
        parsed.data
      );
      return { category };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  app.delete<{ Params: { id: string } }>("/categories/:id", async (req, reply) => {
    try {
      await checklists.deleteCategory(req.userId, req.params.id);
      return reply.code(204).send();
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // ===== Templates =====

  app.get("/templates", async (req, reply) => {
    const parsed = ListTemplatesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    return checklists.listTemplates(req.userId, parsed.data);
  });

  app.post("/templates/reorder", async (req, reply) => {
    const parsed = ReorderTemplatesSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      return await checklists.reorderTemplates(req.userId, parsed.data);
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/templates/:id", async (req, reply) => {
    try {
      return await checklists.getTemplateDetailWithSchedule(req.userId, req.params.id);
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  app.post("/templates", async (req, reply) => {
    const parsed = CreateTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    const created = await checklists.createTemplate(req.userId, parsed.data);
    return reply.code(201).send(created);
  });

  app.patch<{ Params: { id: string } }>("/templates/:id", async (req, reply) => {
    const parsed = UpdateTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const template = await checklists.updateTemplate(
        req.userId,
        req.params.id,
        parsed.data
      );
      return { template };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  app.delete<{ Params: { id: string } }>("/templates/:id", async (req, reply) => {
    try {
      await checklists.deleteTemplate(req.userId, req.params.id);
      return reply.code(204).send();
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/templates/:id/items", async (req, reply) => {
    const parsed = UpsertTemplateItemSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const item = await checklists.addTemplateItem(
        req.userId,
        req.params.id,
        parsed.data
      );
      return reply.code(201).send({ item });
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  app.patch<{ Params: { id: string; itemId: string } }>(
    "/templates/:id/items/:itemId",
    async (req, reply) => {
      const parsed = PatchTemplateItemSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "bad_input", issues: parsed.error.issues });
      }
      try {
        const item = await checklists.patchTemplateItem(
          req.userId,
          req.params.id,
          req.params.itemId,
          parsed.data
        );
        return { item };
      } catch (e) {
        return mapErr(e, reply);
      }
    }
  );

  app.delete<{ Params: { id: string; itemId: string } }>(
    "/templates/:id/items/:itemId",
    async (req, reply) => {
      try {
        await checklists.deleteTemplateItem(
          req.userId,
          req.params.id,
          req.params.itemId
        );
        return reply.code(204).send();
      } catch (e) {
        return mapErr(e, reply);
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/templates/:id/items/reorder",
    async (req, reply) => {
      const parsed = ReorderItemsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "bad_input", issues: parsed.error.issues });
      }
      try {
        const items = await checklists.reorderTemplateItems(
          req.userId,
          req.params.id,
          parsed.data
        );
        return { items };
      } catch (e) {
        return mapErr(e, reply);
      }
    }
  );

  // ===== Schedules (lịch lặp + thông báo đúng giờ) =====

  app.get<{ Params: { id: string } }>("/templates/:id/schedule", async (req, reply) => {
    try {
      return { schedule: await schedules.getSchedule(req.userId, req.params.id) };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  app.put<{ Params: { id: string } }>("/templates/:id/schedule", async (req, reply) => {
    const parsed = PutChecklistScheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const schedule = await schedules.putSchedule(req.userId, req.params.id, parsed.data);
      return { schedule };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  app.delete<{ Params: { id: string } }>("/templates/:id/schedule", async (req, reply) => {
    try {
      await schedules.deleteSchedule(req.userId, req.params.id);
      return reply.code(204).send();
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  app.put<{ Params: { id: string; date: string } }>(
    "/templates/:id/occurrences/:date",
    async (req, reply) => {
      const date = OccurrenceDateParamSchema.safeParse(req.params);
      const body = PutOccurrenceSchema.safeParse(req.body);
      if (!date.success || !body.success) {
        const issues = [
          ...(date.success ? [] : date.error.issues),
          ...(body.success ? [] : body.error.issues),
        ];
        return reply.code(400).send({ error: "bad_input", issues });
      }
      try {
        return await schedules.putOccurrence(
          req.userId,
          req.params.id,
          date.data.date,
          body.data.time
        );
      } catch (e) {
        return mapErr(e, reply);
      }
    }
  );

  app.delete<{ Params: { id: string; date: string } }>(
    "/templates/:id/occurrences/:date",
    async (req, reply) => {
      const date = OccurrenceDateParamSchema.safeParse(req.params);
      if (!date.success) {
        return reply
          .code(400)
          .send({ error: "bad_input", issues: date.error.issues });
      }
      try {
        await schedules.deleteOccurrence(req.userId, req.params.id, date.data.date);
        return reply.code(204).send();
      } catch (e) {
        return mapErr(e, reply);
      }
    }
  );

  // Đánh dấu tay "Đã xong / Chưa hoàn thành" của một ngày (giữ checklist trong timeline).
  app.put<{ Params: { id: string; date: string } }>(
    "/templates/:id/occurrences/:date/status",
    async (req, reply) => {
      const date = OccurrenceDateParamSchema.safeParse(req.params);
      const body = PutOccurrenceStatusSchema.safeParse(req.body);
      if (!date.success || !body.success) {
        const issues = [
          ...(date.success ? [] : date.error.issues),
          ...(body.success ? [] : body.error.issues),
        ];
        return reply.code(400).send({ error: "bad_input", issues });
      }
      try {
        return await schedules.putOccurrenceStatus(
          req.userId,
          req.params.id,
          date.data.date,
          body.data.status
        );
      } catch (e) {
        return mapErr(e, reply);
      }
    }
  );

  app.delete<{ Params: { id: string; date: string } }>(
    "/templates/:id/occurrences/:date/status",
    async (req, reply) => {
      const date = OccurrenceDateParamSchema.safeParse(req.params);
      if (!date.success) {
        return reply
          .code(400)
          .send({ error: "bad_input", issues: date.error.issues });
      }
      try {
        await schedules.deleteOccurrenceStatus(req.userId, req.params.id, date.data.date);
        return reply.code(204).send();
      } catch (e) {
        return mapErr(e, reply);
      }
    }
  );

  // Nguồn sự thật duy nhất cho việc mở rộng lịch (tối đa 62 ngày).
  app.get("/occurrences", async (req, reply) => {
    const parsed = OccurrencesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    const items = await schedules.listOccurrences(req.userId, parsed.data.from, parsed.data.to);
    return { items };
  });

  // ===== Runs =====

  app.post("/runs", async (req, reply) => {
    const parsed = StartRunSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const created = await checklists.startRun(req.userId, parsed.data);
      return reply.code(201).send(created);
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  app.get("/runs", async (req, reply) => {
    const parsed = ListRunsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const { rows, nextCursor } = await checklists.listRuns(
        req.userId,
        parsed.data
      );
      return { items: rows, nextCursor };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    try {
      return await checklists.getRunDetail(req.userId, req.params.id);
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  app.patch<{ Params: { id: string; itemId: string } }>(
    "/runs/:id/items/:itemId",
    async (req, reply) => {
      const parsed = UpdateRunItemSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "bad_input", issues: parsed.error.issues });
      }
      try {
        const item = await checklists.updateRunItem(
          req.userId,
          req.params.id,
          req.params.itemId,
          parsed.data
        );
        return { item };
      } catch (e) {
        return mapErr(e, reply);
      }
    }
  );

  app.post<{ Params: { id: string } }>("/runs/:id/complete", async (req, reply) => {
    const parsed = CompleteRunSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const run = await checklists.completeRun(
        req.userId,
        req.params.id,
        parsed.data
      );
      return { status: "completed", duration_ms: run.duration_ms };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/runs/:id/abandon", async (req, reply) => {
    try {
      await checklists.abandonRun(req.userId, req.params.id);
      return { status: "abandoned" };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  app.delete<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    try {
      await checklists.deleteRun(req.userId, req.params.id);
      return reply.code(204).send();
    } catch (e) {
      return mapErr(e, reply);
    }
  });
}

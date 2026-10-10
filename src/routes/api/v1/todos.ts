import type { FastifyInstance, FastifyReply } from "fastify";
import {
  CreateTodoSchema,
  UpdateTodoSchema,
  ListTodosQuerySchema,
  CompleteTodoSchema,
  DeleteTodoQuerySchema,
  ToggleFrogSchema,
  ClassifyEisenhowerSchema,
  MoveToDaySchema,
  AttachTagSchema,
  ReplaceTodoTagsSchema,
  TodoTimerSchema,
} from "../../../schemas/api/todos.js";
import * as todos from "../../../services/todos.js";
import {
  applyTimerEvent,
  TimerServiceError,
} from "../../../services/todo-timers.js";

const mapErr = (e: unknown, reply: FastifyReply): FastifyReply => {
  if (e instanceof todos.ServiceError) {
    if (e.code === "not_found") return reply.code(404).send({ error: "not_found" });
    if (e.code === "duplicate") return reply.code(409).send({ error: "duplicate" });
    if (e.code === "cycle") return reply.code(409).send({ error: "cycle" });
    if (e.code === "invalid_parent")
      return reply.code(400).send({ error: "invalid_parent" });
    if (e.code === "invalid_trigger")
      return reply.code(400).send({ error: "invalid_trigger" });
    if (e.code === "invalid_habit")
      return reply.code(400).send({ error: "invalid_habit" });
    if (e.code === "bad_input") return reply.code(400).send({ error: "bad_input" });
  }
  if (e instanceof Error && e.message === "bad_cursor") {
    return reply.code(400).send({ error: "bad_cursor" });
  }
  throw e;
};

const IsoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

export default async function todosRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireUser);

  // POST /
  app.post("/", async (req, reply) => {
    const parsed = CreateTodoSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const detail = await todos.createTodo(req.userId, parsed.data);
      return reply.code(201).send(detail);
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // GET /
  app.get("/", async (req, reply) => {
    const parsed = ListTodosQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const { rows, nextCursor } = await todos.listTodos(req.userId, parsed.data);
      return { items: rows, nextCursor };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // GET /day/:date — top-level + has_subtasks (đặt trước /:id)
  app.get<{ Params: { date: string } }>("/day/:date", async (req, reply) => {
    if (!IsoDateRegex.test(req.params.date)) {
      return reply.code(400).send({ error: "bad_input" });
    }
    const items = await todos.listDayTopLevel(req.userId, req.params.date);
    return { items };
  });

  // GET /:id
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    try {
      const detail = await todos.getTodoDetail(req.userId, req.params.id);
      return detail;
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // PATCH /:id
  app.patch<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const parsed = UpdateTodoSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const todo = await todos.updateTodo(req.userId, req.params.id, parsed.data);
      return { todo };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // DELETE /:id
  app.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const parsed = DeleteTodoQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      await todos.deleteTodo(req.userId, req.params.id, parsed.data.scope);
      return reply.code(204).send();
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // POST /:id/complete
  app.post<{ Params: { id: string } }>("/:id/complete", async (req, reply) => {
    const parsed = CompleteTodoSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const result = await todos.completeTodo(
        req.userId,
        req.params.id,
        parsed.data
      );
      return result;
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // POST /:id/uncomplete
  app.post<{ Params: { id: string } }>("/:id/uncomplete", async (req, reply) => {
    try {
      const todo = await todos.uncompleteTodo(req.userId, req.params.id);
      return { todo };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // POST /:id/frog
  app.post<{ Params: { id: string } }>("/:id/frog", async (req, reply) => {
    const parsed = ToggleFrogSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const todo = await todos.markFrog(req.userId, req.params.id, parsed.data);
      return { todo };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // DELETE /:id/frog
  app.delete<{ Params: { id: string } }>("/:id/frog", async (req, reply) => {
    try {
      const todo = await todos.unmarkFrog(req.userId, req.params.id);
      return { todo };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // POST /:id/classify
  app.post<{ Params: { id: string } }>("/:id/classify", async (req, reply) => {
    const parsed = ClassifyEisenhowerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const todo = await todos.classifyEisenhower(
        req.userId,
        req.params.id,
        parsed.data
      );
      return { todo };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // POST /:id/move-to-day
  app.post<{ Params: { id: string } }>("/:id/move-to-day", async (req, reply) => {
    const parsed = MoveToDaySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const todo = await todos.moveToDay(req.userId, req.params.id, parsed.data);
      return { todo };
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // POST /:id/tags
  app.post<{ Params: { id: string } }>("/:id/tags", async (req, reply) => {
    const parsed = AttachTagSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      const tag = await todos.attachTag(req.userId, req.params.id, parsed.data);
      return reply.code(201).send({ tag });
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // PUT /:id/tags
  app.put<{ Params: { id: string } }>("/:id/tags", async (req, reply) => {
    const parsed = ReplaceTodoTagsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      return await todos.replaceTags(req.userId, req.params.id, parsed.data);
    } catch (e) {
      return mapErr(e, reply);
    }
  });

  // DELETE /:id/tags/:tagId
  app.delete<{ Params: { id: string; tagId: string } }>(
    "/:id/tags/:tagId",
    async (req, reply) => {
      try {
        await todos.detachTag(req.userId, req.params.id, req.params.tagId);
        return reply.code(204).send();
      } catch (e) {
        return mapErr(e, reply);
      }
    }
  );

  // PUT /:id/timer — báo trạng thái đếm ngược để server hẹn thông báo hết giờ
  app.put<{ Params: { id: string } }>("/:id/timer", async (req, reply) => {
    const parsed = TodoTimerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bad_input", issues: parsed.error.issues });
    }
    try {
      return await applyTimerEvent(req.userId, req.params.id, parsed.data);
    } catch (e) {
      if (e instanceof TimerServiceError) {
        if (e.code === "not_found") return reply.code(404).send({ error: "not_found" });
        if (e.code === "device_not_found")
          return reply.code(404).send({ error: "device_not_found" });
        if (e.code === "todo_completed")
          return reply.code(409).send({ error: "todo_completed" });
      }
      throw e;
    }
  });

  // GET /:id/subtasks
  app.get<{ Params: { id: string } }>("/:id/subtasks", async (req, reply) => {
    try {
      const items = await todos.listSubtasks(req.userId, req.params.id);
      return { items };
    } catch (e) {
      return mapErr(e, reply);
    }
  });
}

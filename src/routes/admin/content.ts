import type { FastifyInstance } from "fastify";
import * as content from "../../services/content.js";
import { getUserById } from "../../services/users.js";
import { consumeFlash, setFlash } from "../../utils/flash.js";

export default async function contentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.requireAdmin);

  // GET /admin/users/:id/content
  app.get<{ Params: { id: string } }>("/users/:id/content", async (req, reply) => {
    const user = await getUserById(req.params.id);
    if (!user) {
      setFlash(reply, "error", "Không tìm thấy user.");
      return reply.redirect("/admin/users");
    }
    const { todos, notes } = await content.getUserContent(user.id);
    return reply.view(
      "admin/content/user.ejs",
      {
        title: `Content · ${user.email}`,
        active: "users",
        user,
        todos,
        notes,
        flash: consumeFlash(req, reply),
      },
      { layout: "layouts/admin.ejs" }
    );
  });

  // POST /admin/todos/:id/delete
  app.post<{ Params: { id: string } }>("/todos/:id/delete", async (req, reply) => {
    const todo = await content.getTodoById(req.params.id);
    if (!todo) {
      setFlash(reply, "error", "Không tìm thấy todo.");
      return reply.redirect("/admin/users");
    }
    await content.deleteTodo(todo.id);
    setFlash(reply, "success", "Đã xóa (soft-delete) todo.");
    return reply.redirect(`/admin/users/${todo.user_id}/content`);
  });

  // POST /admin/notes/:id/delete
  app.post<{ Params: { id: string } }>("/notes/:id/delete", async (req, reply) => {
    const note = await content.getNoteById(req.params.id);
    if (!note) {
      setFlash(reply, "error", "Không tìm thấy note.");
      return reply.redirect("/admin/users");
    }
    await content.deleteNote(note.id);
    setFlash(reply, "success", "Đã xóa (soft-delete) note.");
    return reply.redirect(`/admin/users/${note.user_id}/content`);
  });
}

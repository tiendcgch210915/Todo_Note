import { turso } from "../config/db.js";
import type { NoteRow } from "./notes.js";
import type { TodoRow } from "./todos.js";

type AdminTodo = Pick<TodoRow, "id" | "title" | "status" | "is_frog" | "due_at" | "created_at" | "deleted_at">;
type AdminNote = Pick<NoteRow, "id" | "title" | "type" | "is_pinned" | "created_at" | "deleted_at">;

export const getUserContent = async (userId: string, limit = 200) => {
  const [todos, notes] = await turso.batch([
    {
      sql: `SELECT id, title, status, is_frog, due_at, created_at, deleted_at FROM todos
            WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`,
      args: [userId, limit],
    },
    {
      sql: `SELECT id, title, type, is_pinned, created_at, deleted_at FROM notes
            WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?`,
      args: [userId, limit],
    },
  ], "read");
  return {
    todos: todos.rows as unknown as AdminTodo[],
    notes: notes.rows as unknown as AdminNote[],
  };
};

import * as todosRepo from "../repositories/todos.js";
import * as notesRepo from "../repositories/notes.js";
import * as notificationTriggers from "./notification-triggers.js";

export const listTodosByUser = todosRepo.listTodosByUser;
export const getTodoById = todosRepo.getTodoById;
// Admin soft-delete goes straight to the repository, so cancel its reminder/timer jobs here.
export const deleteTodo = async (id: string): Promise<boolean> => {
  const todo = await todosRepo.getTodoById(id);
  const deleted = await todosRepo.softDeleteTodo(id);
  if (deleted && todo) {
    await notificationTriggers.onTodosRemoved(todo.user_id, [id]);
  }
  return deleted;
};

// Admin view: trả flat list (không cursor) — phục vụ trang user detail
export const listNotesByUser = async (
  userId: string,
  limit = 200
): Promise<notesRepo.NoteRow[]> => {
  const res = await notesRepo.listNotesByUser(userId, { limit });
  return res.rows;
};

export const getNoteById = notesRepo.getNoteById;
export const deleteNote = (id: string): Promise<boolean> =>
  notesRepo.softDeleteNote(id);

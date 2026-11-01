import * as todosRepo from "../repositories/todos.js";
import * as notesRepo from "../repositories/notes.js";
import * as notificationTriggers from "./notification-triggers.js";

export { getUserContent } from "../repositories/admin-content.js";
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

export const getNoteById = notesRepo.getNoteById;
export const deleteNote = (id: string): Promise<boolean> =>
  notesRepo.softDeleteNote(id);

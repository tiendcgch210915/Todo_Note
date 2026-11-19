-- Only a series with a scoped reminder edit needs a separate default.
-- A present row with a NULL time means the series has no reminder.
CREATE TABLE todo_series_reminder_times (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  time TEXT,
  PRIMARY KEY (user_id, series_id)
);

-- Both REST completion and offline sync can materialize a successor. An older
-- client may have copied today's effective time when it created that row.
CREATE TRIGGER todo_inherit_series_time AFTER INSERT ON todos
WHEN NEW.recurrence_template_id IS NOT NULL AND NEW.parent_id IS NULL
  AND NEW.scheduled_date IS NOT NULL AND NEW.deleted_at IS NULL
  AND NEW.status != 'done'
BEGIN
  UPDATE todos SET time = s.time
  FROM todo_series_reminder_times s
  WHERE todos.id = NEW.id AND s.user_id = NEW.user_id
    AND s.series_id = NEW.recurrence_template_id AND todos.time IS NOT s.time;
END;

-- A one-day edit expires when the row is reused for a different day, e.g.
-- when a parked successor is revived or a recurrence rule moves its date.
CREATE TRIGGER todo_restore_series_time AFTER UPDATE OF scheduled_date ON todos
WHEN NEW.scheduled_date IS NOT NULL AND NEW.scheduled_date IS NOT OLD.scheduled_date
  AND NEW.parent_id IS NULL AND NEW.time IS OLD.time AND NEW.deleted_at IS NULL
  AND (NEW.recurrence_type IS NOT NULL OR NEW.recurrence_template_id IS NOT NULL)
BEGIN
  UPDATE todos SET time = s.time
  FROM todo_series_reminder_times s
  WHERE todos.id = NEW.id AND s.user_id = NEW.user_id
    AND s.series_id = COALESCE(NEW.recurrence_template_id, NEW.id)
    AND todos.time IS NOT s.time;
END;

-- Restarting recurrence on a former series root starts from its current time.
CREATE TRIGGER todo_restart_series_time AFTER UPDATE OF recurrence_type ON todos
WHEN OLD.recurrence_type IS NULL AND NEW.recurrence_type IS NOT NULL
  AND NEW.recurrence_template_id IS NULL AND NEW.parent_id IS NULL
BEGIN
  UPDATE todo_series_reminder_times SET time = NEW.time
  WHERE user_id = NEW.user_id AND series_id = NEW.id;
END;

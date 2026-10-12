-- Migration 0019: Close habit days at local midnight
--
-- When a user's local day ends and a habit has no live log for it, the backend
-- writes an explicit habit_logs row with completed = 0.
--
--   habit_logs.auto_closed   1 = row written by that job and not touched by any
--                            real write since. A real write (manual log, linked
--                            todo/checklist auto-log, client sync push) resets it
--                            to 0. Sync uses it to let a pushed client log win over
--                            the job's row (e.g. ticked offline at 23:50, pushed
--                            after midnight). Server-only: never part of the sync
--                            payload.
--
--   habit_close_cursors      Per user, the last local date that has already been
--                            filled, so each tick only does work when a user's
--                            local day has actually rolled over.

ALTER TABLE habit_logs ADD COLUMN auto_closed INTEGER NOT NULL DEFAULT 0
  CHECK (auto_closed IN (0, 1));

CREATE TABLE habit_close_cursors (
  user_id TEXT PRIMARY KEY,
  closed_through TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

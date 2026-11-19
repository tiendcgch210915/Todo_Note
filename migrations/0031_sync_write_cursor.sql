-- Server-side write cursor for GET /sync/changes (delta pull).
--
-- The delta used to be `updated_at > since`. `updated_at` is stamped by the WRITING client (it is also
-- the Last-Write-Wins clock), so an edit made offline and pushed after another device's last pull is older
-- than that device's cursor and never reaches it. `sync_stamps.synced_at` is stamped by the DATABASE clock
-- when a row is written, by the triggers below, so every write path (sync push, REST, admin, jobs) is covered.
-- `updated_at` keeps its LWW meaning and is not touched.
--
-- Additive: no existing table changes, older code ignores the table, so this can be applied before the code
-- that reads it. Rollback: drop the triggers (sync_stamp_*) and the table.
--
-- Existing rows are backfilled with their `updated_at` (a row with no timestamp gets '' and never matches
-- a cursor), so the first deltas after the migration return what they returned before.

CREATE TABLE sync_stamps (
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  synced_at   TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
) WITHOUT ROWID;

CREATE INDEX idx_sync_stamps_cursor ON sync_stamps (entity_type, synced_at);

-- users
INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
SELECT 'users', id, COALESCE(updated_at, created_at, '') FROM users;

CREATE TRIGGER sync_stamp_users_ins AFTER INSERT ON users
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('users', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

CREATE TRIGGER sync_stamp_users_upd AFTER UPDATE ON users
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('users', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

-- tags
INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
SELECT 'tags', id, COALESCE(updated_at, created_at, '') FROM tags;

CREATE TRIGGER sync_stamp_tags_ins AFTER INSERT ON tags
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('tags', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

CREATE TRIGGER sync_stamp_tags_upd AFTER UPDATE ON tags
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('tags', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

-- todos
INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
SELECT 'todos', id, COALESCE(updated_at, created_at, '') FROM todos;

CREATE TRIGGER sync_stamp_todos_ins AFTER INSERT ON todos
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('todos', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

CREATE TRIGGER sync_stamp_todos_upd AFTER UPDATE ON todos
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('todos', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

-- notes
INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
SELECT 'notes', id, COALESCE(updated_at, created_at, '') FROM notes;

CREATE TRIGGER sync_stamp_notes_ins AFTER INSERT ON notes
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('notes', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

CREATE TRIGGER sync_stamp_notes_upd AFTER UPDATE ON notes
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('notes', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

-- habits
INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
SELECT 'habits', id, COALESCE(updated_at, created_at, '') FROM habits;

CREATE TRIGGER sync_stamp_habits_ins AFTER INSERT ON habits
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('habits', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

CREATE TRIGGER sync_stamp_habits_upd AFTER UPDATE ON habits
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('habits', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

-- habit_logs
INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
SELECT 'habit_logs', id, COALESCE(updated_at, created_at, '') FROM habit_logs;

CREATE TRIGGER sync_stamp_habit_logs_ins AFTER INSERT ON habit_logs
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('habit_logs', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

CREATE TRIGGER sync_stamp_habit_logs_upd AFTER UPDATE ON habit_logs
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('habit_logs', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

-- checklist_categories
INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
SELECT 'checklist_categories', id, COALESCE(updated_at, created_at, '') FROM checklist_categories;

CREATE TRIGGER sync_stamp_checklist_categories_ins AFTER INSERT ON checklist_categories
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_categories', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

CREATE TRIGGER sync_stamp_checklist_categories_upd AFTER UPDATE ON checklist_categories
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_categories', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

-- checklist_templates
INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
SELECT 'checklist_templates', id, COALESCE(updated_at, created_at, '') FROM checklist_templates;

CREATE TRIGGER sync_stamp_checklist_templates_ins AFTER INSERT ON checklist_templates
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_templates', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

CREATE TRIGGER sync_stamp_checklist_templates_upd AFTER UPDATE ON checklist_templates
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_templates', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

-- checklist_template_orders
INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
SELECT 'checklist_template_orders', id, COALESCE(updated_at, created_at, '') FROM checklist_template_orders;

CREATE TRIGGER sync_stamp_checklist_template_orders_ins AFTER INSERT ON checklist_template_orders
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_template_orders', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

CREATE TRIGGER sync_stamp_checklist_template_orders_upd AFTER UPDATE ON checklist_template_orders
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_template_orders', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

-- checklist_template_items
INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
SELECT 'checklist_template_items', id, COALESCE(updated_at, created_at, '') FROM checklist_template_items;

CREATE TRIGGER sync_stamp_checklist_template_items_ins AFTER INSERT ON checklist_template_items
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_template_items', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

CREATE TRIGGER sync_stamp_checklist_template_items_upd AFTER UPDATE ON checklist_template_items
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_template_items', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

-- checklist_runs
INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
SELECT 'checklist_runs', id, COALESCE(updated_at, created_at, '') FROM checklist_runs;

CREATE TRIGGER sync_stamp_checklist_runs_ins AFTER INSERT ON checklist_runs
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_runs', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

CREATE TRIGGER sync_stamp_checklist_runs_upd AFTER UPDATE ON checklist_runs
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_runs', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

-- checklist_run_items
INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
SELECT 'checklist_run_items', id, COALESCE(updated_at, created_at, '') FROM checklist_run_items;

CREATE TRIGGER sync_stamp_checklist_run_items_ins AFTER INSERT ON checklist_run_items
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_run_items', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

CREATE TRIGGER sync_stamp_checklist_run_items_upd AFTER UPDATE ON checklist_run_items
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_run_items', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

-- checklist_schedules
INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
SELECT 'checklist_schedules', id, COALESCE(updated_at, created_at, '') FROM checklist_schedules;

CREATE TRIGGER sync_stamp_checklist_schedules_ins AFTER INSERT ON checklist_schedules
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_schedules', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

CREATE TRIGGER sync_stamp_checklist_schedules_upd AFTER UPDATE ON checklist_schedules
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_schedules', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

-- checklist_schedule_overrides
INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
SELECT 'checklist_schedule_overrides', id, COALESCE(updated_at, created_at, '') FROM checklist_schedule_overrides;

CREATE TRIGGER sync_stamp_checklist_schedule_overrides_ins AFTER INSERT ON checklist_schedule_overrides
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_schedule_overrides', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

CREATE TRIGGER sync_stamp_checklist_schedule_overrides_upd AFTER UPDATE ON checklist_schedule_overrides
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_schedule_overrides', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

-- checklist_occurrence_marks
INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
SELECT 'checklist_occurrence_marks', id, COALESCE(updated_at, created_at, '') FROM checklist_occurrence_marks;

CREATE TRIGGER sync_stamp_checklist_occurrence_marks_ins AFTER INSERT ON checklist_occurrence_marks
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_occurrence_marks', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

CREATE TRIGGER sync_stamp_checklist_occurrence_marks_upd AFTER UPDATE ON checklist_occurrence_marks
BEGIN
  INSERT INTO sync_stamps (entity_type, entity_id, synced_at)
  VALUES ('checklist_occurrence_marks', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET synced_at = excluded.synced_at;
END;

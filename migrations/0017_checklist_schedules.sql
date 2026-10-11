-- ============================================================
-- Migration 0017: checklist schedules + checklist_due notification kind
-- Database: Turso (libSQL / SQLite)
-- ============================================================
-- checklist_schedules           : lịch lặp của MỘT checklist cho MỘT người dùng (tối đa một lịch).
--                                 Theo người dùng chứ không nằm trên checklist_templates vì mẫu hệ
--                                 thống dùng chung và người dùng không sửa được; cùng kiểu với
--                                 checklist_template_orders. Tên trường lặp giống hệt todo.
-- checklist_schedule_overrides  : đổi giờ của MỘT ngày cụ thể trong lịch.
-- notification_jobs             : thêm kind 'checklist_due'. CHECK(kind) không sửa được tại chỗ
--                                 trong SQLite nên dựng lại bảng; dữ liệu và chỉ mục được giữ nguyên.
--
-- Cả hai bảng lịch dùng UNIQUE không điều kiện (kể cả dòng đã xóa mềm) để khi tạo lại lịch thì
-- hồi sinh đúng dòng cũ, giống checklist_template_orders.

CREATE TABLE checklist_schedules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  time TEXT NOT NULL,
  recurrence_type TEXT CHECK (recurrence_type IS NULL OR recurrence_type IN ('daily', 'weekly', 'custom')),
  recurrence_interval INTEGER,
  recurrence_days_of_week TEXT,
  recurrence_end_date TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(user_id, template_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE CASCADE
);

CREATE INDEX idx_checklist_schedules_sync
  ON checklist_schedules(user_id, updated_at);

CREATE TABLE checklist_schedule_overrides (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  time TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(user_id, template_id, local_date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE CASCADE
);

CREATE INDEX idx_checklist_schedule_overrides_sync
  ON checklist_schedule_overrides(user_id, updated_at);

-- "Đã xong" của một lần xuất hiện = có run hoàn thành trong ngày địa phương đó.
CREATE INDEX idx_checklist_runs_user_completed
  ON checklist_runs(user_id, completed_at)
  WHERE status = 'completed' AND deleted_at IS NULL;

-- ── notification_jobs: thêm kind 'checklist_due' ───────────────────────────────
CREATE TABLE notification_jobs_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'todo_reminder', 'todo_timer_end', 'checklist_30m', 'checklist_due',
    'digest_morning', 'digest_todos', 'digest_habits'
  )),
  ref_id TEXT,
  target_device_id TEXT,
  local_date TEXT,
  run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'sent', 'cancelled', 'missed', 'failed'
  )),
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO notification_jobs_new
  (id, user_id, kind, ref_id, target_device_id, local_date, run_at,
   status, attempts, locked_at, sent_at, created_at)
SELECT
  id, user_id, kind, ref_id, target_device_id, local_date, run_at,
  status, attempts, locked_at, sent_at, created_at
FROM notification_jobs;

DROP TABLE notification_jobs;

ALTER TABLE notification_jobs_new RENAME TO notification_jobs;

CREATE UNIQUE INDEX uq_notification_jobs_ref
  ON notification_jobs(user_id, kind, ref_id)
  WHERE kind IN ('todo_reminder', 'todo_timer_end', 'checklist_30m');

CREATE UNIQUE INDEX uq_notification_jobs_digest
  ON notification_jobs(user_id, kind, local_date)
  WHERE kind IN ('digest_morning', 'digest_todos', 'digest_habits');

-- Mỗi checklist có thể có một job cho MỖI ngày địa phương.
CREATE UNIQUE INDEX uq_notification_jobs_occurrence
  ON notification_jobs(user_id, kind, ref_id, local_date)
  WHERE kind IN ('checklist_due');

CREATE INDEX idx_notification_jobs_due ON notification_jobs(status, run_at);
CREATE INDEX idx_notification_jobs_ref ON notification_jobs(ref_id);
CREATE INDEX idx_notification_jobs_target ON notification_jobs(target_device_id);

-- ============================================================
-- Migration 0027: nhắc LẠI ngay sau nhắc đúng giờ của todo (+2 phút, +4 phút)
-- Database: Turso (libSQL / SQLite)
-- ============================================================
-- notification_jobs.kind : thêm 'todo_reminder_repeat'
--
-- Mỗi lần nhắc lại là MỘT dòng job riêng, duy nhất theo (user, kind, ref_id, run_at) như các loại
-- "mỗi mốc một dòng" khác: chỉ mục uq_notification_jobs_slot được mở rộng thêm loại mới.
--
-- SQLite không sửa được CHECK tại chỗ nên dựng lại notification_jobs (cùng cách migration 0018/0020/0022).
-- Cột card_key (migration 0026) được giữ nguyên cùng dữ liệu; mọi chỉ mục của migration 0022 được dựng
-- lại nguyên vẹn, chỉ chỉ mục slot có thêm loại mới.

CREATE TABLE notification_jobs_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'todo_reminder', 'todo_timer_end', 'checklist_30m', 'checklist_due',
    'todo_overdue', 'checklist_overdue', 'checklist_running', 'todo_reminder_repeat',
    'digest_morning', 'digest_todos', 'digest_habits', 'digest_review',
    'digest_overdue_evening', 'digest_overdue_morning'
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
  card_key TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO notification_jobs_new
  (id, user_id, kind, ref_id, target_device_id, local_date, run_at,
   status, attempts, locked_at, sent_at, created_at, card_key)
SELECT
  id, user_id, kind, ref_id, target_device_id, local_date, run_at,
  status, attempts, locked_at, sent_at, created_at, card_key
FROM notification_jobs;

DROP TABLE notification_jobs;

ALTER TABLE notification_jobs_new RENAME TO notification_jobs;

CREATE UNIQUE INDEX uq_notification_jobs_ref
  ON notification_jobs(user_id, kind, ref_id)
  WHERE kind IN ('todo_reminder', 'todo_timer_end', 'checklist_30m');

CREATE UNIQUE INDEX uq_notification_jobs_digest
  ON notification_jobs(user_id, kind, local_date)
  WHERE kind IN (
    'digest_morning', 'digest_todos', 'digest_habits', 'digest_review',
    'digest_overdue_evening', 'digest_overdue_morning'
  );

CREATE UNIQUE INDEX uq_notification_jobs_occurrence
  ON notification_jobs(user_id, kind, ref_id, local_date)
  WHERE kind IN ('checklist_due');

CREATE UNIQUE INDEX uq_notification_jobs_slot
  ON notification_jobs(user_id, kind, ref_id, run_at)
  WHERE kind IN ('todo_overdue', 'checklist_overdue', 'checklist_running', 'todo_reminder_repeat');

CREATE INDEX idx_notification_jobs_due ON notification_jobs(status, run_at);
CREATE INDEX idx_notification_jobs_ref ON notification_jobs(ref_id);
CREATE INDEX idx_notification_jobs_target ON notification_jobs(target_device_id);

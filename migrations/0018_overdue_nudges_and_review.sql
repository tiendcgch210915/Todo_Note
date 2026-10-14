-- ============================================================
-- Migration 0018: nhắc lặp mỗi 2 giờ khi bỏ lỡ + thông báo rà soát cuối ngày
-- Database: Turso (libSQL / SQLite)
-- ============================================================
-- notification_settings.review_time : giờ gửi thông báo rà soát cuối ngày (mặc định 21:30)
-- notification_jobs.kind            : thêm 'todo_overdue', 'checklist_overdue', 'digest_review'
--
-- SQLite không sửa được CHECK tại chỗ nên dựng lại notification_jobs (cùng cách migration 0017).
-- Job nhắc lặp có NHIỀU dòng cho cùng một todo/checklist trong một ngày (mỗi mốc +2h một dòng),
-- nên unique theo (user, kind, ref_id, run_at) thay vì theo ngày.

ALTER TABLE notification_settings ADD COLUMN review_time TEXT NOT NULL DEFAULT '21:30';

CREATE TABLE notification_jobs_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'todo_reminder', 'todo_timer_end', 'checklist_30m', 'checklist_due',
    'todo_overdue', 'checklist_overdue',
    'digest_morning', 'digest_todos', 'digest_habits', 'digest_review'
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
  WHERE kind IN ('digest_morning', 'digest_todos', 'digest_habits', 'digest_review');

CREATE UNIQUE INDEX uq_notification_jobs_occurrence
  ON notification_jobs(user_id, kind, ref_id, local_date)
  WHERE kind IN ('checklist_due');

-- Mỗi mốc nhắc lặp (giờ hẹn + 2h, +4h, ...) là một dòng riêng, nhận diện bằng run_at.
CREATE UNIQUE INDEX uq_notification_jobs_slot
  ON notification_jobs(user_id, kind, ref_id, run_at)
  WHERE kind IN ('todo_overdue', 'checklist_overdue');

CREATE INDEX idx_notification_jobs_due ON notification_jobs(status, run_at);
CREATE INDEX idx_notification_jobs_ref ON notification_jobs(ref_id);
CREATE INDEX idx_notification_jobs_target ON notification_jobs(target_device_id);

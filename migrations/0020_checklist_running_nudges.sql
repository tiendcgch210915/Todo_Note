-- ============================================================
-- Migration 0020: nhắc checklist đang làm dở mỗi 1 giờ
-- Database: Turso (libSQL / SQLite)
-- ============================================================
-- notification_jobs.kind : thêm 'checklist_running'
--
-- Thay thế job 'checklist_30m' (một lần, sau 30 phút). Mỗi run đang chạy có NHIỀU dòng: một dòng
-- cho mỗi mốc (bắt đầu +1h, +2h, ... trong cùng ngày địa phương) và một dòng nhắc lúc 06:00 sáng
-- hôm sau. Vì vậy unique theo (user, kind, ref_id, run_at) như các nhắc lặp quá giờ.
--
-- SQLite không sửa được CHECK tại chỗ nên dựng lại notification_jobs (cùng cách migration 0018).
-- 'checklist_30m' vẫn được phép trong CHECK để các dòng cũ không bị mất; code không tạo thêm.

CREATE TABLE notification_jobs_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'todo_reminder', 'todo_timer_end', 'checklist_30m', 'checklist_due',
    'todo_overdue', 'checklist_overdue', 'checklist_running',
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

-- Mỗi mốc là một dòng riêng, nhận diện bằng run_at (nhắc lặp quá giờ + nhắc checklist đang làm dở).
CREATE UNIQUE INDEX uq_notification_jobs_slot
  ON notification_jobs(user_id, kind, ref_id, run_at)
  WHERE kind IN ('todo_overdue', 'checklist_overdue', 'checklist_running');

CREATE INDEX idx_notification_jobs_due ON notification_jobs(status, run_at);
CREATE INDEX idx_notification_jobs_ref ON notification_jobs(ref_id);
CREATE INDEX idx_notification_jobs_target ON notification_jobs(target_device_id);

-- Bước vá chạy mỗi phút tìm các run đang chạy chưa có mốc nhắc; chỉ mục một phần (chỉ run đang
-- chạy, rất ít dòng) giúp nó không phải quét cả bảng checklist_runs.
CREATE INDEX idx_checklist_runs_running
  ON checklist_runs(started_at)
  WHERE status = 'in_progress' AND deleted_at IS NULL;

-- Nhắc 30 phút kiểu cũ đang chờ thì hủy: từ nay chỉ còn nhắc mỗi giờ (checklist_running).
UPDATE notification_jobs
SET status = 'cancelled'
WHERE kind = 'checklist_30m' AND status IN ('pending', 'processing');

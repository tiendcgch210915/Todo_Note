-- ============================================================
-- Migration 0022: tổng kết todo quan trọng quá hạn + nhịp nhắc lặp theo nhóm
-- Database: Turso (libSQL / SQLite)
-- ============================================================
-- notification_jobs.kind : thêm 'digest_overdue_evening' (17:00 cùng ngày) và
--                          'digest_overdue_morning' (07:00 sáng hôm sau)
--
-- Hai loại này là tổng kết CHO CẢ NGƯỜI DÙNG (đếm todo "quan trọng & không khẩn cấp" quá hạn), nên
-- duy nhất theo (user, kind, local_date) như các tổng kết khác: chỉ mục digest được mở rộng.
--
-- SQLite không sửa được CHECK tại chỗ nên dựng lại notification_jobs (cùng cách migration 0018/0020).
-- Mọi chỉ mục của migration 0020 được dựng lại nguyên vẹn, chỉ chỉ mục digest có thêm hai loại mới.

CREATE TABLE notification_jobs_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'todo_reminder', 'todo_timer_end', 'checklist_30m', 'checklist_due',
    'todo_overdue', 'checklist_overdue', 'checklist_running',
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
  WHERE kind IN (
    'digest_morning', 'digest_todos', 'digest_habits', 'digest_review',
    'digest_overdue_evening', 'digest_overdue_morning'
  );

CREATE UNIQUE INDEX uq_notification_jobs_occurrence
  ON notification_jobs(user_id, kind, ref_id, local_date)
  WHERE kind IN ('checklist_due');

CREATE UNIQUE INDEX uq_notification_jobs_slot
  ON notification_jobs(user_id, kind, ref_id, run_at)
  WHERE kind IN ('todo_overdue', 'checklist_overdue', 'checklist_running');

CREATE INDEX idx_notification_jobs_due ON notification_jobs(status, run_at);
CREATE INDEX idx_notification_jobs_ref ON notification_jobs(ref_id);
CREATE INDEX idx_notification_jobs_target ON notification_jobs(target_device_id);

-- Nhịp nhắc lặp của todo đổi theo nhóm quan trọng/khẩn cấp (quan trọng & khẩn cấp: mỗi 1 giờ;
-- quan trọng & không khẩn cấp: không nhắc từng todo nữa). Các mốc 2 giờ đang chờ được xóa để bước
-- vá của server tạo lại đúng nhịp mới. Todo đã có mốc ĐÃ GỬI trong ngày đó thì giữ nguyên phần
-- còn lại (tick tự bỏ mốc không còn hợp lệ trước khi gửi).
DELETE FROM notification_jobs
WHERE kind = 'todo_overdue'
  AND status = 'pending'
  AND NOT EXISTS (
    SELECT 1 FROM notification_jobs sent
    WHERE sent.user_id = notification_jobs.user_id
      AND sent.kind = 'todo_overdue'
      AND sent.ref_id = notification_jobs.ref_id
      AND sent.local_date = notification_jobs.local_date
      AND sent.status <> 'pending'
  );

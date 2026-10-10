-- ============================================================
-- Migration 0016: server-side notification scheduling
-- Database: Turso (libSQL / SQLite)
-- ============================================================
-- notification_settings : giờ nhận tổng kết của từng người dùng (timezone nằm ở users.timezone)
-- notification_jobs     : hàng đợi thông báo (một dòng = một lần gửi dự kiến)
-- todo_timers           : trạng thái đếm ngược của todo, chỉ phục vụ thông báo hết giờ
--
-- target_device_id KHÔNG có khóa ngoại: ON DELETE SET NULL sẽ biến job nhắm một thiết bị
-- thành job "gửi mọi thiết bị". Khi thiết bị bị xóa, code hủy các job trỏ tới nó.

CREATE TABLE notification_settings (
  user_id TEXT PRIMARY KEY,
  morning_time TEXT NOT NULL DEFAULT '07:00',
  evening_time TEXT NOT NULL DEFAULT '17:00',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE notification_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'todo_reminder', 'todo_timer_end', 'checklist_30m',
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

-- Chống tạo trùng: mỗi todo / run chỉ có một job cho mỗi loại sự kiện ...
CREATE UNIQUE INDEX uq_notification_jobs_ref
  ON notification_jobs(user_id, kind, ref_id)
  WHERE kind IN ('todo_reminder', 'todo_timer_end', 'checklist_30m');

-- ... và mỗi người dùng chỉ có một tổng kết cho mỗi loại trong một ngày địa phương.
CREATE UNIQUE INDEX uq_notification_jobs_digest
  ON notification_jobs(user_id, kind, local_date)
  WHERE kind IN ('digest_morning', 'digest_todos', 'digest_habits');

CREATE INDEX idx_notification_jobs_due ON notification_jobs(status, run_at);
CREATE INDEX idx_notification_jobs_ref ON notification_jobs(ref_id);
CREATE INDEX idx_notification_jobs_target ON notification_jobs(target_device_id);

CREATE TABLE todo_timers (
  todo_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN (
    'idle', 'running', 'paused', 'finished'
  )),
  estimated_seconds INTEGER,
  remaining_seconds INTEGER,
  ends_at TEXT,
  device_id TEXT,
  last_client_event_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_todo_timers_user ON todo_timers(user_id);

-- ============================================================
-- Migration 0015: user_devices -> push registrations (FID | token)
-- ============================================================
-- Mở rộng user_devices (migration 0013) thay vì tạo bảng mới:
--   fcm_token    -> registration_id (FID hoặc registration token)
--   + kind       'fid' | 'token'
--   + platform   hiện chỉ 'android'
--   + last_seen_at  thời điểm app gần nhất gọi POST /devices (dùng để dọn thiết bị cũ)
-- Unique (user_id, registration_id) đã có sẵn từ 0013; SQLite tự đổi tên cột trong chỉ mục.
-- LƯU Ý: bản server cũ truy vấn cột fcm_token sẽ lỗi sau migration này -> deploy code cùng đợt.

ALTER TABLE user_devices RENAME COLUMN fcm_token TO registration_id;

ALTER TABLE user_devices
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'token'
  CHECK (kind IN ('fid', 'token'));

ALTER TABLE user_devices
  ADD COLUMN platform TEXT NOT NULL DEFAULT 'android'
  CHECK (platform IN ('android'));

ALTER TABLE user_devices
  ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

UPDATE user_devices SET last_seen_at = updated_at;

CREATE INDEX IF NOT EXISTS idx_user_devices_last_seen
  ON user_devices(last_seen_at);

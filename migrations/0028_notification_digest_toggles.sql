-- ============================================================
-- Migration 0028: bật/tắt từng thông báo tổng kết hằng ngày
-- Database: Turso (libSQL / SQLite)
-- ============================================================
-- notification_settings.morning_enabled : tổng kết buổi sáng (digest_morning, digest_overdue_morning)
-- notification_settings.evening_enabled : tổng kết buổi chiều (digest_todos, digest_habits, digest_overdue_evening)
-- notification_settings.review_enabled  : rà soát cuối ngày (digest_review)
--
-- Mặc định 1 (bật) nên người dùng hiện có vẫn nhận đủ như trước cho đến khi tự tắt.

ALTER TABLE notification_settings ADD COLUMN morning_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notification_settings ADD COLUMN evening_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notification_settings ADD COLUMN review_enabled INTEGER NOT NULL DEFAULT 1;

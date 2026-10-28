-- ============================================================
-- Migration 0024: bỏ nhắc LẶP quá giờ của checklist (checklist_overdue)
-- Database: Turso (libSQL / SQLite)
-- ============================================================
-- Checklist chỉ còn nhắc MỘT lần đúng giờ hẹn (checklist_due); không còn nhắc lặp giờ hẹn + 2h, +4h...
-- Code ngừng tạo job 'checklist_overdue'. Các mốc đang chờ trong DB thì hủy luôn ở đây (cùng cách
-- migration 0020 đã làm với 'checklist_30m').
--
-- KHÔNG đổi CHECK(kind) và chỉ mục uq_notification_jobs_slot: giá trị 'checklist_overdue' vẫn được
-- phép để các dòng cũ (đã gửi/đã hủy) không bị mất. Nếu migration này chưa kịp chạy, tick cũng hủy
-- mọi job 'checklist_overdue' còn sót khi nó đến hạn nên không có thông báo nào bị gửi ra.

UPDATE notification_jobs
SET status = 'cancelled'
WHERE kind = 'checklist_overdue' AND status IN ('pending', 'processing');

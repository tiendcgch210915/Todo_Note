-- ============================================================
-- Migration 0021: tạm dừng lịch checklist (paused_from .. paused_until)
-- Database: Turso (libSQL / SQLite)
-- ============================================================
-- Một khoảng ngày liên tục [paused_from, paused_until] (YYYY-MM-DD, địa phương, CẢ HAI ĐẦU đều tính)
-- trong đó lịch KHÔNG có lần xuất hiện nào: không nhắc, không nằm trong timeline. Hết paused_until
-- thì tự hiện lại, không cần job. Hai cột luôn cùng NULL hoặc cùng có giá trị (Zod chuẩn hóa); cả
-- hai NULL = không tạm dừng.
--
-- Cần cả paused_from (không chỉ paused_until): các ngày ĐÃ QUA trước lúc dừng vẫn phải còn trong
-- timeline. Thêm cột nullable nên các dòng cũ giữ nguyên nghĩa (không tạm dừng).

ALTER TABLE checklist_schedules ADD COLUMN paused_from TEXT;

ALTER TABLE checklist_schedules ADD COLUMN paused_until TEXT;

-- ============================================================
-- Migration 0023: đánh dấu tay "Đã xong / Chưa hoàn thành" cho MỘT ngày của checklist
-- Database: Turso (libSQL / SQLite)
-- ============================================================
-- checklist_occurrence_marks : người dùng giữ (long-press) một lần xuất hiện trong timeline để
--                              tick "Hoàn thành" ngay (không cần chạy từng bước) hoặc hạ "Đã xong"
--                              về "Chưa hoàn thành" (một checklist có thể làm 2 lần/ngày nên một
--                              lần chạy xong chưa chắc là xong cả ngày).
--                                status = 'done' : ngày đó xong, bất kể các lần chạy;
--                                status = 'open' : ngày đó chưa xong, trừ khi SAU thời điểm đánh dấu
--                                                  (updated_at) lại có một lần chạy hoàn thành.
--                              Không có dòng = tự động: có lần chạy hoàn thành (tính theo NGÀY BẮT
--                              ĐẦU của lần chạy) thì xong.
--
-- Theo người dùng + checklist + ngày địa phương, cùng kiểu checklist_schedule_overrides. UNIQUE không
-- điều kiện (kể cả dòng đã xóa mềm) để đánh dấu lại thì hồi sinh đúng dòng cũ.
--
-- Đồng thời "xong của ngày" chuyển từ completed_at sang started_at (checklist bắt đầu 23:30 và xong
-- 00:30 vẫn tính cho ngày bắt đầu) nên chỉ mục tra cứu theo ngày cũng chuyển sang started_at.

CREATE TABLE checklist_occurrence_marks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('done', 'open')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(user_id, template_id, local_date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE CASCADE
);

CREATE INDEX idx_checklist_occurrence_marks_sync
  ON checklist_occurrence_marks(user_id, updated_at);

CREATE INDEX idx_checklist_runs_user_started
  ON checklist_runs(user_id, started_at)
  WHERE status = 'completed' AND deleted_at IS NULL;

-- Không còn truy vấn nào lọc theo completed_at của run đã hoàn thành.
DROP INDEX IF EXISTS idx_checklist_runs_user_completed;

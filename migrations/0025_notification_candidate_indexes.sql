-- Maintenance walks upcoming timed todos across all users in date/id order.
-- The equality prefix lets SQLite choose this range scan over idx_todos_deleted
-- even on databases without ANALYZE statistics.
CREATE INDEX idx_todos_reminder_candidates ON todos(deleted_at, scheduled_date, id)
WHERE time IS NOT NULL AND parent_id IS NULL AND deleted_at IS NULL
  AND status IN ('open', 'in_progress');

-- Match listExpiryCandidates' effective end date and stable LIMIT ordering.
CREATE INDEX idx_checklist_schedules_expiry ON checklist_schedules(
  COALESCE(recurrence_end_date, CASE WHEN recurrence_type IS NULL THEN start_date END),
  user_id, template_id
) WHERE deleted_at IS NULL;

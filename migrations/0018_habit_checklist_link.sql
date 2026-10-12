-- Migration 0018: Link habits to checklists
--
-- A habit may point at one checklist template (the user's own or a shared system
-- template). The link lives on the habit, not on checklist_templates, because
-- system templates are shared by every user and users cannot edit them.
-- When a run of the linked template is completed, the backend writes a
-- completed habit log for the user's local day of the completion.
-- Deleting the template clears the link (done in application code so that
-- habits.updated_at is bumped and clients receive the change).

ALTER TABLE habits ADD COLUMN checklist_template_id TEXT
  REFERENCES checklist_templates(id) ON DELETE SET NULL;

CREATE INDEX idx_habits_checklist_template
  ON habits(checklist_template_id, user_id)
  WHERE checklist_template_id IS NOT NULL;

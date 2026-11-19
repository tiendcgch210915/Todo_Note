-- A live override can omit this local day's occurrence from the schedule.
ALTER TABLE checklist_schedule_overrides
  ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0, 1));

# Mobile Contract: Habit ↔ Checklist Link and Midnight Day Close

## Backend Summary

- API base: `/api/v1`.
- Habit now has nullable `checklist_template_id`.
- Relationship: one habit links to at most one checklist template (the user's own or a
  shared system template); many habits may link to the same template.
- When a run of the linked checklist is completed, the backend writes a habit log
  `completed=true` for the **user's local day** of the completion (`users.timezone`).
- When a user's local day ends and a habit has no log for it, the backend writes a habit log
  `completed=false` for that day. Missing logs are no longer the "not done" state for days that
  are over.

## Checklist Link

### REST

- `POST /habits` accepts optional `checklist_template_id: string | null` (uuid).
- `PATCH /habits/:id` accepts optional `checklist_template_id: string | null`.
  - Field absent keeps the existing link.
  - `null` clears the link.
  - Unknown, deleted or another user's template returns `400 { "error": "invalid_checklist" }`.
    System templates are accepted.
- Habit responses (list, detail, create, update) include `checklist_template_id`.

### Sync

- `/sync/changes` returns `habits[].checklist_template_id`.
- `/sync/push` accepts `checklist_template_id` on habit payloads.
  - Field absent preserves the stored link (older app builds that do not send it do not
    clear links).
  - `null` clears.
  - Invalid link returns operation error `invalid_checklist`; a non-string value returns
    `bad_input`.
- Push order: push a newly created checklist template before a habit that links to it.

### Auto Log Rules (checklist run completed)

- Runs only on the transition of a run to `completed`: `POST /checklists/runs/:id/complete`
  (first call only) or a sync push that moves a run to `completed`.
- Log date is the local date (user timezone) of the run's `completed_at`, so a run finished
  at 23:50 and pushed after midnight still counts for the day it was finished.
- Every live, non-archived habit linked to the run's template gets `completed=true` for that
  date. Existing log `note` is preserved. A log that was `completed=false` (including one
  written by the midnight job) is raised to `completed=true`.
- Backend recomputes habit streaks after the auto-log.
- Un-completing, abandoning or deleting a run later, and changing or clearing the link, do
  **not** change existing habit logs. Linking a checklist does not back-fill past runs.
- A habit linked to both todos and a checklist counts a day as completed when either way
  completes it: a late todo completion will not lower a day on which the checklist was done.
- Deleting the checklist template (REST, sync or admin for system templates) clears
  `checklist_template_id` on the habits that pointed at it and bumps their `updated_at`, so
  the cleared link arrives through the normal sync pull.

## Midnight Day Close

- For each user, once the user's local day ends (00:00 in `users.timezone`), every habit that is
  live, not archived, with `start_date <= day <= end_date (or no end_date)` and **no live log**
  for that day gets a log with `completed=false` and no note.
- A soft-deleted log for that day counts as "no log": it is revived as `completed=false`.
- An existing live log (done or not done, with or without a note) is never touched.
- Applies from deployment onward. Past days are not back-filled. If the server was down or
  asleep at midnight it catches up the most recent 7 days at the next run, the next
  `GET /sync/changes` or the next `GET` under `/habits`.
- Backend-written logs arrive through the standard `habit_logs` sync pull like any other log.
  They carry no special field: mobile does not need to distinguish them.
- A log pushed by the client for a day that the job already closed takes over the job's row:
  the push returns `status: "conflict"` with `server_version` (the canonical row id, now
  holding the client's `completed`/`note`), exactly like the existing "different id, same
  habit and date" case. Remap the local row to `server_version.id`.
- Streaks are not recomputed by the job; a `completed=false` row does not change them.

### Visible behavior changes

- `GET /habits/calendar` `by_date[date][habit_id]` now contains `0` for closed, unticked days
  where the entry used to be absent.
- `GET /habits/:id` `recent_logs` (last 30 logs) now spans consecutive days instead of the last
  30 logged days.
- `GET /habits/:id/logs` and sync pulls return the extra `completed=false` rows (about one row
  per active habit per day).
- `PATCH /habits/:id/logs/:log_date` now works on a closed day (it used to return `404` when no
  log existed).
- Dashboard, score, digests and streak numbers are unchanged: they already treated a missing log
  and `completed=false` identically.

## Verification

- `npm run build` passes.
- `npm test` passes (the single `sync-pull-retry` failure without a `.env` is unrelated).
- Migrations `0018_habit_checklist_link.sql` and `0019_habit_day_close.sql` apply successfully.
- `verify-sync-payload` confirms the habit sync payload includes `checklist_template_id`.

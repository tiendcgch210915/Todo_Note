# Mobile Contract: Recurring Todo Occurrences

## Backend Summary

- A series is the root todo (`recurrence_type != null`, `recurrence_template_id = null`) plus its real occurrences. Every occurrence keeps the root's `recurrence_type`, `recurrence_interval`, `recurrence_days_of_week` and `recurrence_end_date`, and sets `recurrence_template_id` to the root id.
- Mobile should show an occurrence's repeat rule from its own `recurrence_*` fields. "Follows the original schedule" is only correct for a legacy projection (`recurrence_type = null` with a `recurrence_template_id`).
- A series holds at most one live, top-level occurrence per `scheduled_date`.

## Completing and Undoing

- `POST /todos/:id/complete` creates the next occurrence once. If the slot is already taken it returns the existing row; it never adds a second one.
- Undoing a completion (`POST /todos/:id/uncomplete`, or an `update` back to `open`) **parks** the occurrence that completion generated: its `status` becomes `archived`. It is not deleted, because a soft-deleted occurrence is a recurrence exception and its date would be skipped.
- Only the occurrence directly after the reopened todo is parked, and only when it is still `open`. A next occurrence that is `done`, `in_progress`, moved to another date, or any occurrence further ahead is left alone.
- The next completion of the series reuses a parked occurrence: it becomes `open` again, and moves to the new next date if the schedule changed in between. Parked rows are `archived`, so lists, scores, dashboards and reminders already ignore them.
- If an open occurrence already exists after the completed todo (for example the user rescheduled it), completion returns that row instead of creating another.

## Sync Contract

- `/sync/push` with a `create` (or implicit create) of a todo whose `recurrence_type`, `recurrence_template_id` and `scheduled_date` are set, and which has no `parent_id`, returns `status: "conflict"` with `server_version` set to the live occurrence already holding that `(recurrence_template_id, scheduled_date)`. Mobile adopts it and drops its local duplicate. Retrying the same `create` id is `applied`.
- A refused occurrence's cloned subtree travels in the same batch (children, grandchildren, siblings whose `trigger_after_todo_id` points into it). Operations whose `parent_id` or `trigger_after_todo_id` is a todo refused earlier in the same batch are answered `status: "applied"` and are **not** written: inserting them would violate the `parent_id` foreign key and fail the whole request. Mobile has already purged that local subtree while handling the parent's `conflict`.
- Updates to rows that already exist on the server are never turned into conflicts by this rule.
- Parking and reviving are plain `update`s of `status` (and `scheduled_date`, `completed_at`); no new fields and no migration.

## Verification

- `npm run build` passes.
- `npm test` passes with 97 tests.

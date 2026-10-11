# Mobile Contract: Checklist Schedule and Due Reminders

## Backend Summary

- API base: `/api/v1`. All endpoints need the usual Bearer token.
- A checklist (`checklist_templates` row, including the shared system templates) can have **at most one schedule per user**: a start date, a time of day (`HH:mm`, the user's local time) and an optional repeat rule. The schedule belongs to the user, so scheduling a system checklist never edits the shared template.
- A single day can be moved to another time with a **per-day override**.
- The server pushes an FCM notification at the scheduled time (kind `checklist_due`) unless the checklist was already completed that local day.
- `GET /checklists/occurrences` is the single source of truth for "what is scheduled when". The reminder job uses the exact same function, so the list and the notification cannot disagree.
- Repeat vocabulary is the one todos use (`recurrence_type`, `recurrence_interval`, `recurrence_days_of_week`, `recurrence_end_date`).
- "Local" always means `users.timezone` (default `Asia/Ho_Chi_Minh`).

## Schedule Fields (snake_case, same names in REST and sync)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string (UUIDv7) | Server-generated over REST. Sync clients may choose it. |
| `template_id` | string | The checklist. One live schedule per `(user, template)`. |
| `start_date` | `YYYY-MM-DD` | **Always the first occurrence**, even when its weekday is not in `recurrence_days_of_week` (same as the root of a recurring todo). |
| `time` | `HH:mm` | Default time of every occurrence. |
| `recurrence_type` | `null` \| `daily` \| `weekly` \| `custom` | `null` = one single occurrence on `start_date`. |
| `recurrence_interval` | int 1..365 \| `null` | Days for `daily`/`custom`, weeks for `weekly`. |
| `recurrence_days_of_week` | `"1,3,5"` \| `null` | Mon=1 ... Sun=7. Only used by `weekly`. |
| `recurrence_end_date` | `YYYY-MM-DD` \| `null` | Inclusive. Must not be before `start_date`. |
| `enabled` | boolean | `false` keeps the schedule but stops occurrences and reminders. |
| `created_at`, `updated_at` | ISO UTC | |

Normalisation applied by the server (REST and sync alike):

- `recurrence_type = null` -> `recurrence_interval`, `recurrence_days_of_week`, `recurrence_end_date` are stored as `null`.
- `daily` / `custom` -> `recurrence_interval` defaults to 1; `recurrence_days_of_week` is stored as `null`.
- `weekly` -> `recurrence_interval` defaults to 1; weekdays are sorted and de-duplicated (`"5,1,3,1"` becomes `"1,3,5"`). No weekdays = repeat on the weekday of `start_date`.
- `enabled` defaults to `true`.

### How occurrences are expanded (mirror this if you compute offline)

- `no repeat`: only `start_date`.
- `daily` / `custom`: `start_date + n * interval` days.
- `weekly` without weekdays: `start_date + n * interval` weeks.
- `weekly` with weekdays: `start_date` first, then the next listed weekday in the same Monday-Sunday week; after the last listed weekday of a week, jump `interval` weeks to the first listed weekday.
- Stop after `recurrence_end_date` (inclusive). A schedule with `enabled = false` has no occurrences.

## REST Contract

### `GET /checklists/templates/:id`

Now returns `{ "template": {...}, "items": [...], "schedule": <schedule> | null }`.

### `PUT /checklists/templates/:id/schedule`

Creates or replaces the schedule (idempotent; a second PUT keeps the same `id`, a PUT after DELETE revives the same row).

```json
{
  "start_date": "2026-06-01",
  "time": "07:30",
  "recurrence_type": "weekly",
  "recurrence_interval": 1,
  "recurrence_days_of_week": "1,3,5",
  "recurrence_end_date": null,
  "enabled": true
}
```

`200`:

```json
{
  "schedule": {
    "id": "0192f3c0-...",
    "template_id": "0192f3b1-...",
    "start_date": "2026-06-01",
    "time": "07:30",
    "recurrence_type": "weekly",
    "recurrence_interval": 1,
    "recurrence_days_of_week": "1,3,5",
    "recurrence_end_date": null,
    "enabled": true,
    "created_at": "2026-06-01T00:00:00.000Z",
    "updated_at": "2026-06-01T00:00:00.000Z"
  }
}
```

A one-off reminder is just `{ "start_date": "2026-06-20", "time": "21:00" }` (omit `recurrence_type`).

### `GET /checklists/templates/:id/schedule`

`200 { "schedule": {...} }`, or `404 { "error": "not_found" }` when the checklist has no live schedule.

### `DELETE /checklists/templates/:id/schedule`

`204`. Idempotent (deleting a schedule that does not exist is also `204`). Its per-day overrides are removed with it, pending reminders are cancelled.

### `PUT /checklists/templates/:id/occurrences/:date`

Moves ONE day to another time. `:date` is `YYYY-MM-DD` and must be a real occurrence of an enabled schedule.

```json
{ "time": "21:15" }
```

`200`:

```json
{ "checklistId": "0192f3b1-...", "date": "2026-06-02", "time": "21:15", "overridden": true }
```

Errors: `404 not_found` (no checklist, not yours, or no schedule), `400 not_an_occurrence` (the date is not an occurrence, or the schedule is disabled), `400 bad_input`.

### `DELETE /checklists/templates/:id/occurrences/:date`

`204`. Idempotent. Restores the schedule's own time for that day.

### `GET /checklists/occurrences?from=YYYY-MM-DD&to=YYYY-MM-DD`

Occurrences of every enabled schedule of the user, both ends inclusive, **at most 62 days** (a longer range, `from > to` or a malformed date is `400 bad_input`). Sorted by `date`, then `time`, then `title`.

```json
{
  "items": [
    {
      "checklistId": "0192f3b1-...",
      "title": "Rời nhà",
      "stepCount": 3,
      "date": "2026-06-01",
      "time": "07:30",
      "overridden": false,
      "done": true
    }
  ]
}
```

- `stepCount`: live steps of the checklist.
- `overridden`: the time comes from a per-day override.
- `done`: the user finished (status `completed`) **at least one run of that checklist during that local day**. An abandoned or deleted run does not count; neither does another user's run.
- Deleted checklists, deleted schedules and disabled schedules are not listed. An override left behind for a day the schedule no longer covers is ignored.

### Errors

`401` without a token. `404 { "error": "not_found" }` for an unknown checklist or one that is not visible to the user (own or system). `400 { "error": "bad_input", "issues": [...] }` for validation (bad time, nonexistent date, interval outside 1..365, weekday outside 1..7, end date before start date, unknown `recurrence_type`).

## Sync Contract

Two new entity types, both per user and soft-deleted like the rest:

- `checklist_schedule` -> pull array `checklist_schedules`
- `checklist_schedule_override` -> pull array `checklist_schedule_overrides`

`checklist_schedule` fields are the table above plus `user_id` and `deleted_at` (pulled rows carry them like every synced row); `enabled` is a boolean on the wire.

`checklist_schedule_override` fields: `id`, `template_id`, `local_date` (`YYYY-MM-DD`), `time` (`HH:mm`), `created_at`, `updated_at`, `deleted_at`.

Push example:

```json
{
  "ops": [
    {
      "op": "create",
      "type": "checklist_schedule",
      "payload": {
        "id": "0192f3c0-...",
        "template_id": "0192f3b1-...",
        "start_date": "2026-06-01",
        "time": "07:30",
        "recurrence_type": "daily",
        "recurrence_interval": 1,
        "recurrence_days_of_week": null,
        "recurrence_end_date": null,
        "enabled": true,
        "created_at": "2026-06-01T00:00:00.000Z",
        "updated_at": "2026-06-01T00:00:00.000Z"
      }
    },
    {
      "op": "create",
      "type": "checklist_schedule_override",
      "payload": {
        "id": "0192f3c1-...",
        "template_id": "0192f3b1-...",
        "local_date": "2026-06-02",
        "time": "21:15",
        "created_at": "2026-06-01T00:00:00.000Z",
        "updated_at": "2026-06-01T00:00:00.000Z"
      }
    }
  ]
}
```

Rules:

- Validation is the REST validation. A bad payload returns that operation's `status: "error", error: "bad_input"`; nothing is written.
- Natural keys are merged in place: one schedule per `(user, template_id)` and one override per `(user, template_id, local_date)`. If the server already has a row for the key under a different `id`, the push updates **that** row (no `conflict` status). Pull afterwards and keep the server's `id`.
- Last-Write-Wins on `updated_at`: an older push is ignored. Deleting is an op `delete` with `{ id, updated_at, deleted_at }` and is idempotent.
- Deleting a schedule soft-deletes its overrides; deleting a checklist (REST or sync) soft-deletes its schedule and overrides. The tombstones arrive in the next pull with `since`.
- A schedule or override for a checklist the user cannot see (someone else's, or deleted) is acknowledged but not written, as `checklist_template_order` does. Push the checklist before its schedule in the same batch.
- Every accepted change cancels and recreates the affected reminder jobs on the server.

## Push Notification `checklist_due`

- Sent to **all** devices of the user at the occurrence time (the override time if any), unless the checklist was already completed that local day, the schedule was disabled/deleted/moved, or the checklist was deleted. The server re-checks all of this right before sending.
- A reminder that would be sent more than 30 minutes late is dropped, never sent. FCM `ttl` 1 hour, priority `high`.
- Android channel id: `checklist_reminders` (the app must create it; `checklist_30m` already uses it).
- `notification.title`: the checklist title (newlines removed, whitespace collapsed, at most 60 characters including a trailing `…`).
- `notification.body`: `Đến giờ thực hiện · {n} bước`, or only `Đến giờ thực hiện` when the checklist has no steps.
- `data` (all strings): `{ "type": "checklist_due", "id": "<checklist id>", "date": "YYYY-MM-DD" }`. Open the checklist `id` and start a run.

Other copy changed in the same release:

- `checklist_30m`: title is the checklist title; body `Đã chạy 30 phút · còn {n} bước chưa tick. Rà lại cho đủ nhé!`. `data` is unchanged.
- `todo_reminder`: title is the todo's own title (same normalisation); the body depends on `is_important` / `is_urgent`:

| `is_important` | `is_urgent` | Body |
| --- | --- | --- |
| true | true | `Quan trọng, khẩn cấp → Làm ngay!` |
| true | false | `Quan trọng → Dành thời gian làm thật tốt.` |
| false | true | `Khẩn cấp → Xử lý nhanh rồi chuyển việc.` |
| false | false | `Việc nhẹ → Làm gọn rồi tiếp tục nhé.` |
| null or unset (either one) | | `Đến giờ thực hiện` |

- Digests keep their titles. Morning: `📋 Nhiệm vụ: ...` / blank line / `💪 Động lực: “...”` / `💡 Suy ngẫm: ...`. Todos: `📋 Tiến độ: ...` plus an optional `💪 ...` line. Habits: `📋 Thói quen: ...` plus an optional `💪 ...` line. All labels live in `src/config/notification-labels.ts`.

## Verification

- `npx tsc --noEmit` is clean.
- `npm test` passes with 396 tests, including `tests/checklist-schedule.test.ts` (pure expansion), `tests/checklist-due.test.ts` (planner, hooks, send, re-validation), `tests/checklist-schedule-api.test.ts` (REST and sync).
- Migration `0017_checklist_schedules.sql` creates `checklist_schedules`, `checklist_schedule_overrides` and rebuilds `notification_jobs` so its `kind` CHECK accepts `checklist_due`. Apply it with `npm run db:migrate` **before** deploying the code, because the new code inserts the new kind.
- Manual send: `npm run notify:job-test -- <userId> checklist_due` (then `--cleanup`).

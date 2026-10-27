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
| `recurrence_end_date` | `YYYY-MM-DD` \| `null` | The **end date of the schedule**, valid for repeating AND non-repeating schedules. Inclusive, must not be before `start_date`. Once it has passed the whole schedule is removed (see "Finished schedules are removed"). |
| `enabled` | boolean | `false` keeps the schedule but stops occurrences and reminders. |
| `paused_from` | `YYYY-MM-DD` \| `null` | Start of the pause window (see "Pausing a schedule"). Always set together with `paused_until`. |
| `paused_until` | `YYYY-MM-DD` \| `null` | Last paused day, inclusive, not before `paused_from`. Both `null` = not paused. |
| `created_at`, `updated_at` | ISO UTC | |

Normalisation applied by the server (REST and sync alike):

- `recurrence_type = null` -> `recurrence_interval` and `recurrence_days_of_week` are stored as `null`. `recurrence_end_date` is **kept**: leaving it `null` on a non-repeating schedule means it ends on its own day (`start_date`).
- `daily` / `custom` -> `recurrence_interval` defaults to 1; `recurrence_days_of_week` is stored as `null`.
- `weekly` -> `recurrence_interval` defaults to 1; weekdays are sorted and de-duplicated (`"5,1,3,1"` becomes `"1,3,5"`). No weekdays = repeat on the weekday of `start_date`.
- `enabled` defaults to `true`.
- `paused_from` / `paused_until`: both `null` or both a real date with `paused_until >= paused_from`; anything else is `400 bad_input` (REST) / `bad_input` (sync op). **Leaving both keys out keeps the pause the schedule already has** (so an older app editing the time does not lift a pause); sending both as `null` clears it. A schedule that is deleted and set again starts from scratch, not paused.

### How occurrences are expanded (mirror this if you compute offline)

- `no repeat`: only `start_date`.
- `daily` / `custom`: `start_date + n * interval` days.
- `weekly` without weekdays: `start_date + n * interval` weeks.
- `weekly` with weekdays: `start_date` first, then the next listed weekday in the same Monday-Sunday week; after the last listed weekday of a week, jump `interval` weeks to the first listed weekday.
- Stop after `recurrence_end_date` (inclusive). A schedule with `enabled = false` has no occurrences.
- A non-repeating schedule has exactly one occurrence, on `start_date`. A later `recurrence_end_date` does not add occurrences; it only decides when the schedule is removed.
- **Pause:** a date inside `[paused_from, paused_until]` (both ends inclusive) is not an occurrence. Apply it last, after the rules above; it never shifts the remaining dates.

## Pausing a schedule

For days the user wants to skip without losing the schedule ("pause until the end of the 7th"). While a day is paused the checklist has **no occurrence** that day, so:

- it is not returned by `GET /checklists/occurrences` and must not be on the app's 24h timeline;
- no `checklist_due` reminder is created or sent, and no `checklist_overdue` nudges either (pending ones are cancelled right away; the server also re-checks right before sending);
- a time override for a paused day is rejected like any non-occurrence (`400 not_an_occurrence`), and an orphan override is ignored;
- the schedule comes back **by itself** the day after `paused_until`: no job and no extra write is needed.

Example: daily from the 1st to the 10th, today is the 4th, the user pauses through the 7th -> store `paused_from = 4th`, `paused_until = 7th`. The 1st-3rd stay on the timeline (they are history), the 4th-7th disappear, the 8th-10th show again.

Rules for the app:

- Set `paused_from` to the **local today** when the user pauses "from now". Do **not** leave it empty or use the schedule's start date: the days before the pause must keep their history on the timeline.
- To change the end of a running pause keep its `paused_from`; to resume early send both as `null`. Editing a pause never changes `start_date`, the repeat rule or `recurrence_end_date`.
- A pause whose `paused_until` is already in the past is harmless history; show it as "not paused". The server does not clean it up.
- The pause does **not** extend the schedule: a schedule still expires after its end date (see below), and a one-off schedule paused on its day simply never fires.
- Pausing does not touch a checklist run the user starts by hand; only scheduled reminders and occurrences are skipped.
- Over REST it is the normal `PUT /checklists/templates/:id/schedule` with the two fields (omit them to keep the current pause, send `null`s to clear). `GET .../schedule`, `GET /checklists/templates/:id` and the sync pull return both fields.

## Finished schedules are removed

A schedule that is "finished" is deleted entirely, as if it had never been set. The detail page goes back to its default: **"Nhắc theo lịch" off and no schedule shown**.

| Finished when | Applies to |
| --- | --- |
| The checklist was **completed on the scheduled day** (a run with `status = completed` whose `completed_at` is on `start_date` in the user's local day) | Non-repeating schedules only |
| The **end date has passed**, i.e. from 00:00 of the next local day (end date the 10th -> removed at 00:00 on the 11th) | Every schedule. The end date is `recurrence_end_date`, or `start_date` for a non-repeating schedule without one. A repeating schedule without an end date never expires. |

A repeating schedule is **not** removed by completing the checklist on one of its days: that day just shows `done: true`.

What the server does when a schedule is finished:

- Soft-deletes the schedule **and all its per-day time overrides** (bumping `updated_at`), so the next `GET /sync/changes` carries tombstones (`deleted_at` set) for both.
- Cancels the pending `checklist_due` reminder and the `checklist_overdue` nudges.
- `GET /checklists/templates/:id` returns `"schedule": null`, `GET /checklists/templates/:id/schedule` returns `404 not_found`, and `GET /checklists/occurrences` no longer lists that checklist. **This includes its past days**: the timeline is built from the schedule, so a removed schedule leaves no occurrence behind (the runs themselves stay in the history).
- Checking happens right when a run changes (REST or sync), on every minute's maintenance beat, and before the three read endpoints above answer, so the app never reads a finished schedule even a moment after it finished.

Notes for the app:

- On pull, a `checklist_schedules` tombstone means: drop the local schedule and show the default state. Apply the same rule locally right after the user completes a non-repeating checklist so the page resets without waiting for a sync.
- Saving a non-repeating schedule for a day that is already completed, or one whose end date is already past, is accepted but is removed again the next time the server reads it. The app can avoid offering these.
- The per-day time change on the timeline (`PUT /checklists/templates/:id/occurrences/:date`) is unchanged: it moves only that day's reminder and leaves other days alone.
- Setting a schedule again after a removal works from scratch (same row is revived, the old overrides do not come back).

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

A one-off reminder is just `{ "start_date": "2026-06-20", "time": "21:00" }` (omit `recurrence_type`). It may carry an end date too: `{ "start_date": "2026-06-20", "time": "21:00", "recurrence_end_date": "2026-06-25" }` keeps the schedule until 00:00 on the 26th unless the checklist is completed on the 20th.

### `GET /checklists/templates/:id/schedule`

`200 { "schedule": {...} }`, or `404 { "error": "not_found" }` when the checklist has no live schedule.

### `DELETE /checklists/templates/:id/schedule`

`204`. Idempotent (deleting a schedule that does not exist is also `204`). Its per-day overrides are removed with it, pending reminders are cancelled. This is also what the server does by itself when a schedule is finished.

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
- Android channel id: `checklist_reminders` (the app must create it; the "still running" nudges below use it too).
- `notification.title`: the checklist title (newlines removed, whitespace collapsed, at most 60 characters including a trailing `…`).
- `notification.body`: `Đến giờ thực hiện · {n} bước`, or only `Đến giờ thực hiện` when the checklist has no steps.
- `data` (all strings): `{ "type": "checklist_due", "id": "<checklist id>", "date": "YYYY-MM-DD" }`. Open the checklist `id` and start a run.

If the checklist is still not done 2 hours after its time, the server keeps nudging every 2 hours until the end of the day: see `MOBILE_NOTIFICATION_REMINDERS_CONTRACT.md`.

## Push Notification `checklist_running` (a started checklist that is not finished)

Replaces the single 30-minute nudge. While a run is `in_progress` the server nudges **every hour after it was started**, for the rest of that local day, and then **once at 06:00 the next morning**:

| Started at | Nudges |
| --- | --- |
| 12:15 | 13:15, 14:15, ... , 23:15, then 06:00 the next day |
| 23:30 | only 06:00 the next day (no hourly nudge crosses midnight) |

- After the 06:00 reminder nothing more is sent for that run, even if it is still open.
- Everything is in the user's notification timezone. A nudge is cancelled as soon as the run is completed, stopped or deleted, and it is not sent when every step is already ticked. The server re-checks this right before each send.
- A nudge that would be sent more than 30 minutes late is dropped, never sent late. FCM `ttl` 1 hour, priority `high`, channel `checklist_reminders`.
- `notification.title`: the checklist title (same normalisation as above).
- `notification.body`, one short line (`n` = steps not ticked yet):
  - hourly: `⏳ Đã làm {h} giờ · còn {n} bước chưa tick` (`h` = hours since the start: 1, 2, 3, ...);
  - next morning: `🌅 Hôm qua chưa xong · còn {n} bước chưa tick`.
- `data` (all strings), unchanged from the old nudge: `{ "type": "checklist", "id": "<run id>", "date": "YYYY-MM-DD" }`, where `date` is the local day the run was started. Open the run `id`; for the 06:00 reminder that run was started the day before.

No app change is required: the type, the id and the channel are the same as before.

Other copy changed in the same release:

- The one-shot `checklist_30m` nudge (30 minutes after "start") is gone: see "Push Notification `checklist_running`" below.
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
- `npm test` passes, including `tests/checklist-schedule.test.ts` (pure expansion), `tests/checklist-due.test.ts` (planner, hooks, send, re-validation), `tests/checklist-schedule-api.test.ts` (REST and sync) and `tests/checklist-schedule-expiry.test.ts` (finished schedules are removed).
- Migration `0017_checklist_schedules.sql` creates `checklist_schedules`, `checklist_schedule_overrides` and rebuilds `notification_jobs` so its `kind` CHECK accepts `checklist_due`. Apply it with `npm run db:migrate` **before** deploying the code, because the new code inserts the new kind.
- Manual send: `npm run notify:job-test -- <userId> checklist_due` (then `--cleanup`).
- Pause: migration `0021_checklist_schedule_pause.sql` adds the two nullable columns `paused_from` / `paused_until` (existing rows = not paused). Apply it with `npm run db:migrate` **before** deploying the code, because the code selects and writes them. Covered by the `pause` tests in `tests/checklist-schedule.test.ts` (expansion), `tests/checklist-schedule-api.test.ts` (REST, sync, jobs) and `tests/checklist-due.test.ts` (planner, overdue nudges, re-validation before sending).

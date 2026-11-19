# Mobile Contract: Checklist Schedule and Due Reminders

## Backend Summary

- API base: `/api/v1`. All endpoints need the usual Bearer token.
- A checklist (`checklist_templates` row, including the shared system templates) can have **at most one schedule per user**: a start date, a time of day (`HH:mm`, the user's local time) and an optional repeat rule. The schedule belongs to the user, so scheduling a system checklist never edits the shared template.
- A single day can be moved to another time with a **per-day override**.
- The server pushes an FCM notification at the scheduled time (kind `checklist_due`) unless that local day is already **done** (see "When is a day done").
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

## When is a day done (`done`)

ONE rule, used by `GET /checklists/occurrences`, the reminder (`checklist_due`: planning, hooks and the re-check right before sending), the removal of finished one-off schedules and the habit auto-tick. The Flutter timeline computes the same thing locally, so keep both in step.

1. **A run counts for the day it STARTED** (`started_at` in the user's local time), not the day it finished. Started 23:30 on the 1st and finished 00:30 on the 2nd = done on the 1st; the 2nd stays open. Only `status = completed` runs count (in-progress, abandoned and deleted runs do not).
2. **A manual mark** (`checklist_occurrence_mark`, at most one per user + checklist + local day) can override it. A checklist may legitimately be done twice a day, so one finished run does not always settle the day: the user long-presses the checklist in the timeline and picks "Chưa hoàn thành" or "Hoàn thành".

| Mark of that day | The day is done when |
| --- | --- |
| none | at least one completed run **started** that day |
| `done` | always, with no run and no steps needed |
| `open` | a run that started that day was **completed after the mark's `updated_at`** (the user reset the day by hand and then did the checklist again) |

Reference implementation: `doneDatesOf()` in `src/services/checklist-occurrence-done.ts`.

Consequences worth knowing:

- Marking a day `done` is exactly like completing a run for reminders: that day's `checklist_due` job is cancelled; marking it `open` (or deleting the mark) re-arms them.
- Marking a day `done` ticks the habits linked to the checklist for **that** day. Marking it `open` does **not** remove a log that was already written (same rule as for runs: logs are history). A completed run ticks the linked habits on its **start** day. A habit status the user already set for that day is never changed by these ticks (next section).
- A non-repeating schedule is finished (removed, see below) when its day is done, whether by a run or by a `done` mark. After that there is no occurrence left to long-press; the schedule is not recreated by an `open` mark.
- A repeating schedule is never removed by a mark.
- A mark belongs to the checklist's day, not to the schedule: deleting or re-creating the schedule keeps the marks; deleting the checklist soft-deletes them.
- `updated_at` of the mark is the moment of the user's tap and is part of the rule (`open` only holds against runs completed before it), so the app must set it to the real tap time (client clock, same clock that stamps run `completed_at`).

## Automatic habit ticks never override the user

A linked todo or checklist (a completed run, a `done` mark) ticks its habit **only on a day nobody has set**. A habit log the user wrote (a day marked missed in advance, or ticked by hand) is never changed by these ticks, whichever way it points; only the user's own edit changes it. Deleting the log hands the day back to automation.

- The server may raise a day it filled itself (or the midnight job's `completed = false`) to done. It never lowers a tick it wrote, and completing a todo late does not lower anything.
- A `habit_log` pushed for a habit and day the server already filled automatically (under another id) replaces that automatic row; the push answers `conflict` with the row to adopt, like any natural-key collision. A row the user wrote is kept: the push gets `conflict` with the server copy.
- The app's local mirror of the tick (instant feedback before the pull: the todo-completion projection and the checklist tick overlay) must follow the same rule. It cannot tell the user's `completed = false` from the midnight job's, so it may only fill a day that has **no live log**; it must not raise an existing `false` log. The next pull brings the server's answer.

## Pausing a schedule

For days the user wants to skip without losing the schedule ("pause until the end of the 7th"). While a day is paused the checklist has **no occurrence** that day, so:

- it is not returned by `GET /checklists/occurrences` and must not be on the app's 24h timeline;
- no `checklist_due` reminder is created or sent, (a pending one is cancelled right away; the server also re-checks right before sending);
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
| The checklist was **done on the scheduled day** (see "When is a day done": a completed run that **started** on `start_date` in the user's local day, or a `done` mark for that day) | Non-repeating schedules only |
| The **end date has passed**, i.e. from 00:00 of the next local day (end date the 10th -> removed at 00:00 on the 11th) | Every schedule. The end date is `recurrence_end_date`, or `start_date` for a non-repeating schedule without one. A repeating schedule without an end date never expires. |

A repeating schedule is **not** removed by completing the checklist on one of its days: that day just shows `done: true`.

What the server does when a schedule is finished:

- Soft-deletes the schedule **and all its per-day time overrides** (bumping `updated_at`), so the next `GET /sync/changes` carries tombstones (`deleted_at` set) for both.
- Cancels the pending `checklist_due` reminder.
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

### `PUT /checklists/templates/:id/occurrences/:date/status`

Marks ONE day by hand (long-press on the timeline). `:date` must be a real occurrence of an enabled schedule.

```json
{ "status": "done" }
```

`status` is `"done"` ("Hoàn thành", no steps needed) or `"open"` ("Chưa hoàn thành"). `200`:

```json
{ "checklistId": "0192f3b1-...", "date": "2026-06-02", "manual": "done", "done": true }
```

`done` is `status === "done"` here (the mark is the newest event, so nothing can have been completed after it). Errors: `404 not_found` (no checklist, not yours, or no schedule), `400 not_an_occurrence`, `400 bad_input` (status other than `done`/`open`, malformed date).

### `DELETE /checklists/templates/:id/occurrences/:date/status`

`204`. Idempotent. Removes the mark: the day goes back to the automatic rule (done if a run started that day was completed).

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
      "done": true,
      "manual": null
    }
  ]
}
```

- `stepCount`: live steps of the checklist.
- `overridden`: the time comes from a per-day override.
- `done`: see "When is a day done": a completed run that **started** that local day, or a `done` mark, unless an `open` mark is newer than every such run. An abandoned or deleted run does not count; neither does another user's run.
- `manual`: the live mark of that day, `"done"` | `"open"`, or `null` when the day is automatic.
- Deleted checklists, deleted schedules and disabled schedules are not listed. An override left behind for a day the schedule no longer covers is ignored.

### Errors

`401` without a token. `404 { "error": "not_found" }` for an unknown checklist or one that is not visible to the user (own or system). `400 { "error": "bad_input", "issues": [...] }` for validation (bad time, nonexistent date, interval outside 1..365, weekday outside 1..7, end date before start date, unknown `recurrence_type`).

## Sync Contract

Three entity types, all per user and soft-deleted like the rest:

- `checklist_schedule` -> pull array `checklist_schedules`
- `checklist_schedule_override` -> pull array `checklist_schedule_overrides`
- `checklist_occurrence_mark` -> pull array `checklist_occurrence_marks`

`checklist_schedule` fields are the table above plus `user_id` and `deleted_at` (pulled rows carry them like every synced row); `enabled` is a boolean on the wire.

`checklist_schedule_override` fields: `id`, `template_id`, `local_date` (`YYYY-MM-DD`), `time` (`HH:mm`), `created_at`, `updated_at`, `deleted_at`.

`checklist_occurrence_mark` fields: `id`, `template_id`, `local_date` (`YYYY-MM-DD`), `status` (`"done"` | `"open"`), `created_at`, `updated_at`, `deleted_at` (plus `user_id` on pull). Removing a mark is an op `delete`.

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
- Natural keys are merged in place: one schedule per `(user, template_id)`, one override and one mark per `(user, template_id, local_date)`. If the server already has a row for the key under a different `id`, the push updates **that** row (no `conflict` status). Pull afterwards and keep the server's `id`.
- Last-Write-Wins on `updated_at`: an older push is ignored. Deleting is an op `delete` with `{ id, updated_at, deleted_at }` and is idempotent.
- Deleting a schedule soft-deletes its overrides (not its marks); deleting a checklist (REST or sync) soft-deletes its schedule, overrides and marks. The tombstones arrive in the next pull with `since`.
- A schedule or override for a checklist the user cannot see (someone else's, or deleted) is acknowledged but not written, as `checklist_template_order` does. Push the checklist before its schedule in the same batch.
- A mark for a checklist the user cannot see is acknowledged but not written, like the other two. `status` must be `done` or `open` and `local_date` a real date, otherwise `bad_input`.
- Marks are not validated against the schedule (the app may push a mark and its schedule in one batch in any order). After pulling, resolve two local marks for the same `(template_id, local_date)` by keeping the one the server returned.
- A pushed `done` mark also ticks the linked habits for that day on the server, unless the user already set that habit's status for the day (see "Automatic habit ticks never override the user").
- Every accepted change cancels and recreates the affected reminder jobs on the server.

## Push Notification `checklist_due`

- Sent to **all** devices of the user at the occurrence time (the override time if any), unless that local day is already done (completed run started that day, or a `done` mark), the schedule was disabled/deleted/moved, or the checklist was deleted. The server re-checks all of this right before sending.
- A reminder that would be sent more than 30 minutes late is dropped, never sent. FCM `ttl` 1 hour, priority `high`.
- Android channel id: `checklist_reminders` (the app must create it; the "still running" nudges below use it too).
- `notification.title`: the checklist title (newlines removed, whitespace collapsed, at most 60 characters including a trailing `…`).
- `notification.body`: `Đến giờ thực hiện · {n} bước`, or only `Đến giờ thực hiện` when the checklist has no steps.
- `data` (all strings): `{ "type": "checklist_due", "id": "<checklist id>", "date": "YYYY-MM-DD", "tag": "checklist:<checklist id>" }`. Open the checklist `id` and start a run. `tag` is explained in "Notification tags" below.

A checklist is reminded **once**, at its time. There is no repeated "overdue" nudge: the old `checklist_overdue` (every 2 hours after the time while not done) was removed, so being late or leaving it undone never triggers another push. A repeating schedule still reminds once on each of its days; a non-repeating one reminds exactly once. (A run the user has started and left unfinished is a different case and is still nudged, see `checklist_running` below.)

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
- `data` (all strings): `{ "type": "checklist", "id": "<run id>", "date": "YYYY-MM-DD", "tag": "checklist:<checklist id>" }`, where `date` is the local day the run was started. Open the run `id`; for the 06:00 reminder that run was started the day before. The `tag` is keyed by the **checklist** (not the run), so the nudge replaces the `checklist_due` notification of the same checklist.

The type, the id and the channel are the same as before; `tag` is the only addition (see "Notification tags").

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

- Digests keep their titles, but the first body line is now a short numbers line (the collapsed notification only shows the first ~45 characters). Morning: `📋 Hôm nay: 5 todo (xong 2, còn 3) · 3 thói quen` / blank line / `💪 Động lực: “...”` / `💡 Suy ngẫm: ...` (a zero part is left out). Todos: `📋 Xong 2/5 todo · còn 3 đang chờ` (or `📋 Xong cả 5 todo hôm nay`) plus an optional `💪 ...` line. Habits: `📋 Đã duy trì 1/3 thói quen` (or `📋 Đã duy trì đủ 3/3 thói quen`) plus an optional `💪 ...` line. All labels live in `src/config/notification-labels.ts`.
- `todo_overdue` (the repeated nudge after the appointment time) now says how late the todo is, because it replaces the previous nudge: `⏰ Trễ 2 giờ (hẹn 10:00) · Làm ngay hoặc dời lịch!` (it used to be `⏰ Quá giờ 10:00 · ...`).
- `todo_overdue` stops once the todo is **started**, even if it is not completed: `status = "in_progress"`, or a countdown that was started on it (`PUT /todos/:id/timer` events `start`/`resume` -> running, `pause` -> paused, or the countdown ran out -> finished). Sending the timer event `stop` (back to `idle`) makes the todo eligible for the next slot again. The on-time `todo_reminder` follows the same rule for the countdown: if the countdown (running, paused, or ran out and not stopped) is still on when the reminder comes due, the server does **not** send it. Stopping the countdown (`stop`) before the reminder time brings the reminder back. `status = "in_progress"` alone does not suppress the on-time reminder. The card that a reminder or nudge already left on the phone is removed when the countdown starts, see "Removing a card" below.

## Notification tags (one card per task)

Every push the job system sends carries a **tag** twice: as `android.notification.tag` and as `data.tag`. Android replaces a notification that has the same tag as one already in the tray, so a user who was away comes back to one up-to-date card per topic instead of a pile of repeats.

| Tag | Used by | Effect |
| --- | --- | --- |
| `todo:<todo id>` | `todo_reminder`, `todo_overdue`, `todo_timer_end` | The 10:00 reminder, then the 11:00, 12:00 ... "Trễ N giờ" nudges, then a countdown end all share one card. For an occurrence of a recurring todo the id is the **series root** (`recurrence_template_id`), so today's reminder replaces yesterday's leftover card; `data.id` is still the occurrence to open. |
| `checklist:<checklist id>` | `checklist_due`, `checklist_running` | "Đến giờ thực hiện" is replaced by "Đã làm 1 giờ", "Đã làm 2 giờ" ... Keyed by the checklist, **not** the run id (`data.id` is still the run id for `checklist`). |
| `digest:day` | `digest_morning`, `digest_todos`, `digest_habits`, `digest_review` | At most one daily summary on the tray; each one replaces the previous (yesterday's review is gone when this morning's arrives). |
| `digest:overdue` | the two overdue-important summaries (17:00 and 07:00 next morning) | The morning one replaces the evening one. |

What the app has to do:

- **Background / app closed:** nothing. The system shows the notification and applies `android.notification.tag` by itself.
- **Foreground:** FCM does not show anything while the app is open; if the app displays its own local notification, give it **`data.tag` as its tag** (and a fixed id, for example 0) so it replaces in the same way. Old servers sent no `tag`: fall back to the current behaviour when `data.tag` is missing.
- **Clearing:** the server cannot delete a notification already on the device, and replacing is the only thing it does. A card therefore stays until it is replaced or swiped away, even if the todo was completed meanwhile. To tidy that up, cancel by tag when the app opens or syncs and sees the task is done or deleted. Expected to work with `NotificationManager.cancel(tag, 0)` (the FCM SDK posts with id 0) or `flutter_local_notifications` `cancel(0, tag: ...)`; confirm on a real device, the server side of this has not been exercised against one.
- `tag` is a plain string, at most 128 characters; treat it as opaque.

### Removing a card when the todo's time or date changes (`type: "dismiss"`)

When the user changes the **reminder time or date** of a todo (REST, sync push or admin), the notification that was already delivered for the old time must disappear, and only the repeats for the *new* time remain. The server cannot delete a notification that is already on the phone, so it sends a **data-only** FCM message (no `notification` block: the system shows nothing and your handler runs):

```json
{ "type": "dismiss", "id": "<todo id>", "tag": "todo:<todo id or series root id>", "before": "2026-06-20T03:00:30.000Z" }
```

(all strings; `android.priority = high`, `ttl` 3 minutes.) **The app must handle it, otherwise nothing is removed:**

- In the FCM background/foreground handler, when `data.type == "dismiss"`: cancel the notification whose tag is `data.tag` (see "Clearing" above for the calls), show **nothing**, and do not navigate. Unknown or missing `tag` -> ignore.
- If the platform lets you read when a notification was posted (`StatusBarNotification.getPostTime()`), cancel only notifications posted **at or before** `data.before`. The server already avoids sending a dismiss when a new notification with the same tag is due within 4 minutes, so this is a second safety net, not a requirement.
- Make sure your background handler does **not** turn a data-only message into a visible notification; older handlers that build a notification from `data.title` / `data.body` must skip `dismiss`.

What the server guarantees / does not:

- Sent once per stale card, to every device of the user, after the new reminder / repeat jobs have been re-armed. The repeats follow the new time, e.g. at 10:00 an important+urgent todo moved from 10:00 to 09:10 loses its card now and still gets its next repeat at 10:10.
- Not sent for edits that keep the date and time (title, importance, estimate...), for completed / archived / deleted todos, or for cards sent before server migration `0026`.
- If the next notification of that todo **for its new schedule** is due within 4 minutes (e.g. moved to 09:03 at 10:00 -> repeat at 10:03, or moved to 10:03 -> the new reminder at 10:03) no dismiss is sent: that notification has the same tag and replaces the old card by itself. A leftover notification of the *old* schedule does not count (the server cancels it without sending), so the dismiss is still sent.
- The tag of an occurrence of a recurring todo is the series root's id, so the dismiss removes whatever card currently carries that tag on the phone. Todos of one series normally have a single open occurrence at a time, so this is the card of the todo that was edited.
- Best effort. It is a high-priority data message, so Doze / aggressive battery savers / a force-stopped app can delay or drop it, and a phone that stays offline longer than 3 minutes misses it (the card then stays until replaced or swiped away).
- A **snooze** (`POST /todos/:id/snooze`, see "Snooze a todo's reminder") is the one case that always sends it, even inside the 4-minute window, with a `ttl` shortened to end before the new reminder is due.

**The same `dismiss` message is also sent when the user starts or resumes a countdown** (`PUT /todos/:id/timer`, `action` `start` or `resume`). Once the user is working on the todo the reminder / nudge card on the phone is obsolete, but the server can only stop *future* nudges, so it asks every device to remove the card. Same payload, same handling in the app (cancel by `data.tag`), nothing new to implement. Details:

- It goes to **all** the user's devices, the starting one included; your own local cancel on the starting device (done the moment the user taps start) stays, the message only covers the other devices and cards that were posted between the tap and the moment the server received the event. Cancelling an already-cancelled tag is a no-op.
- It is sent **after** the event was accepted and does not delay or change the response of `PUT /todos/:id/timer`; if the send fails the request still succeeds.
- Not sent for: `pause`, `stop`, `finish`; an event the server ignores as old or replayed (`ignored: true`); a rejected event (`device_not_found`, `todo_completed`, unknown todo); a subtask (no card of its own).
- Not sent when **240 seconds or less** are left on a new countdown: the end-of-countdown push (`todo_timer_end`) is then due within the 4-minute replace window, shares the tag, and replaces the card itself (a late `dismiss` could remove it). With 0 seconds left (the countdown is already over) no end-of-countdown push exists, so the card is removed.
- The tag is the one the card was sent with: `todo:<todo id>`, or `todo:<series root id>` for an occurrence of a recurring todo.

## Reminder repeat: once, 5 minutes after the on-time reminder, important + urgent todos only (`todo_reminder_repeat`)

A todo with a time gets its on-time reminder (`type: "todo"`, see above). If the todo is **important AND urgent** (both flags true; any other group, including unclassified, gets none), the server sends **one more** push of the same todo at the appointment time **+5 minutes**. It stops the moment the user has reacted. The server cannot see taps or whether the app is open, so **the app must report them**. After that single repeat the todo only follows its regular pattern (`todo_overdue`, hourly for important + urgent), and that pattern is itself switched off once the todo is started.

**Payload of the repeat.** Same `type: "todo"`, same `id`, `date`, `tag` (`todo:<id or series root id>`, so it replaces the card on the tray), same title and body, channel `todo_reminders`, FCM `ttl` 2 minutes. The only difference is one extra data key: **`repeat`**, always `"1"`. The on-time reminder and the hourly `todo_overdue` nudges have **no `repeat` key**. Old apps ignore the key and simply show the repeat.

**When the server stops by itself** (nothing for the app to do): the todo is completed, archived or deleted; its date or time was edited; it is no longer important + urgent; it became `in_progress`; or a countdown was started on it (`PUT /todos/:id/timer` with `start` / `resume`, or any timer state other than `idle`: running, paused, or ran out). It is checked again right before sending. The on-time reminder itself is also skipped when a countdown is on at its time (any state other than `idle`). A repeat that the server sends more than 2 minutes late is dropped, never delivered late.

**What the app must do: `POST /api/v1/todos/:id/reminder-ack`** (user JWT, no request body)

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ "todo_id": "<id>", "cancelled": 1 }` | The pending repeat was cancelled (`cancelled` is `1`, or `0` when none was pending: not important + urgent, already sent, or already acknowledged). Idempotent. Applies to **all devices** of the user. |
| 404 | `{ "error": "not_found" }` | The todo is not on the server (yet), was deleted, or is not the caller's. Drop it; do not retry. |
| 401 | | The usual auth handling. |

Call it for the `data.id` of the push, in these cases:

1. **The user taps the notification**, which opens the todo's detail page (cold start, background or foreground). Do it in the common tap path (`PushNavigation.handle`, for `data.type == "todo"`), after the user is signed in.
2. **A `type: "todo"` push arrives while the app is open (foreground).** The user is already inside the app, so ack it. If it has `data.repeat`, **do not show it at all** (no local notification, no sound or vibration); the on-time reminder keeps the current foreground behaviour.

Best effort and fire-and-forget: never block the UI, retry a few times with a short backoff (for example 2 s, 5 s, 15 s) on network errors / 5xx / 429, and give up after about 6 minutes (the repeat is due at +5 minutes, so it is over by then). No persistent queue is needed. Starting the countdown needs **no** ack: the timer events already tell the server (the repeat is cancelled when the `start` / `resume` event is accepted).

Migration `0027_todo_reminder_repeat.sql` rebuilds `notification_jobs` so its `kind` CHECK accepts `todo_reminder_repeat`. Apply it with `npm run db:migrate` **before** deploying the code. Tests: `tests/reminder-repeat.test.ts`, `tests/migration-0027.test.ts`.

## Reminders wait while another todo is being counted down, and same-time reminders queue (server only)

**No app change is needed and no payload or endpoint changed.** The on-time `todo_reminder` simply arrives later than the appointment time in two situations. It is still the same push (same `type`, `id`, `date`, `tag`, no `repeat` key).

1. **A countdown is running on another todo.** The app already reports it with `PUT /todos/:id/timer` (`start` / `resume` carry `remainingSeconds`, so the server knows when it ends). Every other todo whose reminder time falls **before or exactly when that countdown ends** is held and sent at **countdown end + 2 minutes**; if several are held they follow each other 2 minutes apart. Example: three todos at 14:00, 14:30, 15:30; Todo 1 started at 14:03 with 60 minutes (ends 15:03) -> Todo 2 arrives at 15:05, Todo 3 at 15:30 as usual. Started at 14:06 with 90 minutes (ends 15:36) -> Todo 2 at 15:38, Todo 3 at 15:40.
   - A countdown that **stops early** (`stop`, `pause`, `finish`, or the todo is completed, archived or deleted) releases the held reminders **2 minutes after that moment**. `resume` holds again. A paused, finished or `idle` countdown holds nothing. A countdown never holds the reminder of its own todo.
   - Only a **running** countdown counts, so the app must keep sending the timer events (it already does). If an event reaches the server late, the hold starts when it arrives; a reminder that already went out is not recalled.
   - While a countdown runs on another todo the server also **drops** (does not postpone) the `todo_reminder_repeat` (+5 min) and `todo_overdue` nudges of the other todos that come due in that window; the next `todo_overdue` slot is judged on its own. Digests, checklist reminders and the countdown-end push (`todo_timer_end`) are not affected.
2. **Several reminders share a time.** They go out 2 minutes apart, first the todo with the earliest appointment, then by group (important + urgent, urgent only, important only, neither; an unset flag counts as "no"), then the one created first. A reminder that lands on or before an earlier one in the queue goes 2 minutes after it. The `todo_reminder_repeat` keeps its own timing (appointment +5 min, important + urgent only), so repeats of same-time todos are not spaced out.

A reminder that was held or spaced out and goes out later than the appointment time no longer gets the +5 minute repeat if that moment has already passed. Tests: `tests/reminder-queue.test.ts`.

## Snooze a todo's reminder (`POST /api/v1/todos/:id/snooze`)

Like an alarm clock's snooze: the user cannot act now, so the todo's reminder moves N minutes later, every device gets the new time, and the notification on the phones disappears. The app offers **5, 10, 15, 30, 60 minutes or a custom number**; the server accepts any whole number of minutes from **1 to 1440** (a day; further away is "move to another day").

**Request** (user JWT; applies to a todo that has a date and a time, top-level, open or in progress)

```json
{ "minutes": 30 }
```

**200**

```json
{
  "todo": { "id": "...", "scheduled_date": "2026-06-20", "time": "15:30", "...": "the whole todo, same shape as PATCH /todos/:id" },
  "minutes": 30,
  "remind_at": "2026-06-20T08:30:00.000Z",
  "previous": { "scheduled_date": "2026-06-20", "time": "15:00" }
}
```

`remind_at` is when the reminder is due again (UTC). A reminder can still arrive later than that when it is held behind another todo's countdown (see "Reminders wait while another todo is being counted down"). `previous` lets the app offer "Undo" with `PATCH /todos/:id` `{ "scheduled_date": ..., "time": ..., "time_scope": "this" }`.

| Status | Body | Meaning |
| --- | --- | --- |
| 400 | `{ "error": "bad_input", "issues": [...] }` | `minutes` missing, not an integer, below 1 or above 1440. |
| 404 | `{ "error": "not_found" }` | Unknown, deleted or someone else's todo. Drop the card. |
| 409 | `{ "error": "todo_completed" }` | Done or archived: nothing is left to remind about. Drop the card. |
| 409 | `{ "error": "no_reminder" }` | The todo has no date or no time, or it is a subtask: there is no reminder to move. |
| 409 | `{ "error": "duplicate" }` | A recurring todo whose snooze would roll over midnight onto a day another occurrence of the series already holds. Offer a shorter snooze. |
| 401 | | The usual auth handling. |

**The new time** is `minutes` after the **later** of the todo's current reminder time and the current minute, in the user's time zone (`users.timezone`, default `Asia/Ho_Chi_Minh`). Seconds are dropped (the time is `HH:mm`).

| Situation | Todo | Snooze | Now | Result |
| --- | --- | --- | --- | --- |
| Tapped on the on-time reminder | 15:00 | 30 | 15:00:40 | **15:30** |
| Tapped on a nudge two hours late | 15:00 | 15 | 17:03:20 | 17:18 (counted from now, a time in the past would never ring) |
| Snoozed before it is due (todo screen) | 15:00 | 30 | 14:00 | 15:30 |
| Past midnight | 23:50 | 30 | 23:50:10 | 00:20 **the next day** (`scheduled_date` moves too) |

An overdue todo (dated before today) lands on today; the past day is closed first, exactly as for any other edit of a past-day todo.

**Recurring todos: only this occurrence.** The edit is always `time_scope: "this"`: today's run of a daily todo moves, the series' usual time does not, and the next occurrence is generated at the usual time. There is no "Today only / All occurrences" prompt for a snooze.

**What the server does** (one request, nothing for the app to chain):

1. Saves `scheduled_date` / `time` like any other todo edit, so the other devices receive them in their next `GET /sync/changes` (the todo's `updated_at` moves too); no new sync entity or field.
2. Re-arms the reminder around the **new** time: the on-time `todo_reminder`, the +5 minute repeat (important + urgent), and the hourly / 2-hourly `todo_overdue` nudges all follow it, and an already sent reminder is armed again. Same-time reminders re-queue.
3. Sends the `type: "dismiss"` message (see "Removing a card when the todo's time or date changes") to **all** the user's devices, the one that snoozed included, with the same payload and the same app handling. Unlike an ordinary time edit it is **always** sent: also when the next notification is due within 4 minutes (a 3-minute snooze), and also when the server has no record of a delivered card. Its FCM `ttl` is shortened to 15 seconds less than the time until the new reminder (at most 3 minutes, at least 5 seconds), because the app cancels by `data.tag` and ignores `data.before`: a late dismiss must expire before the new reminder is shown, or it would remove it.

**What the app has to do:**

- **Where the button can be.** A reminder that the system draws itself (the app is in the background or closed; the FCM `notification` block) is drawn by Android and **cannot carry action buttons**. Only a notification the app draws itself can: the foreground case (`PushMessageDispatcher.onForegroundMessage` -> `PluginNotificationSink.show`) can add a "Snooze" action; everywhere else the snooze has to start from the todo (tapping the card opens it, and the todo screen offers the same picker).
- **The picker:** 5 / 10 / 15 / 30 / 60 minutes and "Custom" (whole minutes, 1 to 1440). On a choice call the endpoint and cancel the local card at once (`TrayCleanup`, tag `todo:<series root id or todo id>`); the dismiss message only covers the other devices.
- **Show the result** from the response (`todo.time`, and `todo.scheduled_date` when it moved) and update the local copy of the todo; the other devices pick it up with their next pull.
- **`404` / `409 todo_completed`:** drop the card and the todo is gone or finished. `409 no_reminder`: the card is stale. `409 duplicate`: tell the user to pick a shorter time.
- **Offline.** The endpoint needs the network. If the app wants snooze to work offline it applies the same rule locally (the table above) and saves it as a normal edit of the todo with `time_scope: "this"`; the server then handles it like any time edit (jobs re-armed, and the old card removed by the ordinary `dismiss` rules).
- Do **not** call `reminder-ack` for the snooze: the reminder of the new time is armed again by the server.

Tests: `tests/todo-snooze.test.ts`.

## Verification

- `npx tsc --noEmit` is clean.
- `npm test` passes, including `tests/checklist-schedule.test.ts` (pure expansion), `tests/checklist-due.test.ts` (planner, hooks, send, re-validation), `tests/checklist-schedule-api.test.ts` (REST and sync) and `tests/checklist-schedule-expiry.test.ts` (finished schedules are removed).
- Migration `0017_checklist_schedules.sql` creates `checklist_schedules`, `checklist_schedule_overrides` and rebuilds `notification_jobs` so its `kind` CHECK accepts `checklist_due`. Apply it with `npm run db:migrate` **before** deploying the code, because the new code inserts the new kind.
- Manual send: `npm run notify:job-test -- <userId> checklist_due` (then `--cleanup`).
- Day marks and start-day rule: migration `0023_checklist_occurrence_marks.sql` creates `checklist_occurrence_marks` and indexes `checklist_runs` by `started_at` (dropping the unused `completed_at` index). Apply it with `npm run db:migrate` **before** deploying the code: the sync pull selects the new table, so an unmigrated database fails every pull. Covered by `tests/checklist-occurrence-marks.test.ts` (rule, REST, sync, reminders, habits) and `tests/migration-0023.test.ts`.
- Reminder repeat: migration `0027_todo_reminder_repeat.sql` (see "Reminder repeat" above), covered by `tests/reminder-repeat.test.ts` and `tests/migration-0027.test.ts`.
- Snooze: no migration; it is a new endpoint on the existing todo columns and the existing `dismiss` message (see "Snooze a todo's reminder"), covered by `tests/todo-snooze.test.ts`.
- Card removal on reschedule: migration `0026_notification_card_key.sql` adds the nullable column `notification_jobs.card_key` (the schedule a delivered reminder / repeat was sent for). Apply it with `npm run db:migrate` **before** deploying the code: the tick writes the column when it marks a job sent. Covered by `tests/notification-dismiss.test.ts`.
- Removed overdue nudge: migration `0024_cancel_checklist_overdue.sql` cancels the pending `checklist_overdue` jobs (history is kept and the kind stays allowed in the table). It is a data cleanup only: even if it has not run yet, the server cancels any leftover `checklist_overdue` job when it comes due instead of sending it. Tests: `tests/overdue-nudges.test.ts` (checklist section), `tests/checklist-due.test.ts`, `tests/migration-0024.test.ts`.
- Pause: migration `0021_checklist_schedule_pause.sql` adds the two nullable columns `paused_from` / `paused_until` (existing rows = not paused). Apply it with `npm run db:migrate` **before** deploying the code, because the code selects and writes them. Covered by the `pause` tests in `tests/checklist-schedule.test.ts` (expansion), `tests/checklist-schedule-api.test.ts` (REST, sync, jobs) and `tests/checklist-due.test.ts` (planner, overdue nudges, re-validation before sending).

# Mobile Contract: Overdue Nudges and Evening Review

## Backend Summary

- Two additions to the push notifications. Both are server-side; the app only needs one new setting field and (optionally) a route for one new push type.
- All times are the user's local time (`users.timezone`).

## 1. Overdue nudges (repeat every 2 hours)

When a todo with a time, or a scheduled checklist, is **still not done** after its time, the server pushes again at time + 2 h, + 4 h, ... until the end of that local day. Example: a todo at 10:00 gives pushes at 12:00, 14:00, 16:00, 18:00, 20:00, 22:00. A todo at 11:00 also gets 23:00; one at 22:00 or later gets none (the next slot is already tomorrow).

### Which items are nudged

| Item | Nudged when |
| --- | --- |
| Todo | Open or in progress, top-level, has `scheduled_date` and `time`. |
| Checklist | Its schedule occurs today (override applied), the schedule is enabled, and **no completed run** of that checklist exists on that local day. |

Never nudged:

- A todo with `estimated_minutes` **greater than 120**. Exactly 120, or no estimate, is nudged.
- A todo with `is_important = false` **and** `is_urgent = false`. If either flag is `null` (not classified yet) the todo is still nudged.
- Sub-tasks, todos without a date or a time, done or archived todos.
- A todo whose countdown timer is **running** at that moment (that one slot is skipped; the next slot is judged on its own).

### What stops or moves the nudges

Every change is picked up right away, and the server re-checks everything just before sending.

- Completing the todo (or finishing a checklist run that day) stops the rest of the day. Un-completing brings the remaining slots back.
- Editing the time moves the slots (they are recomputed from the new time); rescheduling to another day moves them to that day; clearing the time or the date removes them.
- Changing the estimate above 2 h, or marking the todo not important and not urgent, removes them.
- Overriding a checklist's time for today moves its slots; disabling or deleting the schedule, or deleting the checklist, removes them.
- A time zone change recomputes the slots.
- A slot that would be sent more than 30 minutes late (the server was asleep) is dropped, never sent. The following slots are not affected.

### Push payload

Same shape and the same `data.type` and Android channel as the on-time reminder of that item, so existing routing opens the right screen.

| | Todo | Checklist |
| --- | --- | --- |
| `notification.title` | the todo title (newlines removed, whitespace collapsed, at most 60 characters including a trailing `…`) | the checklist title (same rules) |
| `notification.body` | `⏰ Quá giờ 10:00 · Làm ngay hoặc dời lịch!` (10:00 = the time the todo was set for) | `⏰ Quá giờ 07:30 · Làm ngay hoặc dời lịch!` (07:30 = today's time of the occurrence, override applied) |
| `data.type` | `todo` | `checklist_due` |
| `data.id` | todo id | checklist id |
| `data.date` | `YYYY-MM-DD` of the todo | `YYYY-MM-DD` of today |
| Android channel | `todo_reminders` | `checklist_reminders` |

All `data` values are strings. Priority `high`, FCM `ttl` 1 hour. Sent to every device of the user.

"Dời lịch" in the copy means the existing actions: change the todo's time/day, or override the checklist's time for the day.

## 2. Evening review (`digest_review`)

A daily push that asks the user to review today's todos and habits and plan tomorrow. It is a fourth daily digest next to the morning, todo and habit ones (those are unchanged: the habit summary still goes out at the evening time + 30 minutes).

- Default time **21:30**, editable (see the setting below).
- Always sent, even when today has no todos or habits.
- Not sent if it would be more than 1 hour late.

Payload:

```json
{
  "notification": {
    "title": "Rà soát cuối ngày",
    "body": "📋 Hôm nay: 3/5 todo xong · 2/3 thói quen\n🌙 Rà lại phần chưa xong & lên kế hoạch cho ngày mai để tiến bộ hơn nhé!"
  },
  "data": { "type": "digest_review", "id": "2026-06-20", "date": "2026-06-20" }
}
```

- Line 1 counts today's top-level todos (done/total, archived ones excluded) and the habits that apply today. A part with nothing to count is left out, and with nothing at all the line is left out entirely.
- Line 2 is one of three sentences: unfinished items remain; everything is done (`Tuyệt vời! Lên kế hoạch cho ngày mai để tiến bộ hơn nữa nhé!`); the day was empty (`Hôm nay chưa có todo hay thói quen. Lên kế hoạch cho ngày mai nhé!`).
- Android channel: `daily_digest` (the same as the other digests). Priority `high`, FCM `ttl` 1 hour.
- **New `data.type`: `digest_review`.** Suggested handling: open today's overview, or the planner for tomorrow. The existing digest types are untouched.

## 3. Settings API

`GET /api/v1/notification-settings` now also returns `reviewTime`:

```json
{
  "morningTime": "07:00",
  "eveningTime": "17:00",
  "habitSummaryTime": "17:30",
  "reviewTime": "21:30",
  "timezone": "Asia/Ho_Chi_Minh"
}
```

`PUT /api/v1/notification-settings` accepts an optional `reviewTime` (`HH:mm`):

```json
{ "morningTime": "07:00", "eveningTime": "17:00", "reviewTime": "22:00", "timezone": "Asia/Ho_Chi_Minh" }
```

- Leaving `reviewTime` out keeps the stored value, so older app versions do not reset it.
- An invalid value (`25:00`, `9:30`, `21:30:00`, `null`) is `400 { "error": "bad_input", "issues": [...] }`.
- There is no relation to `eveningTime`; `habitSummaryTime` is still `eveningTime + 30 min` (capped at 23:59) and read-only.
- Saving moves today's and tomorrow's pending review pushes; a review that was already sent is not repeated.

## Verification

- `npx tsc --noEmit` is clean; `npm test` passes (new files: `tests/overdue-nudges.test.ts`, `tests/evening-review.test.ts`, `tests/migration-0018.test.ts`).
- Migration `0018_overdue_nudges_and_review.sql` adds `notification_settings.review_time` (default `21:30`) and rebuilds `notification_jobs` so its `kind` CHECK accepts `todo_overdue`, `checklist_overdue` and `digest_review`. Existing jobs and settings are kept. Apply it with `npm run db:migrate` **before** deploying the code, because the new code inserts the new kinds.
- Manual send: `npm run notify:job-test -- <userId> todo_overdue|checklist_overdue|digest_review` (then `--cleanup`).

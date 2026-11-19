# Step 0:

git clone https://github.com/tiendcgch210915/Todo_Note

# Step 1:

## 1.1.

npm install fastify @fastify/cors @fastify/sensible dotenv

## 1.2.

npm install @libsql/client

## 1.3.

npm install @fastify/jwt @fastify/helmet @fastify/rate-limit bcrypt

## 1.4.

npm install @fastify/view ejs @fastify/static @fastify/formbody

## 1.5.

npm install zod

## 1.6.

npm install --save-dev pino-pretty

## 1.7

npm install --save-dev typescript @types/node @types/bcrypt tsx

# Step 2:

npm run db:migrate

## Recurring todo reminder times

The Dashboard, timeline, and Todos page use `PATCH /api/v1/todos/:id` with the selected occurrence ID. For a recurring todo, ask **“Which reminders should use the new time?”** before saving. Live Dashboard rows expose `is_recurring`. Timeline and Todo rows expose `recurrence_type` and `recurrence_template_id`.

| Choice | Request body | Effect |
| --- | --- | --- |
| Today only | `{"time":"10:15","time_scope":"this"}` | Changes the selected day's reminder. Other days keep their times. |
| All occurrences | `{"time":"10:15","time_scope":"all"}` | Changes the selected reminder, other unfinished occurrences, and the default for future occurrences. Completed history is preserved. |

Use **This occurrence only** when viewing a different local date. Sending `time: null` removes the reminder with the same scope. Standalone todos accept a time change directly.

An actual recurring time change without a scope returns HTTP 409 with `error: "time_scope_required"` and a `prompt` containing the message and labeled options. The edit is saved when the client resubmits it with the chosen `time_scope`. Dismissing the prompt requires no request.

Offline clients send the same fields in a `todo` update to `POST /api/v1/sync/push`. A missing choice returns the same error and prompt on that operation. On sync pull, display `time` for the occurrence and use `recurrence_time` (including null) when generating its successor. Apply migration `0030_todo_series_reminder_times.sql` before deploying the backend.

/**
 * Trạng thái đếm ngược của todo, chỉ để phục vụ thông báo "hết giờ". App vẫn là nơi đếm giờ;
 * server chỉ ghi lại và hẹn một job gửi tới ĐÚNG thiết bị đang đếm.
 */
import { TIMER } from "../config/notification-policy.js";
import * as jobsRepo from "../repositories/notification-jobs.js";
import * as devicesRepo from "../repositories/notifications.js";
import * as timersRepo from "../repositories/todo-timers.js";
import * as todosRepo from "../repositories/todos.js";
import type { TodoTimerInput } from "../schemas/api/todos.js";

export class TimerServiceError extends Error {
  constructor(public code: "not_found" | "device_not_found" | "todo_completed") {
    super(code);
  }
}

export type TimerState = {
  todo_id: string;
  status: timersRepo.TimerStatus;
  remaining_seconds: number | null;
  estimated_seconds: number | null;
  ends_at: string | null;
  device_id: string | null;
  /** true = sự kiện cũ/không áp dụng được, trạng thái giữ nguyên. */
  ignored: boolean;
};

const toState = (
  todoId: string,
  row: timersRepo.TimerRow | null,
  ignored: boolean
): TimerState => ({
  todo_id: todoId,
  status: row?.status ?? "idle",
  remaining_seconds: row?.remaining_seconds ?? null,
  estimated_seconds: row?.estimated_seconds ?? null,
  ends_at: row?.ends_at ?? null,
  device_id: row?.device_id ?? null,
  ignored,
});

const isLive = (status: string): boolean =>
  status === "open" || status === "in_progress";

export const applyTimerEvent = async (
  userId: string,
  todoId: string,
  input: TodoTimerInput,
  now: Date = new Date()
): Promise<TimerState> => {
  const todo = await todosRepo.getTodoByIdScoped(todoId, userId);
  if (!todo) throw new TimerServiceError("not_found");

  const nowMs = now.getTime();
  const existing = await timersRepo.getTimer(todoId);

  // Đồng hồ máy lệch về tương lai không được khóa mọi sự kiện sau đó.
  let eventMs = Date.parse(input.clientEventAt);
  if (eventMs > nowMs + TIMER.futureSkewMs) eventMs = nowMs;

  // Chặn sự kiện cũ gửi lại muộn (hàng đợi gửi lại của app).
  if (
    existing?.last_client_event_at &&
    eventMs <= Date.parse(existing.last_client_event_at)
  ) {
    return toState(todoId, existing, true);
  }
  const lastClientEventAt = new Date(eventMs).toISOString();

  const save = async (
    fields: Partial<Omit<timersRepo.TimerRow, "todo_id" | "user_id" | "updated_at">> &
      Pick<timersRepo.TimerRow, "status">
  ): Promise<timersRepo.TimerRow> => {
    const row = {
      todo_id: todoId,
      user_id: userId,
      estimated_seconds: existing?.estimated_seconds ?? null,
      remaining_seconds: null,
      ends_at: null,
      device_id: null,
      ...fields,
      last_client_event_at: lastClientEventAt,
    };
    await timersRepo.upsertTimer(row);
    return { ...row, updated_at: now.toISOString() };
  };

  switch (input.action) {
    case "start":
    case "resume": {
      if (!isLive(todo.status)) throw new TimerServiceError("todo_completed");

      // Không tìm thấy thiết bị thì báo lỗi rõ ràng và KHÔNG tạo job.
      const device = await devicesRepo.findDeviceByRegistration(
        userId,
        input.registrationId ?? ""
      );
      if (!device) throw new TimerServiceError("device_not_found");

      // Sự kiện đến muộn quá ngưỡng: trừ phần độ trễ khỏi thời gian còn lại.
      const delayMs = nowMs - eventMs;
      let remaining = Math.round(input.remainingSeconds ?? 0);
      if (delayMs > TIMER.lateEventThresholdMs) {
        remaining = Math.max(0, remaining - Math.round(delayMs / 1000));
      }

      const estimated =
        input.action === "start"
          ? Math.round(input.estimatedSeconds ?? 0) || null
          : existing?.estimated_seconds ??
            (input.estimatedSeconds ? Math.round(input.estimatedSeconds) : null) ??
            (todo.estimated_minutes ? todo.estimated_minutes * 60 : null);

      if (remaining <= 0) {
        // Đã quá hạn: không hẹn job, đánh dấu finished.
        await jobsRepo.cancelEventJobs("todo_timer_end", [todoId]);
        const row = await save({
          status: "finished",
          estimated_seconds: estimated,
          remaining_seconds: 0,
        });
        return toState(todoId, row, false);
      }

      const endsAt = new Date(nowMs + remaining * 1000).toISOString();
      // Mỗi todo chỉ một job; start/resume trên máy khác chuyển đích sang máy mới.
      await jobsRepo.upsertEventJob({
        userId,
        kind: "todo_timer_end",
        refId: todoId,
        runAt: endsAt,
        targetDeviceId: device.id,
      });
      const row = await save({
        status: "running",
        estimated_seconds: estimated,
        remaining_seconds: remaining,
        ends_at: endsAt,
        device_id: device.id,
      });
      return toState(todoId, row, false);
    }

    case "pause": {
      if (!existing || existing.status !== "running") {
        return toState(todoId, existing, true);
      }
      await jobsRepo.cancelEventJobs("todo_timer_end", [todoId]);
      const row = await save({
        status: "paused",
        remaining_seconds: Math.round(input.remainingSeconds ?? 0),
        device_id: existing.device_id,
      });
      return toState(todoId, row, false);
    }

    case "stop": {
      await jobsRepo.cancelEventJobs("todo_timer_end", [todoId]);
      const row = await save({ status: "idle" });
      return toState(todoId, row, false);
    }

    case "finish": {
      await jobsRepo.cancelEventJobs("todo_timer_end", [todoId]);
      const row = await save({ status: "finished", remaining_seconds: 0 });
      return toState(todoId, row, false);
    }
  }
};

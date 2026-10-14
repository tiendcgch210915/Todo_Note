/**
 * Móc tạo/hủy job gắn vào MỌI đường ghi dữ liệu (REST, sync push, admin).
 *
 * Quy tắc:
 *  - KHÔNG BAO GIỜ throw: lỗi ở đây không được làm hỏng thao tác ghi của người dùng.
 *  - Log chỉ có id/loại thao tác, không bao giờ có tên todo hay nội dung.
 *  - Hook chỉ là đường nhanh. Độ đúng cuối cùng nằm ở bước kiểm tra lại ngay trước khi gửi
 *    (notification-tick) và bước vá todo thiếu job (notification-planner).
 */
import {
  CHECKLIST_REMINDER_AFTER_MS,
  LATENESS_MS,
} from "../config/notification-policy.js";
import * as jobsRepo from "../repositories/notification-jobs.js";
import * as settingsRepo from "../repositories/notification-settings.js";
import * as sourcesRepo from "../repositories/notification-sources.js";
import * as timersRepo from "../repositories/todo-timers.js";
import * as todosRepo from "../repositories/todos.js";
import { localDateTimeToUtc } from "../utils/time.js";
import { pushLogger } from "./push-logger.js";
import {
  reconcileAllChecklistDue,
  reconcileChecklistDue,
} from "./checklist-due.js";
import { finishSchedulesForUserSafely } from "./checklist-schedule-expiry.js";
import { recomputePendingDigests, planUser } from "./notification-planner.js";
import { resolveSettings } from "./notification-schedule.js";
import { reconcileAllTodoOverdue, reconcileTodoOverdue } from "./overdue-nudges.js";

const safely = async (op: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (error) {
    pushLogger.error(
      {
        op,
        errorName: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      "notification trigger failed"
    );
  }
};

const isLive = (status: string): boolean =>
  status === "open" || status === "in_progress";

/**
 * Hủy nhắc giờ + nhắc lặp + đếm ngược của các todo; `dropTimerRows` xóa hẳn trạng thái đếm
 * ngược.
 */
const clearTodoArtifacts = async (
  todoIds: readonly string[],
  dropTimerRows: boolean
): Promise<void> => {
  await jobsRepo.cancelEventJobs("todo_reminder", todoIds);
  await jobsRepo.cancelEventJobs("todo_overdue", todoIds);
  await jobsRepo.cancelEventJobs("todo_timer_end", todoIds);
  if (dropTimerRows) {
    await timersRepo.deleteTimers(todoIds);
  } else {
    for (const id of todoIds) await timersRepo.resetTimerIdle(id);
  }
};

/**
 * Gọi sau MỌI thay đổi của một todo (tạo, sửa, dời ngày, hoàn thành, bỏ hoàn thành, hồi sinh
 * bản lặp, sync). Đọc trạng thái hiện tại rồi tạo/sửa/hủy job nhắc giờ và nhắc lặp cho khớp.
 */
export const onTodoChanged = (userId: string, todoId: string): Promise<void> =>
  safely("todo_changed", async () => {
    const todo = await todosRepo.getTodoByIdScoped(todoId, userId);
    if (!todo) {
      // Đã xóa (hoặc không thuộc người dùng): dọn nhắc giờ và đếm ngược.
      await clearTodoArtifacts([todoId], true);
      return;
    }

    if (!isLive(todo.status)) {
      // Hoàn thành / cất đi: hết nhắc giờ, đếm ngược về idle (giữ mốc thứ tự sự kiện).
      await clearTodoArtifacts([todo.id], false);
      return;
    }

    if (!todo.time || !todo.scheduled_date || todo.parent_id !== null) {
      await jobsRepo.cancelEventJobs("todo_reminder", [todo.id]);
      await jobsRepo.cancelEventJobs("todo_overdue", [todo.id]);
      return;
    }

    const ctx = await settingsRepo.getUserContext(userId);
    const { timezone } = resolveSettings(
      ctx ?? { timezone: null, morning_time: null, evening_time: null }
    );

    // Nhắc lặp tính trước: nó cần cả khi giờ hẹn đã qua (đó chính là lúc bắt đầu nhắc), còn nhắc
    // đúng giờ bên dưới thì chỉ dành cho giờ ở tương lai và có thể return sớm.
    await safely("todo_overdue_changed", () =>
      reconcileTodoOverdue(userId, todo, timezone)
    );

    const runAt = localDateTimeToUtc(todo.scheduled_date, todo.time, timezone);
    if (runAt.getTime() <= Date.now()) {
      // Chỉ nhắc giờ ở TƯƠNG LAI; giờ đã qua thì bỏ job đang chờ (nếu có).
      await jobsRepo.cancelEventJobs("todo_reminder", [todo.id]);
      return;
    }

    await jobsRepo.upsertEventJob({
      userId,
      kind: "todo_reminder",
      refId: todo.id,
      runAt: runAt.toISOString(),
      localDate: todo.scheduled_date,
    });
  });

/** Todo bị xóa (kể cả xóa lan xuống todo con / cả chuỗi lặp). */
export const onTodosRemoved = (
  _userId: string,
  todoIds: readonly string[]
): Promise<void> =>
  safely("todos_removed", async () => {
    if (todoIds.length === 0) return;
    await clearTodoArtifacts(todoIds, true);
  });

/**
 * Checklist run bắt đầu / hoàn thành / dừng / xóa (REST hoặc sync):
 * đang chạy -> job nhắc sau 30 phút kể từ started_at; ngược lại -> hủy.
 */
export const onChecklistRunChanged = async (
  userId: string,
  runId: string
): Promise<void> => {
  await safely("checklist_run_changed", () => syncChecklist30m(userId, runId));
  // Hoàn thành đúng ngày của lịch KHÔNG lặp thì lịch hết nhiệm vụ: xóa như chưa từng đặt.
  await finishSchedulesForUserSafely(userId);
  // Một run hoàn thành (hoặc bị xóa/hủy) trong ngày đổi việc lần xuất hiện của lịch đã xong hay chưa.
  await safely("checklist_run_due", async () => {
    const templateId = await sourcesRepo.getRunTemplateId(userId, runId);
    if (templateId) await reconcileChecklistDue(userId, templateId);
  });
};

const syncChecklist30m = async (userId: string, runId: string): Promise<void> => {
    const run = await sourcesRepo.getChecklistRunInfo(userId, runId);
    if (!run || run.status !== "in_progress") {
      await jobsRepo.cancelEventJobs("checklist_30m", [runId]);
      return;
    }
    const startedMs = Date.parse(run.started_at);
    if (Number.isNaN(startedMs)) return;
    const runAtMs = startedMs + CHECKLIST_REMINDER_AFTER_MS;
    // Run đồng bộ muộn từ offline: còn trong ngưỡng trễ thì vẫn nhắc, quá thì bỏ.
    if (Date.now() - runAtMs > LATENESS_MS.checklist_30m) return;
    await jobsRepo.upsertEventJob({
      userId,
      kind: "checklist_30m",
      refId: runId,
      runAt: new Date(runAtMs).toISOString(),
    });
};

/**
 * Lịch của một checklist đổi (tạo/sửa/xóa/tắt, ghi đè đổi/xóa), hoặc checklist bị xóa: hủy job
 * `checklist_due` không còn hợp lệ rồi tạo/sửa lại phần còn hợp lệ.
 */
export const onChecklistScheduleChanged = (
  userId: string,
  templateId: string
): Promise<void> =>
  safely("checklist_schedule_changed", () => reconcileChecklistDue(userId, templateId));

/** Đổi múi giờ (API, sync, admin): dời tổng kết chưa gửi và bổ sung job còn thiếu. */
export const onUserSettingsChanged = async (userId: string): Promise<void> => {
  await safely("user_settings_changed", async () => {
    await recomputePendingDigests(userId);
    await planUser(userId);
  });
  // Giờ chạy của job lịch checklist phụ thuộc múi giờ nên cũng phải tính lại.
  await safely("user_settings_checklist_due", () => reconcileAllChecklistDue(userId));
  // Mốc nhắc lặp của todo tính từ giờ hẹn theo múi giờ nên cũng vậy.
  await safely("user_settings_todo_overdue", () => reconcileAllTodoOverdue(userId));
};

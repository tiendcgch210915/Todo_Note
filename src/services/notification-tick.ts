/**
 * Hai đường xử lý, dùng chung một bộ quy tắc an toàn:
 *
 *  - `runDispatch` (ĐƯỜNG NHANH): chỉ lấy job pending đã đến hạn -> kiểm tra trễ -> giành quyền
 *    nguyên tử -> kiểm tra lại điều kiện -> gửi -> ghi kết quả. Nhẹ, chạy mỗi vài giây.
 *  - `runMaintenance` (PLANNER + DỌN DẸP): trả job kẹt về hàng đợi, tạo tổng kết hôm nay/ngày mai,
 *    vá nhắc giờ còn thiếu, đánh `missed` hàng loạt, xóa job cũ. Chạy mỗi 60 giây.
 *  - `runTick` = maintenance rồi dispatch. Đây là thứ POST /internal/notifications/tick gọi,
 *    nên endpoint vẫn làm đủ cả hai việc (dự phòng + catch-up khi instance vừa thức dậy).
 *
 * Nhiều lần chạy song song (nhiều tiến trình, tick ngoài + vòng trong) vẫn an toàn vì mỗi job
 * chỉ một bên giành được.
 */
import {
  CHANNEL_ID,
  DATA_TYPE,
  DISPATCH,
  JOB_RETENTION_MS,
  LATENESS_MS,
  NOTIFICATION_KINDS,
  TTL_MS,
  type NotificationJobKind,
} from "../config/notification-policy.js";
import * as dashboardRepo from "../repositories/dashboard.js";
import * as jobsRepo from "../repositories/notification-jobs.js";
import * as settingsRepo from "../repositories/notification-settings.js";
import * as sourcesRepo from "../repositories/notification-sources.js";
import * as devicesRepo from "../repositories/notifications.js";
import * as timersRepo from "../repositories/todo-timers.js";
import * as todosRepo from "../repositories/todos.js";
import { localDateOf, localDateTimeToUtc } from "../utils/time.js";
import { isPushConfigured, pushLogger, type PushLogger } from "./firebase.js";
import {
  buildChecklist30m,
  buildHabitsDigest,
  buildMorningDigest,
  buildTimerEnd,
  buildTodoReminder,
  buildTodosDigest,
  type DigestStats,
  type NotificationText,
} from "./notification-content.js";
import {
  backfillTodoReminders,
  planAllUsers,
} from "./notification-planner.js";
import { resolveSettings } from "./notification-schedule.js";
import { notifyUser } from "./notifications.js";

export type TickOptions = {
  now?: Date;
  /** true = chỉ ghi log, không gọi FCM (job vẫn được đánh `sent`). */
  dryRun?: boolean;
  maxJobs?: number;
  logger?: PushLogger;
};

/** Chỉ có số đếm: không chứa dữ liệu cá nhân. */
export type TickSummary = {
  dry_run: boolean;
  /** true = FCM chưa cấu hình nên không động vào job nào. */
  push_disabled: boolean;
  planned: number;
  backfilled: number;
  recovered: number;
  stuck_failed: number;
  missed: number;
  purged: number;
  claimed: number;
  lost_claims: number;
  sent: number;
  cancelled: number;
  retried: number;
  failed: number;
};

type Outcome = "sent" | "cancelled" | "retried" | "failed";

type Prepared =
  | { cancel: true }
  | {
      cancel?: false;
      text: NotificationText;
      /** data.id */
      id: string;
      /** data.date */
      date: string;
      /** Chạy sau khi gửi thành công. */
      afterSent?: () => Promise<void>;
    };

const CANCEL: Prepared = { cancel: true };

const isLive = (status: string): boolean =>
  status === "open" || status === "in_progress";

const digestStats = async (
  userId: string,
  localDate: string
): Promise<DigestStats> => {
  const [todos, habits] = await Promise.all([
    dashboardRepo.listDayTopLevelStats(userId, localDate),
    dashboardRepo.countDayHabits(userId, localDate),
  ]);
  return {
    totalTodos: todos.length,
    doneTodos: todos.filter((todo) => todo.status === "done").length,
    habitsTotal: habits.total,
    habitsDone: habits.completed,
  };
};

/**
 * Kiểm tra lại điều kiện NGAY TRƯỚC KHI gửi và dựng nội dung từ dữ liệu hiện tại.
 * Không khớp -> hủy, không gửi.
 */
const prepare = async (job: jobsRepo.JobRow): Promise<Prepared> => {
  const ctx = await settingsRepo.getUserContext(job.user_id);
  if (!ctx || !ctx.active) return CANCEL;
  const settings = resolveSettings(ctx);
  const runAtMs = Date.parse(job.run_at);
  const date = job.local_date ?? localDateOf(new Date(runAtMs), settings.timezone);

  switch (job.kind) {
    case "todo_reminder": {
      if (!job.ref_id) return CANCEL;
      const todo = await todosRepo.getTodoByIdScoped(job.ref_id, job.user_id);
      if (
        !todo ||
        !isLive(todo.status) ||
        todo.parent_id !== null ||
        !todo.time ||
        !todo.scheduled_date
      ) {
        return CANCEL;
      }
      // Giờ nhắc đã bị sửa sau khi job được tạo -> job này lỗi thời.
      const expected = localDateTimeToUtc(
        todo.scheduled_date,
        todo.time,
        settings.timezone
      );
      if (expected.getTime() !== runAtMs) return CANCEL;
      return { text: buildTodoReminder(todo.title), id: todo.id, date };
    }

    case "todo_timer_end": {
      if (!job.ref_id || !job.target_device_id) return CANCEL;
      const todo = await todosRepo.getTodoByIdScoped(job.ref_id, job.user_id);
      if (!todo || !isLive(todo.status)) return CANCEL;
      const timer = await timersRepo.getTimer(job.ref_id);
      if (
        !timer ||
        timer.user_id !== job.user_id ||
        timer.status !== "running" ||
        !timer.ends_at ||
        Date.parse(timer.ends_at) !== runAtMs
      ) {
        return CANCEL;
      }
      // Thiết bị đích đã bị xóa (đăng xuất/dọn) -> hủy, KHÔNG gửi sang máy khác.
      const device = await devicesRepo.getUserDevice(
        job.user_id,
        job.target_device_id
      );
      if (!device) return CANCEL;
      const endsAt = timer.ends_at;
      return {
        text: buildTimerEnd(todo.title, timer.estimated_seconds),
        id: todo.id,
        date,
        afterSent: () => timersRepo.markTimerFinished(todo.id, endsAt),
      };
    }

    case "checklist_30m": {
      if (!job.ref_id) return CANCEL;
      const run = await sourcesRepo.getChecklistRunInfo(job.user_id, job.ref_id);
      if (!run || run.status !== "in_progress") return CANCEL;
      const text = buildChecklist30m(
        run.name ?? run.template_title ?? "Checklist",
        run.pending_steps
      );
      return text ? { text, id: run.id, date } : CANCEL;
    }

    case "digest_morning": {
      const stats = await digestStats(job.user_id, date);
      return { text: buildMorningDigest(stats, date), id: date, date };
    }

    case "digest_todos": {
      const text = buildTodosDigest(await digestStats(job.user_id, date));
      return text ? { text, id: date, date } : CANCEL;
    }

    case "digest_habits": {
      const text = buildHabitsDigest(await digestStats(job.user_id, date));
      return text ? { text, id: date, date } : CANCEL;
    }
  }
};

/** Kết thúc một lần thử thất bại tạm thời: thử lại nếu còn lượt, hết lượt thì `failed`. */
const settleTransientFailure = async (
  job: jobsRepo.JobRow,
  attempts: number
): Promise<Outcome> => {
  if (attempts >= DISPATCH.maxAttempts) {
    await jobsRepo.markTerminal(job.id, job.run_at, "failed");
    return "failed";
  }
  await jobsRepo.releaseForRetry(job.id, job.run_at);
  return "retried";
};

/**
 * Một dòng log có cấu trúc cho MỖI job đã gửi, dùng để đo độ trễ thật:
 *  - claim_delay_ms = locked_at - run_at  (thời gian job chờ tới lượt vòng lặp)
 *  - fcm_ms         = thời gian gọi FCM    (null khi chạy thử NOTIFY_DRY_RUN)
 *  - lag_ms         = sent_at - run_at     (độ trễ tổng so với giờ hẹn)
 * Chỉ có id job, loại và số liệu thời gian: không tên todo, không registrationId, không user_id.
 */
const logSent = (
  logger: PushLogger,
  job: jobsRepo.JobRow,
  sentAt: string,
  fcmMs: number | null
): void => {
  const runAtMs = Date.parse(job.run_at);
  logger.info(
    {
      job_id: job.id,
      kind: job.kind,
      run_at: job.run_at,
      locked_at: job.locked_at,
      sent_at: sentAt,
      fcm_ms: fcmMs,
      lag_ms: Date.parse(sentAt) - runAtMs,
      claim_delay_ms: job.locked_at ? Date.parse(job.locked_at) - runAtMs : null,
      attempts: job.attempts,
      ...(fcmMs === null ? { dry_run: true } : {}),
    },
    "notification sent"
  );
};

const processClaimed = async (
  claimed: jobsRepo.JobRow,
  options: { dryRun: boolean; logger: PushLogger }
): Promise<Outcome> => {
  // `claimed` đã ở trạng thái processing (attempts đã được tăng khi giành quyền).
  const attempts = claimed.attempts;
  try {
    const prepared = await prepare(claimed);
    if (prepared.cancel) {
      await jobsRepo.markTerminal(claimed.id, claimed.run_at, "cancelled");
      return "cancelled";
    }

    if (options.dryRun) {
      const sentAt = new Date().toISOString();
      await jobsRepo.markSent(claimed.id, claimed.run_at, sentAt);
      logSent(options.logger, claimed, sentAt, null);
      await prepared.afterSent?.();
      return "sent";
    }

    const fcmStartedAt = performance.now();
    const result = await notifyUser(
      claimed.user_id,
      {
        title: prepared.text.title,
        body: prepared.text.body,
        data: {
          type: DATA_TYPE[claimed.kind],
          id: prepared.id,
          date: prepared.date,
        },
      },
      {
        // Có đích thì CHỈ gửi thiết bị đó; không có cơ chế quay về gửi tất cả.
        targetDeviceId: claimed.target_device_id,
        channelId: CHANNEL_ID[claimed.kind],
        ttlMs: TTL_MS[claimed.kind],
      }
    );

    const fcmMs = Math.round(performance.now() - fcmStartedAt);
    if (result.sent > 0) {
      const sentAt = new Date().toISOString();
      await jobsRepo.markSent(claimed.id, claimed.run_at, sentAt);
      logSent(options.logger, claimed, sentAt, fcmMs);
      await prepared.afterSent?.();
      return "sent";
    }
    // notifyUser báo lỗi nội bộ bằng error (kèm devices = 0): đó là lỗi tạm, không phải "hết thiết bị".
    if (result.error) return settleTransientFailure(claimed, attempts);
    if (result.devices === 0 || result.removed >= result.devices) {
      // Không còn thiết bị nào để gửi (hoặc tất cả đều đã chết và bị xóa).
      await jobsRepo.markTerminal(claimed.id, claimed.run_at, "cancelled");
      return "cancelled";
    }
    return settleTransientFailure(claimed, attempts);
  } catch (error) {
    options.logger.error(
      {
        jobId: claimed.id,
        kind: claimed.kind,
        errorName: error instanceof Error ? error.name : "unknown",
      },
      "notification job crashed"
    );
    try {
      return await settleTransientFailure(claimed, attempts);
    } catch {
      return "failed"; // sẽ được khôi phục bởi bước xử lý job kẹt ở lần tick sau
    }
  }
};

const emptySummary = (dryRun: boolean): TickSummary => ({
  dry_run: dryRun,
  push_disabled: false,
  planned: 0,
  backfilled: 0,
  recovered: 0,
  stuck_failed: 0,
  missed: 0,
  purged: 0,
  claimed: 0,
  lost_claims: 0,
  sent: 0,
  cancelled: 0,
  retried: 0,
  failed: 0,
});

/**
 * PLANNER + DỌN DẸP. Mọi bước idempotent; ghi nhiều nên KHÔNG chạy mỗi vài giây.
 */
const maintain = async (
  options: TickOptions,
  summary: TickSummary
): Promise<void> => {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();

  // 0. Job kẹt ở processing (tiến trình chết giữa chừng).
  const stuck = await jobsRepo.recoverStuckJobs(
    new Date(nowMs - DISPATCH.stuckAfterMs).toISOString(),
    DISPATCH.maxAttempts
  );
  summary.recovered = stuck.requeued;
  summary.stuck_failed = stuck.failed;

  // 1. Lập lịch (idempotent): tổng kết hôm nay/ngày mai + vá nhắc giờ todo thiếu job.
  summary.planned = await planAllUsers(now);
  summary.backfilled = await backfillTodoReminders(now);

  // 2. Chính sách trễ (quét hàng loạt): job pending chạy muộn quá ngưỡng thì bỏ, KHÔNG gửi.
  //    Đường nhanh cũng tự kiểm tra từng ứng viên nên không phụ thuộc bước này.
  const cutoffs = Object.fromEntries(
    NOTIFICATION_KINDS.map((kind) => [
      kind,
      new Date(nowMs - LATENESS_MS[kind]).toISOString(),
    ])
  ) as Record<NotificationJobKind, string>;
  summary.missed += await jobsRepo.markMissed(cutoffs);

  // Dọn job đã kết thúc từ lâu để bảng không phình mãi.
  summary.purged = await jobsRepo.purgeFinishedJobs(
    new Date(nowMs - JOB_RETENTION_MS).toISOString()
  );
};

/**
 * ĐƯỜNG NHANH. Chỉ một SELECT nhẹ (chỉ mục idx_notification_jobs_due) khi không có gì đến hạn;
 * không có câu lệnh ghi nào cho tới khi có job để giành quyền.
 */
const dispatchDue = async (
  options: TickOptions,
  summary: TickSummary
): Promise<void> => {
  const dryRun = options.dryRun ?? false;
  const logger = options.logger ?? pushLogger;

  // FCM chưa cấu hình: để nguyên job (ngưỡng trễ sẽ tự dọn) thay vì đốt hết lượt thử.
  if (!dryRun && !isPushConfigured()) {
    summary.push_disabled = true;
    return;
  }

  // Lấy ứng viên, rồi giành quyền từng job bằng một câu UPDATE nguyên tử.
  const selectedAt = options.now ?? new Date();
  const candidates = await jobsRepo.listDueCandidates(
    selectedAt.toISOString(),
    new Date(selectedAt.getTime() - DISPATCH.retrySpacingMs).toISOString(),
    DISPATCH.maxAttempts,
    Math.min(options.maxJobs ?? DISPATCH.batchSize, DISPATCH.batchSize)
  );

  const handle = async (candidate: jobsRepo.JobRow): Promise<void> => {
    // Giờ THẬT lúc giành quyền (locked_at), để log đo claim_delay_ms chính xác.
    const claimAt = options.now ?? new Date();

    // Chính sách trễ: quá ngưỡng thì đánh missed, KHÔNG gửi (ví dụ sau khi khởi động lại).
    if (claimAt.getTime() - Date.parse(candidate.run_at) > LATENESS_MS[candidate.kind]) {
      if (await jobsRepo.markPendingMissed(candidate.id)) summary.missed++;
      return;
    }

    if (!(await jobsRepo.claimJob(candidate.id, claimAt.toISOString()))) {
      summary.lost_claims++; // tick khác đã giành trước
      return;
    }
    summary.claimed++;
    // Đọc lại sau khi giành quyền: run_at/đích có thể vừa bị sửa.
    const claimed = await jobsRepo.getJobById(candidate.id);
    if (!claimed || claimed.status !== "processing") return;
    const outcome = await processClaimed(claimed, { dryRun, logger });
    summary[outcome]++;
  };

  // Xử lý có giới hạn song song.
  for (let i = 0; i < candidates.length; i += DISPATCH.concurrency) {
    await Promise.all(candidates.slice(i, i + DISPATCH.concurrency).map(handle));
  }
};

/** Đường nhanh: chỉ gửi job đến hạn. */
export const runDispatch = async (
  options: TickOptions = {}
): Promise<TickSummary> => {
  const summary = emptySummary(options.dryRun ?? false);
  await dispatchDue(options, summary);
  return summary;
};

/** Planner + dọn dẹp, không gửi gì. */
export const runMaintenance = async (
  options: TickOptions = {}
): Promise<TickSummary> => {
  const summary = emptySummary(options.dryRun ?? false);
  await maintain(options, summary);
  return summary;
};

/** Cả hai đường theo thứ tự cũ (maintenance rồi dispatch): hợp đồng của endpoint tick. */
export const runTick = async (
  options: TickOptions = {}
): Promise<TickSummary> => {
  const summary = emptySummary(options.dryRun ?? false);
  await maintain(options, summary);
  await dispatchDue(options, summary);
  return summary;
};

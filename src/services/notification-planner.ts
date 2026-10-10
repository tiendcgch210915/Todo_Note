/**
 * Lập lịch job (không gửi gì cả). Mọi hàm ở đây idempotent: chạy lại bao nhiêu lần cũng không
 * tạo trùng nhờ chỉ mục unique của notification_jobs.
 */
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  DIGEST_KINDS,
  DISPATCH,
  LATENESS_MS,
} from "../config/notification-policy.js";
import * as jobsRepo from "../repositories/notification-jobs.js";
import * as settingsRepo from "../repositories/notification-settings.js";
import { addDays, isValidTimeZone, localDateOf, localDateTimeToUtc } from "../utils/time.js";
import { digestRunAt, resolveSettings } from "./notification-schedule.js";

/** Tổng kết hôm nay và ngày mai (theo múi giờ người dùng) cho một người dùng. */
const digestJobsFor = (
  ctx: settingsRepo.UserNotificationContext,
  now: Date
): jobsRepo.DigestJobInput[] => {
  const settings = resolveSettings(ctx);
  const today = localDateOf(now, settings.timezone);
  const jobs: jobsRepo.DigestJobInput[] = [];
  for (const localDate of [today, addDays(today, 1)]) {
    for (const kind of DIGEST_KINDS) {
      const runAt = digestRunAt(kind, localDate, settings);
      // Đã trễ quá ngưỡng cho phép: không tạo (gửi muộn còn tệ hơn không gửi).
      if (now.getTime() - runAt.getTime() > LATENESS_MS[kind]) continue;
      jobs.push({
        userId: ctx.user_id,
        kind,
        localDate,
        runAt: runAt.toISOString(),
      });
    }
  }
  return jobs;
};

/** Chỉ giữ các job chưa có dòng nào (đọc một lần cho cả lô, rồi mới ghi phần thiếu). */
const insertMissingDigests = async (
  users: settingsRepo.UserNotificationContext[],
  now: Date
): Promise<number> => {
  const wanted = users.flatMap((ctx) => digestJobsFor(ctx, now));
  if (wanted.length === 0) return 0;
  const existing = await jobsRepo.listExistingDigestKeys(
    [...new Set(wanted.map((job) => job.userId))],
    [...new Set(wanted.map((job) => job.localDate))]
  );
  const missing = wanted.filter(
    (job) => !existing.has(`${job.userId}|${job.kind}|${job.localDate}`)
  );
  // The unique index still guards against a concurrent tick inserting the same rows.
  return jobsRepo.insertDigestJobs(missing);
};

/** Bảo đảm đủ 3 tổng kết cho hôm nay + ngày mai cho một người dùng. Trả số job mới tạo. */
export const planUser = async (
  userId: string,
  now: Date = new Date()
): Promise<number> => {
  const ctx = await settingsRepo.getUserContext(userId);
  if (!ctx || !ctx.active) return 0;
  return insertMissingDigests([ctx], now);
};

/** Mỗi tick: lập lịch tổng kết cho mọi người dùng còn hoạt động có thiết bị. */
export const planAllUsers = async (now: Date = new Date()): Promise<number> => {
  let created = 0;
  let afterId = "";
  for (;;) {
    const users = await settingsRepo.listPlannerUsers(
      afterId,
      DISPATCH.plannerChunkSize
    );
    if (users.length === 0) break;
    created += await insertMissingDigests(users, now);
    afterId = users[users.length - 1].user_id;
    if (users.length < DISPATCH.plannerChunkSize) break;
  }
  return created;
};

/**
 * Khi người dùng đổi giờ/múi giờ: dời run_at của các tổng kết CHƯA gửi tại chỗ.
 * (Hủy rồi tạo lại sẽ vướng chỉ mục unique vì dòng cũ vẫn còn.)
 */
export const recomputePendingDigests = async (
  userId: string
): Promise<number> => {
  const ctx = await settingsRepo.getUserContext(userId);
  if (!ctx) return 0;
  const settings = resolveSettings(ctx);
  let changed = 0;
  for (const job of await jobsRepo.listPendingDigestJobs(userId)) {
    if (job.local_date === null) continue;
    const kind = job.kind as (typeof DIGEST_KINDS)[number];
    const runAt = digestRunAt(kind, job.local_date, settings).toISOString();
    if (runAt !== job.run_at && (await jobsRepo.updatePendingRunAt(job.id, runAt))) {
      changed++;
    }
  }
  return changed;
};

/**
 * Lưới an toàn cho nhắc giờ todo: tạo job cho todo có giờ nhắc mà chưa có dòng job nào
 * (todo có trước khi có hệ thống job, hoặc một đường ghi bị sót hook). Thời điểm đã qua
 * được ghi `missed` để lần tick sau không xét lại.
 */
export const backfillTodoReminders = async (
  now: Date = new Date()
): Promise<number> => {
  // Ngày địa phương nhỏ nhất của mọi múi giờ là (ngày UTC - 1).
  const fromDate = addDays(now.toISOString().slice(0, 10), -1);
  const todos = await jobsRepo.listTodosMissingReminderJobs(
    fromDate,
    DISPATCH.backfillBatchSize
  );
  let created = 0;
  for (const todo of todos) {
    const timezone = isValidTimeZone(todo.timezone)
      ? todo.timezone
      : DEFAULT_NOTIFICATION_SETTINGS.timezone;
    const runAt = localDateTimeToUtc(todo.scheduled_date, todo.time, timezone);
    const inserted = await jobsRepo.insertEventJobIfAbsent({
      userId: todo.user_id,
      kind: "todo_reminder",
      refId: todo.id,
      runAt: runAt.toISOString(),
      status: runAt.getTime() > now.getTime() ? "pending" : "missed",
      localDate: todo.scheduled_date,
    });
    if (inserted) created++;
  }
  return created;
};

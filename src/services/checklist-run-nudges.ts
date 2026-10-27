/**
 * Nhắc khi một checklist đã "bắt đầu" (run `in_progress`) mà chưa hoàn thành:
 *
 *  - mỗi 1 giờ kể từ lúc bắt đầu (+1h, +2h, ...) cho tới hết ngày địa phương của lúc bắt đầu;
 *  - sang ngày mới thì KHÔNG nhắc theo giờ nữa, chỉ MỘT lần lúc 06:00 sáng hôm sau để báo
 *    checklist hôm qua vẫn chưa xong, rồi dừng.
 *
 * Ví dụ bắt đầu 12:15 -> 13:15, 14:15, ..., 23:15 -> (hôm sau) 06:00.
 *
 * Giống nhắc lặp quá giờ: mỗi mốc là MỘT dòng job (`checklist_running`, unique theo
 * user/kind/ref_id/run_at, ref_id = id của run) nên một mốc bị lỡ (server ngủ) không làm đứt các
 * mốc sau. Module này KHÔNG import env/firebase để dùng được trong test không có cấu hình.
 *
 *  - hook (`reconcileChecklistRunNudges`): run đổi -> hủy mốc thừa, upsert mốc còn hợp lệ;
 *  - planner (`backfillChecklistRunNudges`): vá run chưa có dòng nào (run có trước tính năng);
 *  - kiểm tra lại ngay trước khi gửi (`findRunNudge` trong notification-tick).
 */
import {
  CHECKLIST_RUNNING,
  DEFAULT_NOTIFICATION_SETTINGS,
  DISPATCH,
  LATENESS_MS,
} from "../config/notification-policy.js";
import * as jobsRepo from "../repositories/notification-jobs.js";
import * as settingsRepo from "../repositories/notification-settings.js";
import * as sourcesRepo from "../repositories/notification-sources.js";
import { addDays, isValidTimeZone, localDateOf, localDateTimeToUtc } from "../utils/time.js";
import { resolveSettings } from "./notification-schedule.js";

// ── Hàm thuần ────────────────────────────────────────────────────────────────

export type RunNudge =
  | { kind: "hourly"; at: Date; /** Số giờ từ lúc bắt đầu tới mốc này (1, 2, ...). */ hours: number }
  | { kind: "carryover"; at: Date };

/**
 * Mọi mốc nhắc của một run bắt đầu lúc `startedAt`: các mốc theo giờ còn rơi trong CÙNG ngày địa
 * phương của lúc bắt đầu, cộng mốc 06:00 sáng hôm sau. Bắt đầu 23:30 thì không có mốc theo giờ nào.
 */
export const runNudgeSlots = (startedAt: Date, timezone: string): RunNudge[] => {
  const date = localDateOf(startedAt, timezone);
  const slots: RunNudge[] = [];
  for (let hours = 1; hours <= CHECKLIST_RUNNING.maxSlotsPerDay; hours++) {
    const at = new Date(startedAt.getTime() + hours * CHECKLIST_RUNNING.intervalMs);
    if (localDateOf(at, timezone) !== date) break;
    slots.push({ kind: "hourly", at, hours });
  }
  slots.push({
    kind: "carryover",
    at: localDateTimeToUtc(addDays(date, 1), CHECKLIST_RUNNING.carryoverTime, timezone),
  });
  return slots;
};

/** Ngày địa phương của lúc bắt đầu: `local_date` của mọi dòng job thuộc run đó. */
export const runLocalDate = (startedAt: Date, timezone: string): string =>
  localDateOf(startedAt, timezone);

/**
 * `runAt` có đúng là một mốc nhắc của run (bắt đầu lúc `startedAt`) không? Trả về mốc đó để dựng
 * nội dung, hoặc null nếu giờ bắt đầu hay múi giờ đã đổi sau khi job được tạo (job lỗi thời).
 */
export const findRunNudge = (
  startedAt: Date,
  runAt: Date,
  timezone: string
): RunNudge | null =>
  runNudgeSlots(startedAt, timezone).find((slot) => slot.at.getTime() === runAt.getTime()) ??
  null;

/** Bỏ các mốc đã quá ngưỡng trễ: gửi muộn còn tệ hơn không gửi. Mốc tương lai được giữ. */
export const creatableRunNudges = (slots: readonly RunNudge[], now: Date): RunNudge[] =>
  slots.filter((slot) => now.getTime() - slot.at.getTime() <= LATENESS_MS.checklist_running);

// ── Hook: tính lại mốc nhắc của MỘT run ──────────────────────────────────────

/**
 * Gọi sau mọi thay đổi của một run (bắt đầu, hoàn thành, dừng, xóa; REST hoặc sync). Run không còn
 * `in_progress` thì hủy hết mốc đang chờ.
 */
export const reconcileChecklistRunNudges = async (
  userId: string,
  runId: string,
  now: Date = new Date()
): Promise<void> => {
  const run = await sourcesRepo.getChecklistRunInfo(userId, runId);
  if (!run || run.status !== "in_progress") {
    await jobsRepo.cancelSlotJobsExcept(userId, "checklist_running", runId, []);
    return;
  }
  const startedAt = new Date(Date.parse(run.started_at));
  if (Number.isNaN(startedAt.getTime())) return;

  const ctx = await settingsRepo.getUserContext(userId);
  const { timezone } = resolveSettings(
    ctx ?? { timezone: null, morning_time: null, evening_time: null }
  );
  const date = runLocalDate(startedAt, timezone);
  const slots = creatableRunNudges(runNudgeSlots(startedAt, timezone), now).map((slot) =>
    slot.at.toISOString()
  );

  // Hủy phần thừa trước, rồi upsert phần cần: không có lúc nào mốc hợp lệ bị hủy tạm.
  await jobsRepo.cancelSlotJobsExcept(userId, "checklist_running", runId, slots);
  for (const runAt of slots) {
    await jobsRepo.upsertSlotJob({
      userId,
      kind: "checklist_running",
      refId: runId,
      localDate: date,
      runAt,
    });
  }
};

/** Đổi múi giờ: ngày địa phương và mốc 06:00 đổi theo nên tính lại mọi run đang chạy. */
export const reconcileAllChecklistRunNudges = async (
  userId: string,
  now: Date = new Date()
): Promise<void> => {
  const since = new Date(now.getTime() - CHECKLIST_RUNNING.backfillWindowMs).toISOString();
  for (const runId of await sourcesRepo.listInProgressRunIds(userId, since)) {
    await reconcileChecklistRunNudges(userId, runId, now);
  }
};

// ── Planner: vá run chưa có mốc nào ──────────────────────────────────────────

/**
 * Lưới an toàn: tạo mốc nhắc cho run đang chạy nhưng chưa có dòng nào (run có trước tính năng, hoặc
 * một đường ghi bị sót hook). Nếu không còn mốc nào tạo được (đã quá ngưỡng trễ) thì ghi một dòng
 * `missed` làm dấu để lần quét sau không xét lại run đó mãi.
 */
export const backfillChecklistRunNudges = async (now: Date = new Date()): Promise<number> => {
  const since = new Date(now.getTime() - CHECKLIST_RUNNING.backfillWindowMs).toISOString();
  const runs = await jobsRepo.listRunsMissingNudgeJobs(since, DISPATCH.backfillBatchSize);
  let created = 0;
  for (const run of runs) {
    const startedAt = new Date(Date.parse(run.started_at));
    if (Number.isNaN(startedAt.getTime())) continue;
    const timezone = isValidTimeZone(run.timezone)
      ? run.timezone
      : DEFAULT_NOTIFICATION_SETTINGS.timezone;
    const date = runLocalDate(startedAt, timezone);
    const all = runNudgeSlots(startedAt, timezone);
    const slots = creatableRunNudges(all, now);

    if (slots.length === 0) {
      await jobsRepo.insertSlotJobIfAbsent({
        userId: run.user_id,
        kind: "checklist_running",
        refId: run.id,
        localDate: date,
        runAt: all[all.length - 1].at.toISOString(),
        status: "missed",
      });
      continue;
    }
    for (const slot of slots) {
      const inserted = await jobsRepo.insertSlotJobIfAbsent({
        userId: run.user_id,
        kind: "checklist_running",
        refId: run.id,
        localDate: date,
        runAt: slot.at.toISOString(),
        status: "pending",
      });
      if (inserted) created++;
    }
  }
  return created;
};

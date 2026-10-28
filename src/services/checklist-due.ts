/**
 * Job `checklist_due`: nhắc đúng giờ một checklist theo lịch. Mỗi (checklist, ngày địa phương) có
 * tối đa MỘT job, giờ chạy lấy từ lần xuất hiện của lịch (đã áp ghi đè) đổi sang UTC theo
 * `users.timezone`. Module này KHÔNG import env/firebase để các service nghiệp vụ dùng được trong
 * test không có cấu hình.
 *
 * Ba nơi cùng dùng một logic để không thể lệch nhau:
 *  - hook (`reconcileChecklistDue`): lịch/ghi đè/run/múi giờ đổi -> hủy phần thừa, upsert phần cần;
 *  - planner (`planChecklistDueForUsers`): bổ sung job còn thiếu cho hôm nay + ngày mai;
 *  - kiểm tra lại ngay trước khi gửi (`checkDueForSend`).
 *
 * Checklist chỉ nhắc MỘT lần đúng giờ hẹn của mỗi lần xuất hiện: KHÔNG có nhắc lặp quá giờ (loại
 * `checklist_overdue` cũ đã bỏ, xem `LEGACY_SLOT_KINDS`). Lịch lặp hằng ngày thì mỗi ngày có đúng
 * một job của riêng ngày đó; lịch không lặp thì chỉ một job duy nhất.
 */
import { LATENESS_MS } from "../config/notification-policy.js";
import * as schedulesRepo from "../repositories/checklist-schedules.js";
import * as templatesRepo from "../repositories/checklist-templates.js";
import * as jobsRepo from "../repositories/notification-jobs.js";
import * as settingsRepo from "../repositories/notification-settings.js";
import { addDays, localDateOf, localDateTimeToUtc } from "../utils/time.js";
import { dayBoundsUtc, doneDatesOf, loadDoneDates } from "./checklist-occurrence-done.js";
import {
  occurrencesBetween,
  toScheduleRule,
  type ScheduleOverride,
  type ScheduleRule,
} from "./checklist-schedule.js";
import { resolveSettings } from "./notification-schedule.js";

export type DueSlot = {
  templateId: string;
  /** Ngày địa phương YYYY-MM-DD. */
  date: string;
  /** Giờ địa phương HH:mm (đã áp ghi đè). */
  time: string;
  runAt: Date;
};

/**
 * HÀM THUẦN: lần xuất hiện trong [from, to] chưa xong (xem `doneDatesOf`), kèm thời điểm UTC để gửi.
 */
export const dueSlotsFor = (
  rule: ScheduleRule,
  overrides: readonly ScheduleOverride[],
  doneDates: ReadonlySet<string>,
  timezone: string,
  from: string,
  to: string
): DueSlot[] =>
  occurrencesBetween(rule, overrides, from, to)
    .filter((occurrence) => !doneDates.has(occurrence.date))
    .map((occurrence) => ({
      templateId: occurrence.checklistId,
      date: occurrence.date,
      time: occurrence.time,
      runAt: localDateTimeToUtc(occurrence.date, occurrence.time, timezone),
    }));

/** Bỏ các slot đã quá hạn trễ: gửi muộn còn tệ hơn không gửi. */
export const creatableSlots = (slots: readonly DueSlot[], now: Date): DueSlot[] =>
  slots.filter((slot) => now.getTime() - slot.runAt.getTime() <= LATENESS_MS.checklist_due);

const toOverrides = (
  rows: readonly schedulesRepo.OverrideRow[]
): ScheduleOverride[] => rows.map((row) => ({ localDate: row.local_date, time: row.time }));

// ── Hook: tính lại job của MỘT checklist ─────────────────────────────────────

export const reconcileChecklistDue = async (
  userId: string,
  templateId: string,
  now: Date = new Date()
): Promise<void> => {
  const ctx = await settingsRepo.getUserContext(userId);
  if (!ctx) return;
  const { timezone } = resolveSettings(ctx);
  const today = localDateOf(now, timezone);
  const tomorrow = addDays(today, 1);

  let slots: DueSlot[] = [];
  if (ctx.active) {
    const [schedule, template] = await Promise.all([
      schedulesRepo.getLiveSchedule(userId, templateId),
      templatesRepo.getTemplateForUser(templateId, userId),
    ]);
    if (schedule && template) {
      const overrides = (
        await schedulesRepo.listLiveOverridesForUsers([userId], today, tomorrow)
      ).filter((row) => row.template_id === templateId);
      const open = dueSlotsFor(
        toScheduleRule(schedule),
        toOverrides(overrides),
        await loadDoneDates(userId, templateId, today, tomorrow, timezone),
        timezone,
        today,
        tomorrow
      );
      slots = creatableSlots(open, now);
    }
  }

  // Hủy phần không còn hợp lệ trước, rồi upsert phần cần: không có lúc nào job hợp lệ bị hủy tạm.
  await jobsRepo.cancelOccurrenceJobsExcept(
    userId,
    "checklist_due",
    templateId,
    slots.map((slot) => slot.date)
  );
  for (const slot of slots) {
    await jobsRepo.upsertOccurrenceJob({
      userId,
      kind: "checklist_due",
      refId: templateId,
      localDate: slot.date,
      runAt: slot.runAt.toISOString(),
    });
  }
};

/** Đổi múi giờ: tính lại mọi checklist có lịch của người dùng. */
export const reconcileAllChecklistDue = async (
  userId: string,
  now: Date = new Date()
): Promise<void> => {
  const schedules = await schedulesRepo.listLiveSchedulesForUsers([userId]);
  for (const schedule of schedules) {
    await reconcileChecklistDue(userId, schedule.template_id, now);
  }
};

// ── Planner: bổ sung job còn thiếu cho một lô người dùng ─────────────────────

/**
 * Chỉ ghi khi cần: chưa có dòng, hoặc dòng đang pending/cancelled mà lệch giờ / đã bị hủy trong
 * khi lẽ ra còn hợp lệ. Trạng thái ổn định = 1 lần đọc mỗi lô, 0 lần ghi. Trả số dòng đã ghi.
 */
export const planChecklistDueForUsers = async (
  users: readonly settingsRepo.UserNotificationContext[],
  now: Date = new Date()
): Promise<number> => {
  const active = users.filter((user) => user.active);
  if (active.length === 0) return 0;

  const schedules = await schedulesRepo.listLiveSchedulesForUsers(active.map((u) => u.user_id));
  if (schedules.length === 0) return 0;

  type Frame = { timezone: string; today: string; tomorrow: string };
  const frames = new Map<string, Frame>();
  for (const user of active) {
    const { timezone } = resolveSettings(user);
    const today = localDateOf(now, timezone);
    frames.set(user.user_id, { timezone, today, tomorrow: addDays(today, 1) });
  }

  const userIds = [...new Set(schedules.map((s) => s.user_id))];
  const allFrames = userIds.map((id) => frames.get(id) as Frame);
  const minDate = allFrames.reduce((m, f) => (f.today < m ? f.today : m), allFrames[0].today);
  const maxDate = allFrames.reduce((m, f) => (f.tomorrow > m ? f.tomorrow : m), allFrames[0].tomorrow);
  const bounds = allFrames.map((f) => dayBoundsUtc(f.today, f.tomorrow, f.timezone));
  const fromIso = bounds.reduce((m, b) => (b.fromIso < m ? b.fromIso : m), bounds[0].fromIso);
  const toIso = bounds.reduce((m, b) => (b.toIso > m ? b.toIso : m), bounds[0].toIso);

  const [overrideRows, runs, marks, existing] = await Promise.all([
    schedulesRepo.listLiveOverridesForUsers(userIds, minDate, maxDate),
    schedulesRepo.listCompletedRunsStartedBetween(userIds, fromIso, toIso),
    schedulesRepo.listLiveMarksForUsers(userIds, minDate, maxDate),
    jobsRepo.listOccurrenceJobsForUsers(userIds, "checklist_due", [
      ...new Set(allFrames.flatMap((f) => [f.today, f.tomorrow])),
    ]),
  ]);

  const existingByKey = new Map(
    existing.map((job) => [`${job.user_id}|${job.ref_id}|${job.local_date}`, job])
  );

  let written = 0;
  for (const schedule of schedules) {
    const frame = frames.get(schedule.user_id) as Frame;
    const overrides = toOverrides(
      overrideRows.filter(
        (row) => row.user_id === schedule.user_id && row.template_id === schedule.template_id
      )
    );
    const done = doneDatesOf(
      { userId: schedule.user_id, templateId: schedule.template_id },
      runs,
      marks,
      frame.timezone
    );
    const open = dueSlotsFor(
      toScheduleRule(schedule),
      overrides,
      done,
      frame.timezone,
      frame.today,
      frame.tomorrow
    );
    const slots = creatableSlots(open, now);

    for (const slot of slots) {
      const runAt = slot.runAt.toISOString();
      const row = existingByKey.get(`${schedule.user_id}|${slot.templateId}|${slot.date}`);
      const needsWrite =
        !row ||
        row.status === "cancelled" ||
        (row.status === "pending" && row.run_at !== runAt);
      if (!needsWrite) continue;
      await jobsRepo.upsertOccurrenceJob({
        userId: schedule.user_id,
        kind: "checklist_due",
        refId: slot.templateId,
        localDate: slot.date,
        runAt,
      });
      written++;
    }
  }
  return written;
};

// ── Kiểm tra lại ngay trước khi gửi ──────────────────────────────────────────

export type DueCheck = {
  template: templatesRepo.TemplateRow;
  stepCount: number;
  time: string;
};

export type OpenOccurrence = DueCheck & {
  /** Thời điểm UTC của giờ hẹn (đã áp ghi đè theo ngày). */
  scheduledAt: Date;
};

/**
 * Lần xuất hiện của (checklist, ngày) có đang "còn chờ" không: checklist còn tồn tại, lịch bật và
 * còn hiệu lực cho đúng ngày đó (trong start..end, đúng thứ), và chưa xong trong
 * ngày (xem `doneDatesOf`: tính theo giờ bắt đầu, có tính dấu tay). Không thì null. Dùng cho `checklist_due`.
 */
export const checkOccurrenceOpen = async (
  userId: string,
  templateId: string,
  date: string,
  timezone: string
): Promise<OpenOccurrence | null> => {
  const [schedule, template] = await Promise.all([
    schedulesRepo.getLiveSchedule(userId, templateId),
    templatesRepo.getTemplateForUser(templateId, userId),
  ]);
  if (!schedule || !template) return null;

  const overrides = (await schedulesRepo.listLiveOverridesForUsers([userId], date, date)).filter(
    (row) => row.template_id === templateId
  );
  const [occurrence] = occurrencesBetween(toScheduleRule(schedule), toOverrides(overrides), date, date);
  if (!occurrence) return null;
  const scheduledAt = localDateTimeToUtc(date, occurrence.time, timezone);

  if ((await loadDoneDates(userId, templateId, date, date, timezone)).has(date)) return null;

  const steps = await schedulesRepo.countStepsByTemplate([templateId]);
  return { template, stepCount: steps.get(templateId) ?? 0, time: occurrence.time, scheduledAt };
};

/**
 * Điều kiện để gửi `checklist_due`: lần xuất hiện còn chờ (xem `checkOccurrenceOpen`) và giờ
 * hẹn hiện tại khớp đúng `runAtIso`. Không khớp -> null (job bị hủy, không gửi).
 */
export const checkDueForSend = async (
  userId: string,
  templateId: string,
  date: string,
  timezone: string,
  runAtIso: string
): Promise<DueCheck | null> => {
  const open = await checkOccurrenceOpen(userId, templateId, date, timezone);
  if (!open || open.scheduledAt.getTime() !== Date.parse(runAtIso)) return null;
  return open;
};

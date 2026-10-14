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
 * Cùng module còn lo job nhắc LẶP `checklist_overdue` (giờ hẹn + 2h, +4h, ... trong ngày, khi
 * checklist hôm nay vẫn chưa có run hoàn thành). Chỉ lập cho HÔM NAY: mốc đầu của ngày mai
 * cách nửa đêm ít nhất 2 giờ nên planner kịp lập khi sang ngày.
 */
import { LATENESS_MS } from "../config/notification-policy.js";
import * as schedulesRepo from "../repositories/checklist-schedules.js";
import * as templatesRepo from "../repositories/checklist-templates.js";
import * as jobsRepo from "../repositories/notification-jobs.js";
import * as settingsRepo from "../repositories/notification-settings.js";
import { addDays, localDateOf, localDateTimeToUtc } from "../utils/time.js";
import {
  occurrencesBetween,
  toScheduleRule,
  type ScheduleOverride,
  type ScheduleRule,
} from "./checklist-schedule.js";
import { resolveSettings } from "./notification-schedule.js";
import { creatableOverdueSlots, overdueSlots } from "./overdue-nudges.js";

export type DueSlot = {
  templateId: string;
  /** Ngày địa phương YYYY-MM-DD. */
  date: string;
  /** Giờ địa phương HH:mm (đã áp ghi đè). */
  time: string;
  runAt: Date;
};

/** Ngày địa phương của các run đã hoàn thành. */
export const completedLocalDates = (
  completedAts: readonly string[],
  timezone: string
): Set<string> => {
  const dates = new Set<string>();
  for (const iso of completedAts) {
    const at = new Date(iso);
    if (!Number.isNaN(at.getTime())) dates.add(localDateOf(at, timezone));
  }
  return dates;
};

/** HÀM THUẦN: lần xuất hiện trong [from, to] chưa có run hoàn thành, kèm thời điểm UTC để gửi. */
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

/** [00:00 của from, 00:00 của (to + 1 ngày)) theo múi giờ, dạng ISO UTC. */
export const dayBoundsUtc = (
  from: string,
  to: string,
  timezone: string
): { fromIso: string; toIso: string } => ({
  fromIso: localDateTimeToUtc(from, "00:00", timezone).toISOString(),
  toIso: localDateTimeToUtc(addDays(to, 1), "00:00", timezone).toISOString(),
});

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
  /** Hôm nay: giờ hẹn của lần xuất hiện CHƯA xong (kể cả đã trễ), để nhắc lặp tính từ đó. */
  let todaySlot: DueSlot | undefined;
  if (ctx.active) {
    const [schedule, template] = await Promise.all([
      schedulesRepo.getLiveSchedule(userId, templateId),
      templatesRepo.getTemplateForUser(templateId, userId),
    ]);
    if (schedule && template) {
      const overrides = (
        await schedulesRepo.listLiveOverridesForUsers([userId], today, tomorrow)
      ).filter((row) => row.template_id === templateId);
      const { fromIso, toIso } = dayBoundsUtc(today, tomorrow, timezone);
      const runs = await schedulesRepo.listCompletedRuns([userId], fromIso, toIso, [templateId]);
      const open = dueSlotsFor(
        toScheduleRule(schedule),
        toOverrides(overrides),
        completedLocalDates(runs.map((run) => run.completed_at), timezone),
        timezone,
        today,
        tomorrow
      );
      slots = creatableSlots(open, now);
      todaySlot = open.find((slot) => slot.date === today);
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

  // Nhắc lặp: hôm nay chưa xong thì mỗi 2 giờ sau giờ hẹn; xong rồi (hoặc lịch mất) thì hủy hết.
  const overdue = todaySlot
    ? creatableOverdueSlots(
        overdueSlots(todaySlot.runAt, today, timezone),
        "checklist_overdue",
        now
      ).map((slot) => slot.toISOString())
    : [];
  await jobsRepo.cancelSlotJobsExcept(userId, "checklist_overdue", templateId, overdue);
  for (const runAt of overdue) {
    await jobsRepo.upsertSlotJob({
      userId,
      kind: "checklist_overdue",
      refId: templateId,
      localDate: today,
      runAt,
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

  const [overrideRows, runs, existing, existingOverdue] = await Promise.all([
    schedulesRepo.listLiveOverridesForUsers(userIds, minDate, maxDate),
    schedulesRepo.listCompletedRuns(userIds, fromIso, toIso),
    jobsRepo.listOccurrenceJobsForUsers(userIds, "checklist_due", [
      ...new Set(allFrames.flatMap((f) => [f.today, f.tomorrow])),
    ]),
    jobsRepo.listSlotJobKeys(userIds, "checklist_overdue", [
      ...new Set(allFrames.map((f) => f.today)),
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
    const done = completedLocalDates(
      runs
        .filter((run) => run.user_id === schedule.user_id && run.template_id === schedule.template_id)
        .map((run) => run.completed_at),
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

    // Nhắc lặp của hôm nay: chỉ thêm mốc còn thiếu (hook mới là nơi hủy/đặt lại mốc đã có).
    const todaySlot = open.find((slot) => slot.date === frame.today);
    if (todaySlot) {
      for (const at of creatableOverdueSlots(
        overdueSlots(todaySlot.runAt, frame.today, frame.timezone),
        "checklist_overdue",
        now
      )) {
        const runAt = at.toISOString();
        if (existingOverdue.has(`${schedule.user_id}|${schedule.template_id}|${runAt}`)) continue;
        const inserted = await jobsRepo.insertSlotJobIfAbsent({
          userId: schedule.user_id,
          kind: "checklist_overdue",
          refId: schedule.template_id,
          localDate: frame.today,
          runAt,
          status: "pending",
        });
        if (inserted) written++;
      }
    }

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
 * còn hiệu lực cho đúng ngày đó (trong start..end, đúng thứ), và chưa có run hoàn thành trong
 * ngày. Không thì null. Dùng chung cho `checklist_due` và `checklist_overdue`.
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

  const { fromIso, toIso } = dayBoundsUtc(date, date, timezone);
  const runs = await schedulesRepo.listCompletedRuns([userId], fromIso, toIso, [templateId]);
  if (completedLocalDates(runs.map((run) => run.completed_at), timezone).has(date)) return null;

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

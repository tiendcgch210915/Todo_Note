/**
 * Lịch checklist theo từng người dùng: tạo/sửa/xóa/tắt lịch, đổi giờ một ngày (ghi đè), và danh
 * sách các lần xuất hiện. `occurrencesBetween` (checklist-schedule.ts) là nguồn sự thật duy nhất
 * cho việc mở rộng lịch; GET /checklists/occurrences và job thông báo đều đi qua nó.
 */
import * as schedulesRepo from "../repositories/checklist-schedules.js";
import * as templatesRepo from "../repositories/checklist-templates.js";
import * as settingsRepo from "../repositories/notification-settings.js";
import { addDays, localDateTimeToUtc } from "../utils/time.js";
import {
  isOccurrenceDate,
  occurrencesBetween,
  toScheduleRule,
} from "./checklist-schedule.js";
import { completedLocalDates } from "./checklist-due.js";
import { finishSchedulesForUserSafely } from "./checklist-schedule-expiry.js";
import { resolveSettings } from "./notification-schedule.js";
import * as notificationTriggers from "./notification-triggers.js";

export class ScheduleServiceError extends Error {
  constructor(public code: "not_found" | "not_an_occurrence") {
    super(code);
  }
}

/** Dạng trả về cho app (cùng tên trường với lịch trong sync). */
export type ScheduleView = {
  id: string;
  template_id: string;
  start_date: string;
  time: string;
  recurrence_type: schedulesRepo.ScheduleRow["recurrence_type"];
  recurrence_interval: number | null;
  recurrence_days_of_week: string | null;
  recurrence_end_date: string | null;
  enabled: boolean;
  /** Đang/sắp tạm dừng trong [paused_from, paused_until] (cả hai đầu tính); cùng null = không. */
  paused_from: string | null;
  paused_until: string | null;
  created_at: string;
  updated_at: string;
};

export const toScheduleView = (row: schedulesRepo.ScheduleRow): ScheduleView => ({
  id: row.id,
  template_id: row.template_id,
  start_date: row.start_date,
  time: row.time,
  recurrence_type: row.recurrence_type,
  recurrence_interval: row.recurrence_interval,
  recurrence_days_of_week: row.recurrence_days_of_week,
  recurrence_end_date: row.recurrence_end_date,
  enabled: row.enabled === 1,
  paused_from: row.paused_from,
  paused_until: row.paused_until,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

/** Checklist phải tồn tại và nhìn thấy được với người dùng (của họ hoặc mẫu hệ thống). */
const requireVisibleTemplate = async (
  userId: string,
  templateId: string
): Promise<templatesRepo.TemplateRow> => {
  const template = await templatesRepo.getTemplateForUser(templateId, userId);
  if (!template) throw new ScheduleServiceError("not_found");
  return template;
};

export const getSchedule = async (
  userId: string,
  templateId: string
): Promise<ScheduleView> => {
  await requireVisibleTemplate(userId, templateId);
  await finishSchedulesForUserSafely(userId);
  const row = await schedulesRepo.getLiveSchedule(userId, templateId);
  if (!row) throw new ScheduleServiceError("not_found");
  return toScheduleView(row);
};

/** Dùng cho GET /templates/:id: lịch của người dùng hoặc null. */
export const findScheduleView = async (
  userId: string,
  templateId: string
): Promise<ScheduleView | null> => {
  const row = await schedulesRepo.getLiveSchedule(userId, templateId);
  return row ? toScheduleView(row) : null;
};

export const putSchedule = async (
  userId: string,
  templateId: string,
  fields: schedulesRepo.ScheduleFields
): Promise<ScheduleView> => {
  await requireVisibleTemplate(userId, templateId);
  const row = await schedulesRepo.upsertSchedule(userId, templateId, fields);
  await notificationTriggers.onChecklistScheduleChanged(userId, templateId);
  return toScheduleView(row);
};

/** Idempotent: xóa lịch chưa có cũng là thành công (client offline có thể gửi lại). */
export const deleteSchedule = async (
  userId: string,
  templateId: string
): Promise<void> => {
  await requireVisibleTemplate(userId, templateId);
  await schedulesRepo.softDeleteSchedule(userId, templateId);
  await notificationTriggers.onChecklistScheduleChanged(userId, templateId);
};

export type OccurrenceItem = {
  checklistId: string;
  title: string;
  stepCount: number;
  date: string;
  time: string;
  overridden: boolean;
  done: boolean;
};

/** GET /checklists/occurrences: các lần xuất hiện của mọi lịch đang bật trong [from, to]. */
export const listOccurrences = async (
  userId: string,
  from: string,
  to: string
): Promise<OccurrenceItem[]> => {
  await finishSchedulesForUserSafely(userId);
  const ctx = await settingsRepo.getUserContext(userId);
  const { timezone } = resolveSettings(
    ctx ?? { timezone: null, morning_time: null, evening_time: null }
  );

  const schedules = await schedulesRepo.listLiveSchedulesForUsers([userId]);
  if (schedules.length === 0) return [];
  const templateIds = schedules.map((s) => s.template_id);

  const [overrideRows, runs, steps] = await Promise.all([
    schedulesRepo.listLiveOverridesForUsers([userId], from, to),
    schedulesRepo.listCompletedRuns(
      [userId],
      localDateTimeToUtc(from, "00:00", timezone).toISOString(),
      localDateTimeToUtc(addDays(to, 1), "00:00", timezone).toISOString()
    ),
    schedulesRepo.countStepsByTemplate(templateIds),
  ]);

  const items: OccurrenceItem[] = [];
  for (const schedule of schedules) {
    const overrides = overrideRows
      .filter((row) => row.template_id === schedule.template_id)
      .map((row) => ({ localDate: row.local_date, time: row.time }));
    const done = completedLocalDates(
      runs.filter((run) => run.template_id === schedule.template_id).map((run) => run.completed_at),
      timezone
    );
    for (const occurrence of occurrencesBetween(toScheduleRule(schedule), overrides, from, to)) {
      items.push({
        checklistId: schedule.template_id,
        title: schedule.template_title,
        stepCount: steps.get(schedule.template_id) ?? 0,
        date: occurrence.date,
        time: occurrence.time,
        overridden: occurrence.overridden,
        done: done.has(occurrence.date),
      });
    }
  }
  items.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.time.localeCompare(b.time) ||
      a.title.localeCompare(b.title)
  );
  return items;
};

/** PUT /checklists/templates/:id/occurrences/:date. Ngày phải thật sự là một lần xuất hiện. */
export const putOccurrence = async (
  userId: string,
  templateId: string,
  date: string,
  time: string
): Promise<{ checklistId: string; date: string; time: string; overridden: true }> => {
  await requireVisibleTemplate(userId, templateId);
  const schedule = await schedulesRepo.getLiveSchedule(userId, templateId);
  if (!schedule) throw new ScheduleServiceError("not_found");
  if (!isOccurrenceDate(toScheduleRule(schedule), date)) {
    throw new ScheduleServiceError("not_an_occurrence");
  }
  await schedulesRepo.upsertOverride(userId, templateId, date, time);
  await notificationTriggers.onChecklistScheduleChanged(userId, templateId);
  return { checklistId: templateId, date, time, overridden: true };
};

/** Idempotent. Không kiểm tra ngày còn thuộc lịch: ghi đè mồ côi vẫn phải xóa được. */
export const deleteOccurrence = async (
  userId: string,
  templateId: string,
  date: string
): Promise<void> => {
  await requireVisibleTemplate(userId, templateId);
  await schedulesRepo.softDeleteOverride(userId, templateId, date);
  await notificationTriggers.onChecklistScheduleChanged(userId, templateId);
};

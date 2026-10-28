/**
 * Dọn lịch checklist đã "xong": lịch bị xóa hẳn (xóa mềm cùng các ghi đè giờ của nó), nên màn
 * hình chi tiết của checklist trở về như chưa từng đặt lịch ("Nhắc theo lịch" tắt, không còn lịch
 * nào hiển thị). Hai trường hợp, quy tắc thuần nằm ở `scheduleFinishReason`:
 *  - qua ngày kết thúc (đúng 00:00 ngày kế tiếp theo múi giờ người dùng);
 *  - lịch KHÔNG lặp mà checklist đã xong đúng vào ngày của lịch (`isDoneOn`: tính theo giờ bắt đầu
 *    của lần chạy, hoặc người dùng đánh dấu tay "Đã xong").
 *
 * Ba nơi gọi, cùng một logic:
 *  - `expireChecklistSchedules`: quét định kỳ (maintenance, mỗi 60 giây) mọi người dùng, kể cả
 *    người không có thiết bị, vì lịch hiển thị trong app không phụ thuộc thông báo;
 *  - `finishSchedulesForUser`: ngay khi một lần chạy checklist đổi (hook) và trước khi đọc lịch
 *    qua REST, để màn chi tiết không bao giờ thấy một lịch đã xong dù lần quét chưa tới.
 * Cả hai đều hủy luôn job `checklist_due` còn chờ của lịch vừa xóa.
 *
 * Module này KHÔNG import env/firebase để dùng được trong test không có cấu hình.
 */
import * as schedulesRepo from "../repositories/checklist-schedules.js";
import * as settingsRepo from "../repositories/notification-settings.js";
import { localDateOf } from "../utils/time.js";
import { reconcileChecklistDue } from "./checklist-due.js";
import { isDoneOn } from "./checklist-occurrence-done.js";
import {
  effectiveEndDate,
  scheduleFinishReason,
  toScheduleRule,
} from "./checklist-schedule.js";
import { resolveSettings } from "./notification-schedule.js";
import { pushLogger } from "./push-logger.js";

/** Số lịch xử lý tối đa mỗi lần quét (lượng tồn lúc mới triển khai được dọn dần qua các lần quét). */
const SWEEP_BATCH = 500;

/** Xóa lịch rồi hủy job còn chờ của nó. Trả true nếu thật sự có lịch bị xóa. */
const removeSchedule = async (
  userId: string,
  templateId: string,
  now: Date
): Promise<boolean> => {
  const removed = await schedulesRepo.softDeleteSchedule(userId, templateId);
  // Không còn lịch -> reconcile hủy mọi job checklist_due đang chờ.
  await reconcileChecklistDue(userId, templateId, now);
  return removed;
};

/**
 * Xóa các lịch đã xong của MỘT người dùng. Trả số lịch đã xóa.
 * Lịch không lặp chỉ phải tra run khi ngày của nó đã đến (start_date <= hôm nay).
 */
export const finishSchedulesForUser = async (
  userId: string,
  now: Date = new Date()
): Promise<number> => {
  const ctx = await settingsRepo.getUserContext(userId);
  if (!ctx || !ctx.active) return 0;
  const { timezone } = resolveSettings(ctx);
  const today = localDateOf(now, timezone);

  let removed = 0;
  for (const schedule of await schedulesRepo.listLiveSchedulesForUsers([userId])) {
    const rule = toScheduleRule(schedule);
    let reason = scheduleFinishReason(rule, today, false);
    if (reason === null && rule.recurrenceType === null && rule.startDate <= today) {
      const done = await isDoneOn(userId, schedule.template_id, rule.startDate, timezone);
      reason = scheduleFinishReason(rule, today, done);
    }
    if (reason !== null && (await removeSchedule(userId, schedule.template_id, now))) removed++;
  }
  return removed;
};

/**
 * Bản không bao giờ throw, dùng ở đường đọc/hook: dọn lịch chỉ là việc phụ, lỗi ở đây không được
 * làm hỏng thao tác của người dùng. Log chỉ có tên lỗi, không có dữ liệu cá nhân.
 */
export const finishSchedulesForUserSafely = async (
  userId: string,
  now: Date = new Date()
): Promise<void> => {
  try {
    await finishSchedulesForUser(userId, now);
  } catch (error) {
    pushLogger.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "checklist schedule cleanup failed"
    );
  }
};

/**
 * Quét định kỳ: xóa mọi lịch đã qua ngày kết thúc (00:00 ngày kế tiếp theo múi giờ của từng
 * người dùng). Chỉ lịch đã qua hạn mới bị ghi; trạng thái ổn định là một câu SELECT nhẹ.
 * Trả số lịch đã xóa.
 */
export const expireChecklistSchedules = async (now: Date = new Date()): Promise<number> => {
  // Ngày địa phương lớn nhất của mọi múi giờ là (ngày UTC + 1) nên lịch hết hạn chắc chắn có
  // ngày kết thúc <= ngày UTC hôm nay; múi giờ chính xác được kiểm tra lại cho từng lịch.
  const utcToday = now.toISOString().slice(0, 10);
  let removed = 0;
  for (const candidate of await schedulesRepo.listExpiryCandidates(utcToday, SWEEP_BATCH)) {
    const end = effectiveEndDate(toScheduleRule(candidate));
    const { timezone } = resolveSettings({
      timezone: candidate.timezone,
      morning_time: null,
      evening_time: null,
    });
    if (end === null || localDateOf(now, timezone) <= end) continue;
    if (await removeSchedule(candidate.user_id, candidate.template_id, now)) removed++;
  }
  return removed;
};

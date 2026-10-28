/**
 * "Một lần xuất hiện của checklist trong ngày D đã xong chưa" — MỘT quy tắc duy nhất cho mọi nơi
 * cần biết: GET /checklists/occurrences, job `checklist_due` (lập, hủy và kiểm
 * tra lại trước khi gửi), dọn lịch không lặp đã xong, và habit gắn checklist. App Flutter tính
 * cùng quy tắc cục bộ cho timeline (cạnh `lib/utils/checklist_schedule_rules.dart`), nên đổi ở đây
 * phải đổi ở đó.
 *
 *  1. Ngày của một lần chạy là ngày địa phương của `started_at` (KHÔNG phải `completed_at`): bắt
 *     đầu 23:30 ngày 1, xong 00:30 ngày 2 vẫn là xong của ngày 1. Chỉ run `completed` mới tính.
 *  2. Dấu tay của ngày đó (`checklist_occurrence_marks`):
 *       - `done`  -> xong, bất kể các lần chạy;
 *       - `open`  -> chưa xong, TRỪ KHI có một lần chạy của ngày đó hoàn thành SAU thời điểm đánh dấu
 *                    (`updated_at`): làm lại lần nữa thì lại xong;
 *       - không có dấu -> xong nếu có ít nhất một lần chạy hoàn thành (quy tắc 1).
 *
 * Module này KHÔNG import env/firebase để dùng được trong test không có cấu hình.
 */
import * as schedulesRepo from "../repositories/checklist-schedules.js";
import { addDays, localDateOf, localDateTimeToUtc } from "../utils/time.js";

/** Phần của một run mà quy tắc cần. */
export type DoneRun = Pick<
  schedulesRepo.CompletedRun,
  "user_id" | "template_id" | "started_at" | "completed_at"
>;

/** Phần của một dấu tay mà quy tắc cần. */
export type DoneMark = Pick<
  schedulesRepo.MarkRow,
  "user_id" | "template_id" | "local_date" | "status" | "updated_at"
>;

/**
 * HÀM THUẦN: các ngày địa phương đã xong của MỘT checklist của MỘT người dùng. `runs` và `marks`
 * có thể chứa cả của người/checklist khác (truy vấn theo lô): chỉ phần khớp `scope` được tính.
 */
export const doneDatesOf = (
  scope: { userId: string; templateId: string },
  runs: readonly DoneRun[],
  marks: readonly DoneMark[],
  timezone: string
): Set<string> => {
  /** Ngày bắt đầu -> thời điểm hoàn thành muộn nhất trong các run bắt đầu ngày đó (ms). */
  const lastCompletion = new Map<string, number>();
  for (const run of runs) {
    if (run.user_id !== scope.userId || run.template_id !== scope.templateId) continue;
    const startedAt = new Date(run.started_at);
    if (Number.isNaN(startedAt.getTime())) continue;
    const completedMs = Date.parse(run.completed_at);
    const at = Number.isNaN(completedMs) ? startedAt.getTime() : completedMs;
    const date = localDateOf(startedAt, timezone);
    lastCompletion.set(date, Math.max(lastCompletion.get(date) ?? -Infinity, at));
  }

  const done = new Set<string>();
  const marked = new Set<string>();
  for (const mark of marks) {
    if (mark.user_id !== scope.userId || mark.template_id !== scope.templateId) continue;
    marked.add(mark.local_date);
    if (mark.status === "done") {
      done.add(mark.local_date);
    } else if ((lastCompletion.get(mark.local_date) ?? -Infinity) > Date.parse(mark.updated_at)) {
      done.add(mark.local_date);
    }
  }
  for (const date of lastCompletion.keys()) {
    if (!marked.has(date)) done.add(date);
  }
  return done;
};

/** [00:00 của from, 00:00 của (to + 1 ngày)) theo múi giờ, dạng ISO UTC. */
export const dayBoundsUtc = (
  from: string,
  to: string,
  timezone: string
): { fromIso: string; toIso: string } => ({
  fromIso: localDateTimeToUtc(from, "00:00", timezone).toISOString(),
  toIso: localDateTimeToUtc(addDays(to, 1), "00:00", timezone).toISOString(),
});

/** Đọc run + dấu tay trong [from, to] (ngày địa phương) rồi áp quy tắc cho MỘT checklist. */
export const loadDoneDates = async (
  userId: string,
  templateId: string,
  from: string,
  to: string,
  timezone: string
): Promise<Set<string>> => {
  const { fromIso, toIso } = dayBoundsUtc(from, to, timezone);
  const [runs, marks] = await Promise.all([
    schedulesRepo.listCompletedRunsStartedBetween([userId], fromIso, toIso, [templateId]),
    schedulesRepo.listLiveMarksForUsers([userId], from, to, [templateId]),
  ]);
  return doneDatesOf({ userId, templateId }, runs, marks, timezone);
};

/** Ngày địa phương `date` của checklist đã xong chưa. */
export const isDoneOn = async (
  userId: string,
  templateId: string,
  date: string,
  timezone: string
): Promise<boolean> => (await loadDoneDates(userId, templateId, date, date, timezone)).has(date);

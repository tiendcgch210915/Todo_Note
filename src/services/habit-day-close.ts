import * as closeRepo from "../repositories/habit-day-close.js";
import * as usersRepo from "../repositories/users.js";
import {
  addDays,
  daysInRange,
  effectiveTimeZone,
  localDateOf,
  localDateTimeToUtc,
} from "../utils/time.js";
import { pushLogger } from "./push-logger.js";

/**
 * Qua 00h (theo `users.timezone`) mà habit chưa có log thì ghi completed=0 cho ngày vừa qua.
 *
 * Dựa vào CURSOR theo người dùng chứ không so khớp đúng "00:00": instance ngủ qua nửa đêm
 * vẫn tự bù ở lần chạy kế tiếp. Chỉ bù tối đa MAX_CATCHUP_DAYS ngày gần nhất và không backfill
 * lịch sử (người dùng chưa có cursor chỉ được đóng đúng "hôm qua").
 */
export const MAX_CATCHUP_DAYS = 7;

export type CloseUserResult = { days: number; habits: number };

/** Đóng mọi ngày địa phương đã kết thúc mà chưa đóng cho một người dùng. */
export const closeHabitDaysForUser = async (
  userId: string,
  timezone: string,
  now: Date = new Date()
): Promise<CloseUserResult> => {
  const target = addDays(localDateOf(now, effectiveTimeZone(timezone)), -1);
  const cursor = await closeRepo.getCloseCursor(userId);
  if (cursor !== null && cursor >= target) return { days: 0, habits: 0 };

  // Không habit nào thì không có gì để đóng — và không ghi cursor, để người dùng tạo habit
  // sau này không bị coi là "đã đóng" tới một ngày cũ.
  if (!(await closeRepo.userHasLiveHabit(userId))) return { days: 0, habits: 0 };

  const earliest = addDays(target, -(MAX_CATCHUP_DAYS - 1));
  let from = cursor === null ? target : addDays(cursor, 1);
  if (from < earliest) from = earliest;

  const nowIso = now.toISOString();
  let habits = 0;
  const dates = daysInRange(from, target);
  for (const date of dates) {
    habits += await closeRepo.closeHabitDay(userId, date, nowIso);
  }
  return { days: dates.length, habits };
};

export type CloseAllResult = {
  users_checked: number;
  users_closed: number;
  habits: number;
  failed: number;
};

/**
 * Quét mọi người dùng có habit; chỉ làm việc với người dùng mà ngày địa phương đã sang ngày
 * mới kể từ lần đóng trước. Lỗi của một người dùng không chặn những người còn lại.
 */
export const closeHabitDaysForAllUsers = async (
  now: Date = new Date()
): Promise<CloseAllResult> => {
  const candidates = await closeRepo.listCloseCandidateUsers();
  const result: CloseAllResult = {
    users_checked: candidates.length,
    users_closed: 0,
    habits: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    const target = addDays(
      localDateOf(now, effectiveTimeZone(candidate.timezone)),
      -1
    );
    if (candidate.closed_through !== null && candidate.closed_through >= target) {
      continue;
    }
    try {
      const closed = await closeHabitDaysForUser(
        candidate.user_id,
        candidate.timezone,
        now
      );
      if (closed.days > 0) result.users_closed++;
      result.habits += closed.habits;
    } catch (error) {
      result.failed++;
      pushLogger.error(
        {
          op: "habit_day_close",
          errorName: error instanceof Error ? error.name : "unknown",
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        "habit day close failed for user"
      );
    }
  }
  return result;
};

// ── Bản "lazy" cho đường đọc (sync pull, GET /habits) ───────────────────────

// userId -> thời điểm (ms) sớm nhất cần kiểm tra lại = 00h địa phương kế tiếp. Trước mốc đó
// ngày đóng cuối cùng không thể đổi nên bỏ qua hoàn toàn, không tốn truy vấn DB nào.
const nextCheckAt = new Map<string, number>();

export const resetHabitDayCloseMemoForTests = (): void => {
  nextCheckAt.clear();
};

/**
 * Để thiết bị luôn thấy dòng 0 ngay lần pull đầu tiên sau nửa đêm, kể cả khi job nền chưa
 * kịp chạy (instance vừa thức dậy). KHÔNG BAO GIỜ ném lỗi: thất bại chỉ được ghi log và
 * không được làm hỏng request đọc.
 */
export const ensureHabitDaysClosedSafe = async (
  userId: string,
  now: Date = new Date()
): Promise<void> => {
  try {
    const due = nextCheckAt.get(userId);
    if (due !== undefined && now.getTime() < due) return;

    const user = await usersRepo.getUserById(userId);
    if (!user || user.deleted_at) return;
    const timezone = effectiveTimeZone(user.timezone);
    await closeHabitDaysForUser(userId, timezone, now);

    const nextMidnight = localDateTimeToUtc(
      addDays(localDateOf(now, timezone), 1),
      "00:00",
      timezone
    );
    nextCheckAt.set(userId, nextMidnight.getTime());
  } catch (error) {
    pushLogger.error(
      {
        op: "habit_day_close_lazy",
        errorName: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      "lazy habit day close failed"
    );
  }
};

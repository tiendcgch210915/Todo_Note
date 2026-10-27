/**
 * Tạo job thử cho một người dùng, chạy sau ~1 phút, cho từng loại thông báo. Không công khai qua HTTP.
 *
 *   npm run notify:job-test -- <userId>                         # mọi loại (todo_timer_end cần --device)
 *   npm run notify:job-test -- <userId> digest_morning
 *   npm run notify:job-test -- <userId> checklist_due           # checklist có lịch hôm nay, đúng giờ chạy
 *   npm run notify:job-test -- <userId> todo_overdue            # nhắc lặp "Quá giờ" của một todo trễ 2 giờ
 *   npm run notify:job-test -- <userId> checklist_overdue       # nhắc lặp "Quá giờ" của một checklist trễ 2 giờ
 *   npm run notify:job-test -- <userId> checklist_running       # nhắc "đã làm 1 giờ" của một checklist đang chạy
 *   npm run notify:job-test -- <userId> digest_review           # thông báo rà soát cuối ngày
 *   npm run notify:job-test -- <userId> digest_overdue_evening  # "⏰ x todo quan trọng quá hạn" (tổng kết 17:00)
 *   npm run notify:job-test -- <userId> digest_overdue_morning  # "⏰ x todo quan trọng hôm qua chưa xong" (07:00)
 *   npm run notify:job-test -- <userId> todo_timer_end --device <user_devices.id>
 *   npm run notify:job-test -- <userId> --cleanup               # xóa đồ thử "[TEST]"
 *
 * Vì tick kiểm tra lại điều kiện trước khi gửi, mỗi job cần dữ liệu thật phía sau. Script dựng
 * đồ thử tối thiểu tiêu đề bắt đầu bằng "[TEST]" (todo, đếm ngược, checklist, checklist có lịch) trong tài khoản đó; chúng
 * sẽ đồng bộ xuống app như dữ liệu bình thường cho tới khi chạy --cleanup. Tổng kết hôm nay
 * (digest_*) dùng lại dòng job sẵn có của ngày hôm nay và dời nó lên +1 phút. Nhắc lặp
 * (*_overdue) dựng todo/checklist có giờ hẹn = giờ chạy - 2 giờ rồi tạo đúng mốc +2h; các mốc sau
 * trong ngày (nếu có) sẽ do planner thêm như bình thường cho tới khi chạy --cleanup.
 *
 * Dùng chung DB Turso trong .env. Sau khi tạo, gọi tick (hoặc chờ NOTIFY_INPROCESS_TICK):
 *   curl -fsS -X POST -H "x-notify-tick-secret: $NOTIFY_TICK_SECRET" http://localhost:3000/internal/notifications/tick
 * Không in registration id/token hay nội dung cá nhân ra màn hình.
 */
import "../config/env.js";
import { turso } from "../config/db.js";
import {
  CHECKLIST_RUNNING,
  EVENT_KINDS,
  NOTIFICATION_KINDS,
  OVERDUE,
  isDigestKind,
  type NotificationJobKind,
} from "../config/notification-policy.js";
import * as schedulesRepo from "../repositories/checklist-schedules.js";
import * as jobsRepo from "../repositories/notification-jobs.js";
import * as settingsRepo from "../repositories/notification-settings.js";
import * as devicesRepo from "../repositories/notifications.js";
import * as timersRepo from "../repositories/todo-timers.js";
import { resolveSettings } from "../services/notification-schedule.js";
import { newId } from "../utils/id.js";
import { addDays, nowISO, localDateOf, minutesToHhmm } from "../utils/time.js";

const TEST_PREFIX = "[TEST]";

/** Loại cũ (nhắc 30 phút) không còn được tạo; tick luôn hủy nó nên không có gì để thử. */
const LEGACY_KIND = EVENT_KINDS[2];

type Args = {
  userId: string | null;
  kinds: NotificationJobKind[];
  deviceId: string | null;
  cleanup: boolean;
};

const parseArgs = (argv: string[]): Args | string => {
  let userId: string | null = null;
  let kindArg: string | null = null;
  let deviceId: string | null = null;
  let cleanup = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cleanup") cleanup = true;
    else if (arg === "--device") deviceId = argv[++i] ?? null;
    else if (arg.startsWith("-")) return `Tham số không hợp lệ: ${arg}`;
    else if (userId === null) userId = arg;
    else if (kindArg === null) kindArg = arg;
    else return `Thừa tham số: ${arg}`;
  }
  if (kindArg !== null && kindArg !== "all" && !(NOTIFICATION_KINDS as readonly string[]).includes(kindArg)) {
    return `Loại không hợp lệ: ${kindArg}. Chọn một trong: all, ${NOTIFICATION_KINDS.join(", ")}`;
  }
  const kinds =
    kindArg === null || kindArg === "all"
      ? NOTIFICATION_KINDS.filter((kind) => kind !== LEGACY_KIND)
      : [kindArg as NotificationJobKind];
  return { userId, kinds, deviceId, cleanup };
};

/** Thời điểm chạy: đầu phút kế tiếp cách ít nhất 60 giây (todo_reminder khớp theo phút). */
const targetTime = (): Date =>
  new Date(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000);

const localHhmm = (at: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return minutesToHhmm(get("hour") * 60 + get("minute"));
};

const insertTestTodo = async (
  userId: string,
  title: string,
  scheduledDate: string,
  time: string | null,
  /** true = quan trọng (chưa phân loại khẩn cấp); "not_urgent" = quan trọng & KHÔNG khẩn cấp. */
  important: boolean | "not_urgent" = false
): Promise<string> => {
  const id = newId();
  const now = nowISO();
  await turso.execute({
    sql: `INSERT INTO todos
          (id, user_id, title, status, position, is_important, is_urgent, scheduled_date, time,
           created_at, updated_at)
          VALUES (?, ?, ?, 'open', 0, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      userId,
      `${TEST_PREFIX} ${title}`,
      important ? 1 : null,
      important === "not_urgent" ? 0 : null,
      scheduledDate,
      time,
      now,
      now,
    ],
  });
  return id;
};

/** Checklist thử có 2 bước và một lịch không lặp vào `date` lúc `time` (giờ địa phương). */
const createScheduledChecklist = async (
  userId: string,
  date: string,
  time: string
): Promise<string> => {
  const now = nowISO();
  const templateId = newId();
  await turso.batch(
    [
      {
        sql: `INSERT INTO checklist_templates
              (id, user_id, title, is_system, times_used, sort_order, created_at, updated_at)
              VALUES (?, ?, ?, 0, 0, 0, ?, ?)`,
        args: [templateId, userId, `${TEST_PREFIX} Checklist hẹn giờ`, now, now],
      },
      ...[1, 2].map((n) => ({
        sql: `INSERT INTO checklist_template_items
              (id, template_id, position, title, is_required, created_at, updated_at)
              VALUES (?, ?, ?, ?, 0, ?, ?)`,
        args: [`${templateId}-${n}`, templateId, n, `Bước ${n}`, now, now],
      })),
    ],
    "write"
  );
  await schedulesRepo.upsertSchedule(userId, templateId, {
    start_date: date,
    time,
    recurrence_type: null,
    recurrence_interval: null,
    recurrence_days_of_week: null,
    recurrence_end_date: null,
    enabled: true,
  });
  return templateId;
};

const createChecklistRun = async (userId: string, startedAt: Date): Promise<string> => {
  const now = nowISO();
  const templateId = newId();
  const runId = newId();
  await turso.batch(
    [
      {
        sql: `INSERT INTO checklist_templates
              (id, user_id, title, is_system, times_used, sort_order, created_at, updated_at)
              VALUES (?, ?, ?, 0, 0, 0, ?, ?)`,
        args: [templateId, userId, `${TEST_PREFIX} Checklist`, now, now],
      },
      ...[1, 2].map((n) => ({
        sql: `INSERT INTO checklist_template_items
              (id, template_id, position, title, is_required, created_at, updated_at)
              VALUES (?, ?, ?, ?, 0, ?, ?)`,
        args: [`${templateId}-${n}`, templateId, n, `Bước ${n}`, now, now],
      })),
      {
        sql: `INSERT INTO checklist_runs
              (id, template_id, user_id, name, status, started_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'in_progress', ?, ?, ?)`,
        args: [runId, templateId, userId, `${TEST_PREFIX} Checklist`, startedAt.toISOString(), now, now],
      },
      ...[1, 2].map((n) => ({
        sql: `INSERT INTO checklist_run_items
              (id, run_id, template_item_id, status, created_at, updated_at)
              VALUES (?, ?, ?, 'pending', ?, ?)`,
        args: [newId(), runId, `${templateId}-${n}`, now, now],
      })),
    ],
    "write"
  );
  return runId;
};

const cleanup = async (userId: string): Promise<void> => {
  const now = nowISO();
  const todos = await turso.execute({
    sql: "SELECT id FROM todos WHERE user_id = ? AND deleted_at IS NULL AND title LIKE ?",
    args: [userId, `${TEST_PREFIX}%`],
  });
  const todoIds = (todos.rows as unknown as { id: string }[]).map((r) => r.id);
  await jobsRepo.cancelEventJobs("todo_reminder", todoIds);
  await jobsRepo.cancelEventJobs("todo_overdue", todoIds);
  await jobsRepo.cancelEventJobs("todo_timer_end", todoIds);
  await timersRepo.deleteTimers(todoIds);
  const runs = await turso.execute({
    sql: "SELECT id FROM checklist_runs WHERE user_id = ? AND deleted_at IS NULL AND name LIKE ?",
    args: [userId, `${TEST_PREFIX}%`],
  });
  const runIds = (runs.rows as unknown as { id: string }[]).map((r) => r.id);
  for (const runId of runIds) {
    await jobsRepo.cancelSlotJobsExcept(userId, "checklist_running", runId, []);
  }
  const templates = await turso.execute({
    sql: "SELECT id FROM checklist_templates WHERE user_id = ? AND deleted_at IS NULL AND title LIKE ?",
    args: [userId, `${TEST_PREFIX}%`],
  });
  const templateIds = (templates.rows as unknown as { id: string }[]).map((r) => r.id);
  for (const templateId of templateIds) {
    await jobsRepo.cancelOccurrenceJobsExcept(userId, "checklist_due", templateId, []);
    await jobsRepo.cancelSlotJobsExcept(userId, "checklist_overdue", templateId, []);
    await schedulesRepo.softDeleteSchedule(userId, templateId);
  }
  await turso.batch(
    [
      {
        sql: "UPDATE todos SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND deleted_at IS NULL AND title LIKE ?",
        args: [now, now, userId, `${TEST_PREFIX}%`],
      },
      {
        sql: "UPDATE checklist_runs SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND deleted_at IS NULL AND name LIKE ?",
        args: [now, now, userId, `${TEST_PREFIX}%`],
      },
      {
        sql: `UPDATE checklist_run_items SET deleted_at = ?, updated_at = ?
              WHERE deleted_at IS NULL AND run_id IN
                (SELECT id FROM checklist_runs WHERE user_id = ? AND name LIKE ?)`,
        args: [now, now, userId, `${TEST_PREFIX}%`],
      },
      {
        sql: "UPDATE checklist_templates SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND deleted_at IS NULL AND title LIKE ?",
        args: [now, now, userId, `${TEST_PREFIX}%`],
      },
    ],
    "write"
  );
  console.log(
    `Đã dọn ${todoIds.length} todo thử và ${runIds.length} lần chạy checklist thử (soft-delete).`
  );
};

const main = async (): Promise<number> => {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") {
    console.error(parsed);
    console.error("Cách dùng: npm run notify:job-test -- <userId> [kind|all] [--device <deviceId>] [--cleanup]");
    return 1;
  }
  const { userId, kinds, deviceId, cleanup: doCleanup } = parsed;
  if (!userId) {
    console.error("Cách dùng: npm run notify:job-test -- <userId> [kind|all] [--device <deviceId>] [--cleanup]");
    return 1;
  }

  const ctx = await settingsRepo.getUserContext(userId);
  if (!ctx || !ctx.active) {
    console.error("Không tìm thấy người dùng đang hoạt động với id này.");
    return 1;
  }
  if (doCleanup) {
    await cleanup(userId);
    return 0;
  }

  const devices = await devicesRepo.listDevicesByUser(userId);
  if (devices.length === 0) {
    console.error("Người dùng này chưa có thiết bị nào (gọi POST /api/v1/devices từ app trước).");
    return 1;
  }

  let device: devicesRepo.UserDeviceRow | null = null;
  if (deviceId) {
    device = await devicesRepo.getUserDevice(userId, deviceId);
    if (!device) {
      console.error("--device không phải thiết bị của người dùng này (dùng user_devices.id).");
      return 1;
    }
  }

  const settings = resolveSettings(ctx);
  const target = targetTime();
  const runAt = target.toISOString();
  const today = localDateOf(target, settings.timezone);
  const time = localHhmm(target, settings.timezone);
  console.log(`Giờ chạy dự kiến: ${runAt} (UTC), ${today} ${time} theo ${settings.timezone}`);
  console.log(`Người dùng có ${devices.length} thiết bị.`);

  let todayTodoId: string | null = null;
  const ensureTodayTodo = async (): Promise<string> => {
    todayTodoId ??= await insertTestTodo(userId, "Todo hôm nay", today, null);
    return todayTodoId;
  };

  for (const kind of kinds) {
    switch (kind) {
      case "todo_reminder": {
        const id = await insertTestTodo(userId, "Nhắc giờ", today, time);
        await jobsRepo.upsertEventJob({ userId, kind, refId: id, runAt, localDate: today });
        console.log(`✓ ${kind}: job cho todo thử (nhắc lúc ${time}).`);
        break;
      }
      case "todo_timer_end": {
        if (!device) {
          console.log(`- ${kind}: bỏ qua, cần --device <user_devices.id> (chỉ thiết bị đó nhận tin).`);
          break;
        }
        const id = await insertTestTodo(userId, "Đếm ngược", today, null);
        await timersRepo.upsertTimer({
          todo_id: id,
          user_id: userId,
          status: "running",
          estimated_seconds: 60,
          remaining_seconds: 60,
          ends_at: runAt,
          device_id: device.id,
          last_client_event_at: nowISO(),
        });
        await jobsRepo.upsertEventJob({ userId, kind, refId: id, runAt, targetDeviceId: device.id });
        console.log(`✓ ${kind}: job nhắm CHỈ thiết bị ${device.id}.`);
        break;
      }
      case "checklist_running": {
        // Mốc theo giờ đầu tiên = lúc bắt đầu + 1 giờ, nên run phải bắt đầu lúc (giờ chạy - 1 giờ), cùng ngày.
        const startedAt = new Date(target.getTime() - CHECKLIST_RUNNING.intervalMs);
        if (localDateOf(startedAt, settings.timezone) !== today) {
          console.log(`- ${kind}: bỏ qua, lúc bắt đầu (chạy - 1 giờ) rơi sang ngày hôm trước. Thử lại sau 01:00.`);
          break;
        }
        const runId = await createChecklistRun(userId, startedAt);
        await jobsRepo.upsertSlotJob({ userId, kind, refId: runId, localDate: today, runAt });
        console.log(`✓ ${kind}: run thử đã chạy 1 giờ, còn 2 bước chưa tick.`);
        break;
      }
      case "checklist_due": {
        const templateId = await createScheduledChecklist(userId, today, time);
        await jobsRepo.upsertOccurrenceJob({ userId, kind, refId: templateId, localDate: today, runAt });
        console.log(`✓ ${kind}: checklist thử 2 bước, lịch một lần hôm nay lúc ${time}.`);
        break;
      }
      case "todo_overdue": {
        // Mốc nhắc lặp đầu tiên = giờ hẹn + 2h, nên giờ hẹn phải là giờ chạy - 2 giờ, cùng ngày.
        const scheduledAt = new Date(target.getTime() - OVERDUE.intervalMs);
        const scheduledDate = localDateOf(scheduledAt, settings.timezone);
        if (scheduledDate !== today) {
          console.log(`- ${kind}: bỏ qua, giờ hẹn (chạy - 2 giờ) rơi sang ngày hôm trước. Thử lại sau 02:00.`);
          break;
        }
        const scheduledTime = localHhmm(scheduledAt, settings.timezone);
        const id = await insertTestTodo(userId, "Nhắc lặp", today, scheduledTime, true);
        await jobsRepo.upsertSlotJob({ userId, kind, refId: id, localDate: today, runAt });
        console.log(`✓ ${kind}: todo thử quan trọng hẹn ${scheduledTime}, nhắc "Quá giờ" lúc ${time}.`);
        break;
      }
      case "checklist_overdue": {
        const scheduledAt = new Date(target.getTime() - OVERDUE.intervalMs);
        const scheduledDate = localDateOf(scheduledAt, settings.timezone);
        if (scheduledDate !== today) {
          console.log(`- ${kind}: bỏ qua, giờ hẹn (chạy - 2 giờ) rơi sang ngày hôm trước. Thử lại sau 02:00.`);
          break;
        }
        const scheduledTime = localHhmm(scheduledAt, settings.timezone);
        const templateId = await createScheduledChecklist(userId, today, scheduledTime);
        await jobsRepo.upsertSlotJob({ userId, kind, refId: templateId, localDate: today, runAt });
        console.log(`✓ ${kind}: checklist thử hẹn ${scheduledTime}, nhắc "Quá giờ" lúc ${time}.`);
        break;
      }
      default: {
        if (!isDigestKind(kind)) break;
        if (kind === "digest_todos") await ensureTodayTodo();
        // Tổng kết quá hạn đếm lại lúc gửi nên cần một todo quan trọng & không khẩn cấp thật phía sau.
        if (kind === "digest_overdue_evening") {
          await insertTestTodo(userId, "Quá hạn", today, "00:01", "not_urgent");
        }
        if (kind === "digest_overdue_morning") {
          await insertTestTodo(userId, "Chưa xong hôm qua", addDays(today, -1), "09:00", "not_urgent");
        }
        const created = await jobsRepo.insertDigestJobs([{ userId, kind, localDate: today, runAt }]);
        if (created === 0) {
          await turso.execute({
            sql: `UPDATE notification_jobs
                  SET run_at = ?, status = 'pending', attempts = 0, locked_at = NULL, sent_at = NULL
                  WHERE user_id = ? AND kind = ? AND local_date = ?`,
            args: [runAt, userId, kind, today],
          });
        }
        const note =
          kind === "digest_habits"
            ? " (bị bỏ qua nếu bạn không có thói quen nào hôm nay)"
            : kind === "digest_todos"
              ? " (đã thêm 1 todo thử cho hôm nay)"
              : kind === "digest_review"
                ? " (luôn được gửi, kể cả khi hôm nay trống)"
                : kind === "digest_overdue_evening" || kind === "digest_overdue_morning"
                  ? " (đã thêm 1 todo thử quan trọng & không khẩn cấp)"
                  : "";
        console.log(`✓ ${kind}: ${created > 0 ? "tạo mới" : "dời job sẵn có của hôm nay"}${note}.`);
      }
    }
  }

  console.log("\nGọi tick ngay (hoặc chờ NOTIFY_INPROCESS_TICK):");
  console.log('  curl -fsS -X POST -H "x-notify-tick-secret: $NOTIFY_TICK_SECRET" http://localhost:3000/internal/notifications/tick');
  console.log(`Dọn đồ thử: npm run notify:job-test -- ${userId} --cleanup`);
  return 0;
};

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("Fatal error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });

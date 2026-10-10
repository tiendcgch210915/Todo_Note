/**
 * Tạo job thử cho một người dùng, chạy sau ~1 phút, cho từng loại thông báo. Không công khai qua HTTP.
 *
 *   npm run notify:job-test -- <userId>                         # mọi loại (todo_timer_end cần --device)
 *   npm run notify:job-test -- <userId> digest_morning
 *   npm run notify:job-test -- <userId> todo_timer_end --device <user_devices.id>
 *   npm run notify:job-test -- <userId> --cleanup               # xóa đồ thử "[TEST]"
 *
 * Vì tick kiểm tra lại điều kiện trước khi gửi, mỗi job cần dữ liệu thật phía sau. Script dựng
 * đồ thử tối thiểu tiêu đề bắt đầu bằng "[TEST]" (todo, đếm ngược, checklist) trong tài khoản đó; chúng
 * sẽ đồng bộ xuống app như dữ liệu bình thường cho tới khi chạy --cleanup. Tổng kết hôm nay
 * (digest_*) dùng lại dòng job sẵn có của ngày hôm nay và dời nó lên +1 phút.
 *
 * Dùng chung DB Turso trong .env. Sau khi tạo, gọi tick (hoặc chờ NOTIFY_INPROCESS_TICK):
 *   curl -fsS -X POST -H "x-notify-tick-secret: $NOTIFY_TICK_SECRET" http://localhost:3000/internal/notifications/tick
 * Không in registration id/token hay nội dung cá nhân ra màn hình.
 */
import "../config/env.js";
import { turso } from "../config/db.js";
import {
  NOTIFICATION_KINDS,
  isDigestKind,
  type NotificationJobKind,
} from "../config/notification-policy.js";
import * as jobsRepo from "../repositories/notification-jobs.js";
import * as settingsRepo from "../repositories/notification-settings.js";
import * as devicesRepo from "../repositories/notifications.js";
import * as timersRepo from "../repositories/todo-timers.js";
import { resolveSettings } from "../services/notification-schedule.js";
import { newId } from "../utils/id.js";
import { nowISO, localDateOf, minutesToHhmm } from "../utils/time.js";

const TEST_PREFIX = "[TEST]";

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
      ? [...NOTIFICATION_KINDS]
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
  time: string | null
): Promise<string> => {
  const id = newId();
  const now = nowISO();
  await turso.execute({
    sql: `INSERT INTO todos
          (id, user_id, title, status, position, scheduled_date, time, created_at, updated_at)
          VALUES (?, ?, ?, 'open', 0, ?, ?, ?, ?)`,
    args: [id, userId, `${TEST_PREFIX} ${title}`, scheduledDate, time, now, now],
  });
  return id;
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
  await jobsRepo.cancelEventJobs("todo_timer_end", todoIds);
  await timersRepo.deleteTimers(todoIds);
  const runs = await turso.execute({
    sql: "SELECT id FROM checklist_runs WHERE user_id = ? AND deleted_at IS NULL AND name LIKE ?",
    args: [userId, `${TEST_PREFIX}%`],
  });
  const runIds = (runs.rows as unknown as { id: string }[]).map((r) => r.id);
  await jobsRepo.cancelEventJobs("checklist_30m", runIds);
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
      case "checklist_30m": {
        const runId = await createChecklistRun(userId, new Date(target.getTime() - 30 * 60_000));
        await jobsRepo.upsertEventJob({ userId, kind, refId: runId, runAt });
        console.log(`✓ ${kind}: run thử đang chạy, còn 2 bước chưa tick.`);
        break;
      }
      default: {
        if (!isDigestKind(kind)) break;
        if (kind === "digest_todos") await ensureTodayTodo();
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

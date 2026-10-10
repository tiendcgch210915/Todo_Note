/**
 * Dữ liệu mẫu + FCM giả cho các test thông báo. File này KHÔNG import src/ ở mức trên cùng,
 * vì test phải đặt biến môi trường (DB trong bộ nhớ) trước khi import bất kỳ module nào của src/.
 */
import type { Client } from "@libsql/client";
import type { Message } from "firebase-admin/messaging";

type Db = Pick<Client, "execute">;

export const USER_ID = "11111111-1111-7111-8111-111111111111";
export const OTHER_USER_ID = "22222222-2222-7222-8222-222222222222";
const SEED_TIME = "2026-06-01T00:00:00.000Z";

/** Ngày UTC (YYYY-MM-DD) cách hôm nay `days` ngày theo đồng hồ thật. */
export const utcDateFromToday = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export const insertUser = async (
  db: Db,
  id: string,
  options: { timezone?: string; deletedAt?: string | null } = {}
): Promise<void> => {
  await db.execute({
    sql: `INSERT INTO users
          (id, email, password_hash, timezone, is_admin, created_at, updated_at, deleted_at)
          VALUES (?, ?, 'test-hash', ?, 0, ?, ?, ?)`,
    args: [
      id,
      `${id}@test.local`,
      options.timezone ?? "Asia/Ho_Chi_Minh",
      SEED_TIME,
      SEED_TIME,
      options.deletedAt ?? null,
    ],
  });
};

export const insertDevice = async (
  db: Db,
  userId: string,
  registrationId: string,
  options: { id?: string; kind?: "fid" | "token" } = {}
): Promise<string> => {
  const id = options.id ?? `device-${registrationId}`;
  await db.execute({
    sql: `INSERT INTO user_devices
          (id, user_id, registration_id, kind, platform, last_seen_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'android', ?, ?, ?)`,
    args: [
      id,
      userId,
      registrationId,
      options.kind ?? "token",
      SEED_TIME,
      SEED_TIME,
      SEED_TIME,
    ],
  });
  return id;
};

export const insertTodo = async (
  db: Db,
  row: {
    id: string;
    userId?: string;
    title?: string;
    status?: string;
    scheduledDate?: string | null;
    time?: string | null;
    parentId?: string | null;
    isImportant?: number | null;
    isUrgent?: number | null;
    estimatedMinutes?: number | null;
    deletedAt?: string | null;
  }
): Promise<void> => {
  await db.execute({
    sql: `INSERT INTO todos
          (id, user_id, parent_id, title, status, position, is_important, is_urgent,
           estimated_minutes, scheduled_date, time, created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.id,
      row.userId ?? USER_ID,
      row.parentId ?? null,
      row.title ?? "Việc thử",
      row.status ?? "open",
      row.isImportant ?? null,
      row.isUrgent ?? null,
      row.estimatedMinutes ?? null,
      row.scheduledDate === undefined ? null : row.scheduledDate,
      row.time ?? null,
      SEED_TIME,
      SEED_TIME,
      row.deletedAt ?? null,
    ],
  });
};

export const insertHabit = async (
  db: Db,
  row: { id: string; userId?: string; startDate?: string; endDate?: string | null }
): Promise<void> => {
  await db.execute({
    sql: `INSERT INTO habits
          (id, user_id, title, frequency_type, target_per_period, start_date, end_date,
           current_streak, longest_streak, is_archived, created_at, updated_at)
          VALUES (?, ?, 'Thói quen thử', 'daily', 1, ?, ?, 0, 0, 0, ?, ?)`,
    args: [
      row.id,
      row.userId ?? USER_ID,
      row.startDate ?? "2026-01-01",
      row.endDate ?? null,
      SEED_TIME,
      SEED_TIME,
    ],
  });
};

export const insertHabitLog = async (
  db: Db,
  row: { id: string; habitId: string; logDate: string; completed: number }
): Promise<void> => {
  await db.execute({
    sql: `INSERT INTO habit_logs
          (id, habit_id, log_date, completed, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [row.id, row.habitId, row.logDate, row.completed, SEED_TIME, SEED_TIME],
  });
};

/** Template checklist của người dùng với `itemCount` bước (đều bắt buộc = 0). */
export const insertTemplateWithItems = async (
  db: Db,
  row: { id: string; userId?: string; title?: string; itemCount: number }
): Promise<string[]> => {
  await db.execute({
    sql: `INSERT INTO checklist_templates
          (id, user_id, title, is_system, times_used, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, 0, 0, 0, ?, ?)`,
    args: [row.id, row.userId ?? USER_ID, row.title ?? "Mẫu thử", SEED_TIME, SEED_TIME],
  });
  const itemIds: string[] = [];
  for (let i = 0; i < row.itemCount; i++) {
    const itemId = `${row.id}-item-${i + 1}`;
    itemIds.push(itemId);
    await db.execute({
      sql: `INSERT INTO checklist_template_items
            (id, template_id, position, title, is_required, created_at, updated_at)
            VALUES (?, ?, ?, ?, 0, ?, ?)`,
      args: [itemId, row.id, i, `Bước ${i + 1}`, SEED_TIME, SEED_TIME],
    });
  }
  return itemIds;
};

type Outcome = { ok: true } | { ok: false; code: string };

/** Giả của Admin SDK Messaging: ghi lại mọi tin nhận được. */
export const fakeMessaging = (
  decide: (message: Message) => Outcome = () => ({ ok: true })
) => {
  const messages: Message[] = [];
  const client = {
    sendEach: async (batch: Message[]) => {
      messages.push(...batch);
      return {
        responses: batch.map((message) => {
          const outcome = decide(message);
          return outcome.ok
            ? { success: true }
            : { success: false, error: { code: outcome.code } };
        }),
      };
    },
  };
  /** Mã đăng ký (fid hoặc token) mà tin được gửi tới. */
  const targets = (): string[] =>
    messages.map((message) => {
      const m = message as { fid?: string; token?: string };
      return (m.fid ?? m.token) as string;
    });
  return { client, messages, targets };
};

export const silentLogger = { info() {}, warn() {}, error() {} };

type JobRow = Record<string, unknown>;

export const jobsFor = async (
  db: Db,
  userId: string,
  where = ""
): Promise<JobRow[]> => {
  const res = await db.execute({
    sql: `SELECT * FROM notification_jobs WHERE user_id = ? ${where}
          ORDER BY kind ASC, run_at ASC, id ASC`,
    args: [userId],
  });
  return res.rows as unknown as JobRow[];
};

export const insertRawJob = async (
  db: Db,
  row: {
    id: string;
    userId?: string;
    kind: string;
    refId?: string | null;
    targetDeviceId?: string | null;
    localDate?: string | null;
    runAt: string;
    status?: string;
    attempts?: number;
    lockedAt?: string | null;
  }
): Promise<void> => {
  await db.execute({
    sql: `INSERT INTO notification_jobs
          (id, user_id, kind, ref_id, target_device_id, local_date, run_at, status,
           attempts, locked_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.id,
      row.userId ?? USER_ID,
      row.kind,
      row.refId ?? null,
      row.targetDeviceId ?? null,
      row.localDate ?? null,
      row.runAt,
      row.status ?? "pending",
      row.attempts ?? 0,
      row.lockedAt ?? null,
      SEED_TIME,
    ],
  });
};

export const statusOf = async (db: Db, jobId: string): Promise<string | null> => {
  const res = await db.execute({
    sql: "SELECT status FROM notification_jobs WHERE id = ?",
    args: [jobId],
  });
  return res.rows.length === 0
    ? null
    : ((res.rows[0] as unknown as { status: string }).status);
};

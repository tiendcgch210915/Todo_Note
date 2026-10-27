/**
 * Áp dụng migrations THẬT lên DB trong bộ nhớ, để test dùng đúng schema production thay vì DDL
 * viết tay (dễ lệch). Bộ tách câu lệnh sao chép từ src/scripts/migrate.ts (file đó chạy `main()`
 * ngay khi import nên không import lại được).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Client } from "@libsql/client";

type TestDb = Pick<Client, "execute">;

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

export const parseStatements = (sql: string): string[] => {
  const cleaned = sql.replace(/--.*$/gm, "");
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let i = 0;
  while (i < cleaned.length) {
    const prev = cleaned[i - 1] ?? " ";
    const isBoundary = !/[A-Za-z0-9_]/.test(prev);
    const upper = cleaned.slice(i, i + 6).toUpperCase();
    if (isBoundary && /^BEGIN\b/.test(upper)) {
      depth++;
      buf += cleaned.slice(i, i + 5);
      i += 5;
      continue;
    }
    if (isBoundary && /^END\b/.test(upper)) {
      depth = Math.max(0, depth - 1);
      buf += cleaned.slice(i, i + 3);
      i += 3;
      continue;
    }
    if (cleaned[i] === ";" && depth === 0) {
      const trimmed = buf.trim();
      if (trimmed.length > 0) out.push(trimmed);
      buf = "";
      i++;
      continue;
    }
    buf += cleaned[i];
    i++;
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
};

/** Áp dụng mọi migration theo thứ tự tên file (giống `npm run db:migrate`). */
export const applyAllMigrations = async (db: TestDb): Promise<void> => {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
    for (const statement of parseStatements(sql)) {
      await db.execute(statement);
    }
  }
};

/**
 * Dành cho các test dịch vụ vẫn tự dựng bảng bằng DDL tay: chỉ thêm các bảng của hệ thống
 * thông báo (migration 0016) cùng bảng `users` tối thiểu mà các móc tạo/hủy job cần đọc, để
 * móc chạy thật thay vì ghi lỗi "no such table".
 */
export const createNotificationTables = async (db: TestDb): Promise<void> => {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
      settings TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  await applyMigrationFileOnce(db, "0016_notification_jobs.sql", "notification_jobs");
  // 0017 thêm bảng lịch checklist và dựng lại notification_jobs (kind checklist_due).
  await applyMigrationFileOnce(db, "0017_checklist_schedules.sql", "checklist_schedules");
  // 0018 thêm cột review_time và dựng lại notification_jobs (nhắc lặp + digest_review).
  await applyMigrationFileWhen(db, "0018_overdue_nudges_and_review.sql", async () => {
    const columns = await db.execute("PRAGMA table_info(notification_settings)");
    return !columns.rows.some((row) => row.name === "review_time");
  });
  // 0020 dựng lại notification_jobs để nhận kind checklist_running (nhắc checklist đang làm dở mỗi giờ).
  await applyMigrationFileWhen(db, "0020_checklist_running_nudges.sql", async () => {
    const table = await db.execute(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notification_jobs'"
    );
    const ddl = String((table.rows[0] as unknown as { sql?: string } | undefined)?.sql ?? "");
    return !ddl.includes("checklist_running");
  });
  // 0022 dựng lại notification_jobs lần nữa để nhận digest_overdue_evening / digest_overdue_morning.
  await applyMigrationFileWhen(db, "0022_overdue_digests.sql", async () => {
    const table = await db.execute(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notification_jobs'"
    );
    const ddl = String((table.rows[0] as unknown as { sql?: string } | undefined)?.sql ?? "");
    return !ddl.includes("digest_overdue_evening");
  });
};

/**
 * Áp dụng một migration nếu bảng `probeTable` chưa có. Test dùng DDL tay có thể thiếu bảng mà
 * migration tham chiếu (ví dụ chỉ mục trên checklist_runs): bỏ qua riêng câu lệnh "no such table".
 */
const applyMigrationFileOnce = (
  db: TestDb,
  file: string,
  probeTable: string
): Promise<void> =>
  applyMigrationFileWhen(db, file, async () => {
    const existing = await db.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: [probeTable],
    });
    return existing.rows.length === 0;
  });

/** Như `applyMigrationFileOnce` nhưng điều kiện "cần áp dụng" do người gọi quyết định. */
const applyMigrationFileWhen = async (
  db: TestDb,
  file: string,
  isNeeded: () => Promise<boolean>
): Promise<void> => {
  if (!(await isNeeded())) return;
  const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
  for (const statement of parseStatements(sql)) {
    try {
      await db.execute(statement);
    } catch (error) {
      if (!/no such table/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
  }
};

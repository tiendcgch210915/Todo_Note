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
  const existing = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_jobs'"
  );
  if (existing.rows.length > 0) return;
  const sql = await readFile(
    join(MIGRATIONS_DIR, "0016_notification_jobs.sql"),
    "utf-8"
  );
  for (const statement of parseStatements(sql)) {
    await db.execute(statement);
  }
};

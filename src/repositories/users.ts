import { turso } from "../config/db.js";
import { newId } from "../utils/id.js";
import { nowISO } from "../utils/time.js";

export type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  avatar_url: string | null;
  timezone: string;
  settings: string | null;
  is_admin: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type ListFilter = "all" | "active" | "disabled";

const mapRow = (row: Record<string, unknown>): UserRow => ({
  id: row.id as string,
  email: row.email as string,
  password_hash: row.password_hash as string,
  display_name: (row.display_name as string | null) ?? null,
  avatar_url: (row.avatar_url as string | null) ?? null,
  timezone: row.timezone as string,
  settings: (row.settings as string | null) ?? null,
  is_admin: Number(row.is_admin),
  created_at: row.created_at as string,
  updated_at: row.updated_at as string,
  deleted_at: (row.deleted_at as string | null) ?? null,
});

export const listUsers = async (params: {
  search: string;
  filter: ListFilter;
  page: number;
  pageSize: number;
}): Promise<{ rows: UserRow[]; total: number }> => {
  const { search, filter, page, pageSize } = params;
  const where: string[] = [];
  const args: (string | number)[] = [];

  if (search) {
    where.push("email LIKE ?");
    args.push(`%${search}%`);
  }
  if (filter === "active") where.push("deleted_at IS NULL");
  if (filter === "disabled") where.push("deleted_at IS NOT NULL");

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const offset = (page - 1) * pageSize;
  const [totalRes, listRes] = await turso.batch([
    { sql: `SELECT COUNT(*) AS c FROM users ${whereSql}`, args },
    {
      sql: `SELECT * FROM users ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      args: [...args, pageSize, offset],
    },
  ], "read");
  const total = Number(totalRes.rows[0].c);
  const rows = (listRes.rows as unknown as Record<string, unknown>[]).map(mapRow);
  return { rows, total };
};

export const getUserById = async (id: string): Promise<UserRow | null> => {
  const res = await turso.execute({
    sql: "SELECT * FROM users WHERE id = ?",
    args: [id],
  });
  if (res.rows.length === 0) return null;
  return mapRow(res.rows[0] as unknown as Record<string, unknown>);
};

export const disableUser = async (id: string): Promise<void> => {
  const now = nowISO();
  await turso.execute({
    sql: "UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
    args: [now, now, id],
  });
};

export const enableUser = async (id: string): Promise<void> => {
  const now = nowISO();
  await turso.execute({
    sql: "UPDATE users SET deleted_at = NULL, updated_at = ? WHERE id = ?",
    args: [now, id],
  });
};

export const updateUserProfile = async (
  id: string,
  patch: { timezone?: string; is_admin?: number }
): Promise<void> => {
  const sets: string[] = [];
  const args: (string | number)[] = [];
  if (patch.timezone !== undefined) {
    sets.push("timezone = ?");
    args.push(patch.timezone);
  }
  if (patch.is_admin !== undefined) {
    sets.push("is_admin = ?");
    args.push(patch.is_admin);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  args.push(nowISO());
  args.push(id);
  await turso.execute({
    sql: `UPDATE users SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
};

export const updateUserPassword = async (id: string, passwordHash: string): Promise<void> => {
  const now = nowISO();
  await turso.execute({
    sql: "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
    args: [passwordHash, now, id],
  });
};

export const findUserByEmail = async (email: string): Promise<UserRow | null> => {
  const res = await turso.execute({
    sql: "SELECT * FROM users WHERE email = ? AND deleted_at IS NULL",
    args: [email],
  });
  if (res.rows.length === 0) return null;
  return mapRow(res.rows[0] as unknown as Record<string, unknown>);
};

export const createUser = async (input: {
  email: string;
  password_hash: string;
  display_name?: string;
}): Promise<UserRow> => {
  const id = newId();
  const now = nowISO();
  await turso.execute({
    sql: `INSERT INTO users (id, email, password_hash, display_name, timezone, is_admin, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'Asia/Ho_Chi_Minh', 0, ?, ?)`,
    args: [id, input.email, input.password_hash, input.display_name ?? null, now, now],
  });
  const row = await getUserById(id);
  if (!row) throw new Error("createUser: row missing after insert");
  return row;
};

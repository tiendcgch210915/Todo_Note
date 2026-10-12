import { turso } from "../config/db.js";
import { newId } from "../utils/id.js";
import { nowISO } from "../utils/time.js";

export type RunRow = {
  id: string;
  template_id: string;
  user_id: string;
  name: string | null;
  status: "in_progress" | "completed" | "abandoned";
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type RunItemRow = {
  id: string;
  run_id: string;
  template_item_id: string;
  status: "pending" | "done" | "skipped";
  completed_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type RunItemDetail = RunItemRow & {
  title: string;
  description: string | null;
  is_required: number;
  position: number;
};

const RUN_COLUMNS =
  "id, template_id, user_id, name, status, started_at, completed_at, duration_ms, created_at, updated_at, deleted_at";

const mapRun = (row: Record<string, unknown>): RunRow => ({
  id: row.id as string,
  template_id: row.template_id as string,
  user_id: row.user_id as string,
  name: (row.name as string | null) ?? null,
  status: row.status as RunRow["status"],
  started_at: row.started_at as string,
  completed_at: (row.completed_at as string | null) ?? null,
  duration_ms: row.duration_ms === null || row.duration_ms === undefined
    ? null
    : Number(row.duration_ms),
  created_at: (row.created_at as string | null) ?? (row.started_at as string),
  updated_at: (row.updated_at as string | null) ?? (row.started_at as string),
  deleted_at: (row.deleted_at as string | null) ?? null,
});

export class RunRepoError extends Error {
  constructor(public code: "not_found" | "incomplete_required") {
    super(code);
  }
}

// ============================================================
// Start run atomic — clone all template_items vào run_items
// ============================================================

export const startRun = async (
  userId: string,
  templateId: string,
  name: string | null
): Promise<string> => {
  // Verify template available (system OR own user)
  const tpl = await turso.execute({
    sql: `SELECT id FROM checklist_templates
          WHERE id = ? AND deleted_at IS NULL
            AND (is_system = 1 OR (is_system = 0 AND user_id = ?))`,
    args: [templateId, userId],
  });
  if (tpl.rows.length === 0) throw new RunRepoError("not_found");

  const itemsRes = await turso.execute({
    sql: "SELECT id FROM checklist_template_items WHERE template_id = ? ORDER BY position ASC",
    args: [templateId],
  });
  const itemIds = (itemsRes.rows as unknown as Record<string, unknown>[]).map(
    (r) => r.id as string
  );

  const runId = newId();
  const now = nowISO();

  const stmts: { sql: string; args: (string | number | null)[] }[] = [
    {
      sql: `INSERT INTO checklist_runs
            (id, template_id, user_id, name, status, started_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'in_progress', ?, ?, ?)`,
      args: [runId, templateId, userId, name, now, now, now],
    },
    ...itemIds.map((tplItemId) => ({
      sql: `INSERT INTO checklist_run_items
            (id, run_id, template_item_id, status, created_at, updated_at)
            VALUES (?, ?, ?, 'pending', ?, ?)`,
      args: [newId(), runId, tplItemId, now, now] as (string | number | null)[],
    })),
    {
      sql: `UPDATE checklist_templates
            SET times_used = times_used + 1, last_used_at = ?, updated_at = ?
            WHERE id = ?`,
      args: [now, now, templateId],
    },
  ];

  await turso.batch(stmts, "write");
  return runId;
};

// ============================================================
// Read
// ============================================================

export const getRunById = async (
  id: string,
  userId: string
): Promise<RunRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${RUN_COLUMNS} FROM checklist_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    args: [id, userId],
  });
  if (res.rows.length === 0) return null;
  return mapRun(res.rows[0] as unknown as Record<string, unknown>);
};

export const listRunItems = async (runId: string): Promise<RunItemDetail[]> => {
  const res = await turso.execute({
    sql: `SELECT ri.id, ri.run_id, ri.template_item_id, ri.status, ri.completed_at, ri.note,
                 ri.created_at, ri.updated_at, ri.deleted_at,
                 ti.title, ti.description, ti.is_required, ti.position
          FROM checklist_run_items ri
          JOIN checklist_template_items ti ON ti.id = ri.template_item_id
          WHERE ri.run_id = ? AND ri.deleted_at IS NULL
          ORDER BY ti.position ASC`,
    args: [runId],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    run_id: r.run_id as string,
    template_item_id: r.template_item_id as string,
    status: r.status as RunItemDetail["status"],
    completed_at: (r.completed_at as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    created_at: (r.created_at as string | null) ?? "",
    updated_at: (r.updated_at as string | null) ?? "",
    deleted_at: (r.deleted_at as string | null) ?? null,
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    is_required: Number(r.is_required),
    position: Number(r.position),
  }));
};

export type ListRunsOpts = {
  status?: RunRow["status"];
  template_id?: string;
  cursor?: string;
  limit: number;
};

type Cursor = { started_at: string; id: string };
const encodeCursor = (c: Cursor) =>
  Buffer.from(`${c.started_at}|${c.id}`, "utf8").toString("base64url");
const decodeCursor = (raw: string): Cursor => {
  const dec = Buffer.from(raw, "base64url").toString("utf8");
  const idx = dec.indexOf("|");
  if (idx < 0) throw new Error("bad_cursor");
  const started_at = dec.slice(0, idx);
  const id = dec.slice(idx + 1);
  if (!started_at || !id) throw new Error("bad_cursor");
  return { started_at, id };
};

export const listRunsByUser = async (
  userId: string,
  opts: ListRunsOpts
): Promise<{ rows: RunRow[]; nextCursor: string | null }> => {
  const where: string[] = ["user_id = ?", "deleted_at IS NULL"];
  const args: (string | number)[] = [userId];
  if (opts.status) {
    where.push("status = ?");
    args.push(opts.status);
  }
  if (opts.template_id) {
    where.push("template_id = ?");
    args.push(opts.template_id);
  }
  if (opts.cursor) {
    const c = decodeCursor(opts.cursor);
    where.push("(started_at < ? OR (started_at = ? AND id < ?))");
    args.push(c.started_at, c.started_at, c.id);
  }
  const limitPlus = opts.limit + 1;
  args.push(limitPlus);

  const res = await turso.execute({
    sql: `SELECT ${RUN_COLUMNS} FROM checklist_runs
          WHERE ${where.join(" AND ")}
          ORDER BY started_at DESC, id DESC
          LIMIT ?`,
    args,
  });
  const raw = (res.rows as unknown as Record<string, unknown>[]).map(mapRun);
  let rows = raw;
  let nextCursor: string | null = null;
  if (raw.length > opts.limit) {
    rows = raw.slice(0, opts.limit);
    const last = rows[rows.length - 1];
    nextCursor = encodeCursor({ started_at: last.started_at, id: last.id });
  }
  return { rows, nextCursor };
};

// ============================================================
// Mutations
// ============================================================

export const updateRunItem = async (
  runItemId: string,
  userId: string,
  patch: { status: RunItemRow["status"]; note?: string | null }
): Promise<boolean> => {
  const now = nowISO();
  const completedAt = patch.status === "done" ? now : null;
  const args: (string | number | null)[] = [
    patch.status,
    patch.note ?? null,
    completedAt,
    now,
    runItemId,
    userId,
  ];
  const res = await turso.execute({
    sql: `UPDATE checklist_run_items
          SET status = ?, note = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
            AND run_id IN (SELECT id FROM checklist_runs WHERE user_id = ? AND deleted_at IS NULL)`,
    args,
  });
  return res.rowsAffected > 0;
};

/**
 * `completedNow` = lần gọi này mới chuyển run sang completed (không phải gọi lại trên run đã xong),
 * để chỗ gọi chỉ chạy hiệu ứng phụ (tự tick habit...) đúng một lần — cùng ý với todosRepo.completeTodo.
 */
export const completeRun = async (
  id: string,
  userId: string,
  durationMs: number | null = null
): Promise<{ run: RunRow; completedNow: boolean }> => {
  const run = await getRunById(id, userId);
  if (!run) throw new RunRepoError("not_found");
  // idempotent; do not overwrite duration
  if (run.status === "completed") return { run, completedNow: false };
  // Check required items chưa pending
  const check = await turso.execute({
    sql: `SELECT COUNT(*) AS c FROM checklist_run_items ri
          JOIN checklist_template_items ti ON ti.id = ri.template_item_id
          WHERE ri.run_id = ? AND ti.is_required = 1 AND ri.status = 'pending'`,
    args: [id],
  });
  const pendingRequired = Number(
    (check.rows[0] as unknown as Record<string, unknown>).c
  );
  if (pendingRequired > 0) throw new RunRepoError("incomplete_required");
  const now = nowISO();
  // `status <> 'completed'` làm bước chuyển nguyên tử: hai request đồng thời chỉ một bên thắng.
  const res = await turso.execute({
    sql: `UPDATE checklist_runs
          SET status = 'completed', completed_at = ?, duration_ms = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND status <> 'completed'`,
    args: [now, durationMs, now, id, userId],
  });
  const updated = await getRunById(id, userId);
  if (!updated) throw new RunRepoError("not_found");
  return { run: updated, completedNow: res.rowsAffected > 0 };
};

export const abandonRun = async (
  id: string,
  userId: string
): Promise<boolean> => {
  const now = nowISO();
  const res = await turso.execute({
    sql: `UPDATE checklist_runs SET status = 'abandoned', completed_at = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND status = 'in_progress' AND deleted_at IS NULL`,
    args: [now, now, id, userId],
  });
  return res.rowsAffected > 0;
};

export const deleteRun = async (
  id: string,
  userId: string
): Promise<boolean> => {
  const now = nowISO();
  // §7.2 Cascade: soft-delete run → soft-delete run_items trong cùng transaction
  const res = await turso.batch(
    [
      {
        sql: `UPDATE checklist_runs
              SET deleted_at = ?, updated_at = ?
              WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        args: [now, now, id, userId],
      },
      {
        sql: `UPDATE checklist_run_items
              SET deleted_at = ?, updated_at = ?
              WHERE run_id = ? AND deleted_at IS NULL`,
        args: [now, now, id],
      },
    ],
    "write"
  );
  return (res[0].rowsAffected ?? 0) > 0;
};

import { turso } from "../config/db.js";

/** Dữ liệu checklist run cần cho thông báo (đọc lúc dựng job và lúc gửi). */
export type ChecklistRunInfo = {
  id: string;
  name: string | null;
  template_title: string | null;
  status: "in_progress" | "completed" | "abandoned";
  started_at: string;
  /** Số bước chưa tick (status = 'pending'), không tính bước đã xóa. */
  pending_steps: number;
};

export const getChecklistRunInfo = async (
  userId: string,
  runId: string
): Promise<ChecklistRunInfo | null> => {
  const res = await turso.execute({
    sql: `SELECT r.id, r.name, r.status, r.started_at, t.title AS template_title,
                 (SELECT COUNT(*) FROM checklist_run_items i
                  WHERE i.run_id = r.id AND i.status = 'pending'
                    AND i.deleted_at IS NULL) AS pending_steps
          FROM checklist_runs r
          LEFT JOIN checklist_templates t ON t.id = r.template_id
          WHERE r.id = ? AND r.user_id = ? AND r.deleted_at IS NULL`,
    args: [runId, userId],
  });
  if (res.rows.length === 0) return null;
  const row = res.rows[0] as unknown as Record<string, unknown>;
  return {
    id: row.id as string,
    name: (row.name as string | null) ?? null,
    template_title: (row.template_title as string | null) ?? null,
    status: row.status as ChecklistRunInfo["status"],
    started_at: row.started_at as string,
    pending_steps: Number(row.pending_steps),
  };
};

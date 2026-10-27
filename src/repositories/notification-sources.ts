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

/** Checklist của một run, kể cả run vừa bị xóa mềm (hook cần biết để tính lại job theo lịch). */
export const getRunTemplateId = async (
  userId: string,
  runId: string
): Promise<string | null> => {
  const res = await turso.execute({
    sql: "SELECT template_id FROM checklist_runs WHERE id = ? AND user_id = ?",
    args: [runId, userId],
  });
  if (res.rows.length === 0) return null;
  return (res.rows[0] as unknown as { template_id: string }).template_id;
};

/**
 * Id các todo cấp trên cùng còn làm dở của người dùng có ngày và giờ hẹn từ `fromDate` trở đi.
 * Dùng khi đổi múi giờ để tính lại mốc nhắc.
 */
export const listTimedTodoIds = async (
  userId: string,
  fromDate: string
): Promise<string[]> => {
  const res = await turso.execute({
    sql: `SELECT id FROM todos
          WHERE user_id = ? AND deleted_at IS NULL AND parent_id IS NULL
            AND status IN ('open', 'in_progress')
            AND time IS NOT NULL AND scheduled_date IS NOT NULL AND scheduled_date >= ?`,
    args: [userId, fromDate],
  });
  return (res.rows as unknown as { id: string }[]).map((row) => row.id);
};

/**
 * Id các run còn đang chạy của người dùng, bắt đầu từ `startedAfterIso` trở đi. Dùng khi đổi múi
 * giờ để tính lại mốc nhắc.
 */
export const listInProgressRunIds = async (
  userId: string,
  startedAfterIso: string
): Promise<string[]> => {
  const res = await turso.execute({
    sql: `SELECT id FROM checklist_runs
          WHERE user_id = ? AND status = 'in_progress' AND deleted_at IS NULL
            AND started_at >= ?`,
    args: [userId, startedAfterIso],
  });
  return (res.rows as unknown as { id: string }[]).map((row) => row.id);
};

/**
 * Số todo "quan trọng & không khẩn cấp" còn làm dở của ngày địa phương `scheduledDate`, có giờ hẹn
 * (giống các nhắc khác chỉ xét todo có giờ hẹn). `beforeTime` (HH:mm) giữ lại chỉ những todo có giờ
 * hẹn SỚM HƠN mốc đó, tức đã quá hạn vào lúc ấy; null = mọi giờ hẹn trong ngày.
 */
export const countOverdueImportantTodos = async (
  userId: string,
  scheduledDate: string,
  beforeTime: string | null
): Promise<number> => {
  const res = await turso.execute({
    sql: `SELECT COUNT(*) AS n FROM todos
          WHERE user_id = ? AND scheduled_date = ?
            AND deleted_at IS NULL AND parent_id IS NULL
            AND status IN ('open', 'in_progress')
            AND time IS NOT NULL ${beforeTime === null ? "" : "AND time < ?"}
            AND is_important = 1 AND is_urgent = 0`,
    args: beforeTime === null ? [userId, scheduledDate] : [userId, scheduledDate, beforeTime],
  });
  return Number((res.rows[0] as unknown as { n: number }).n);
};

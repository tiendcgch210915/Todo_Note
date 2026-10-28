import { turso } from "../config/db.js";
import { newId } from "../utils/id.js";
import { nowISO } from "../utils/time.js";
import type { RecurrenceType } from "../utils/recurrence.js";

export type ScheduleRow = {
  id: string;
  user_id: string;
  template_id: string;
  start_date: string;
  time: string;
  recurrence_type: RecurrenceType | null;
  recurrence_interval: number | null;
  recurrence_days_of_week: string | null;
  recurrence_end_date: string | null;
  /** 0 | 1 */
  enabled: number;
  /** Khoảng tạm dừng [paused_from, paused_until], cả hai đầu tính; cùng null = không dừng. */
  paused_from: string | null;
  paused_until: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type OverrideRow = {
  id: string;
  user_id: string;
  template_id: string;
  local_date: string;
  time: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type MarkStatus = "done" | "open";

/** Đánh dấu tay "Đã xong / Chưa hoàn thành" cho MỘT ngày của checklist (xem migration 0023). */
export type MarkRow = {
  id: string;
  user_id: string;
  template_id: string;
  local_date: string;
  status: MarkStatus;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/** Trường người dùng được phép đặt cho một lịch (đã chuẩn hóa/kiểm tra ở lớp trên). */
export type ScheduleFields = {
  start_date: string;
  time: string;
  recurrence_type: RecurrenceType | null;
  recurrence_interval: number | null;
  recurrence_days_of_week: string | null;
  recurrence_end_date: string | null;
  enabled: boolean;
  /**
   * Khoảng tạm dừng. `undefined` = người gọi không nhắc tới: giữ nguyên khoảng đang có (lịch vừa
   * được tạo lại sau khi xóa thì không dừng). `null` = bỏ tạm dừng. Luôn đi theo cặp.
   */
  paused_from?: string | null;
  paused_until?: string | null;
};

const SCHEDULE_COLUMNS =
  "id, user_id, template_id, start_date, time, recurrence_type, recurrence_interval, " +
  "recurrence_days_of_week, recurrence_end_date, enabled, paused_from, paused_until, " +
  "created_at, updated_at, deleted_at";

const OVERRIDE_COLUMNS =
  "id, user_id, template_id, local_date, time, created_at, updated_at, deleted_at";

const MARK_COLUMNS =
  "id, user_id, template_id, local_date, status, created_at, updated_at, deleted_at";

const CHUNK = 200;

const placeholders = (n: number): string =>
  Array.from({ length: n }, () => "?").join(", ");

const chunks = <T>(items: readonly T[], size = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const mapSchedule = (row: Record<string, unknown>): ScheduleRow => ({
  id: row.id as string,
  user_id: row.user_id as string,
  template_id: row.template_id as string,
  start_date: row.start_date as string,
  time: row.time as string,
  recurrence_type: (row.recurrence_type as RecurrenceType | null) ?? null,
  recurrence_interval: nullableNumber(row.recurrence_interval),
  recurrence_days_of_week: (row.recurrence_days_of_week as string | null) ?? null,
  recurrence_end_date: (row.recurrence_end_date as string | null) ?? null,
  enabled: Number(row.enabled),
  paused_from: (row.paused_from as string | null) ?? null,
  paused_until: (row.paused_until as string | null) ?? null,
  created_at: row.created_at as string,
  updated_at: row.updated_at as string,
  deleted_at: (row.deleted_at as string | null) ?? null,
});

const mapOverride = (row: Record<string, unknown>): OverrideRow => ({
  id: row.id as string,
  user_id: row.user_id as string,
  template_id: row.template_id as string,
  local_date: row.local_date as string,
  time: row.time as string,
  created_at: row.created_at as string,
  updated_at: row.updated_at as string,
  deleted_at: (row.deleted_at as string | null) ?? null,
});

const mapMark = (row: Record<string, unknown>): MarkRow => ({
  id: row.id as string,
  user_id: row.user_id as string,
  template_id: row.template_id as string,
  local_date: row.local_date as string,
  status: row.status as MarkStatus,
  created_at: row.created_at as string,
  updated_at: row.updated_at as string,
  deleted_at: (row.deleted_at as string | null) ?? null,
});

const rowsOf = (res: { rows: unknown[] }): Record<string, unknown>[] =>
  res.rows as unknown as Record<string, unknown>[];

// ── Lịch ─────────────────────────────────────────────────────────────────────

/** Lịch còn hiệu lực (chưa xóa mềm) của một checklist; null nếu chưa có. */
export const getLiveSchedule = async (
  userId: string,
  templateId: string
): Promise<ScheduleRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${SCHEDULE_COLUMNS} FROM checklist_schedules
          WHERE user_id = ? AND template_id = ? AND deleted_at IS NULL`,
    args: [userId, templateId],
  });
  return res.rows.length === 0 ? null : mapSchedule(rowsOf(res)[0]);
};

/** Theo id (kể cả đã xóa mềm): sync cần biết template_id của một lịch vừa bị xóa. */
export const getScheduleById = async (id: string): Promise<ScheduleRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${SCHEDULE_COLUMNS} FROM checklist_schedules WHERE id = ?`,
    args: [id],
  });
  return res.rows.length === 0 ? null : mapSchedule(rowsOf(res)[0]);
};

/**
 * Tạo hoặc thay thế lịch của (user, checklist). Một dòng duy nhất cho mỗi cặp: lịch đã bị xóa mềm
 * được hồi sinh tại chỗ (giữ id) thay vì tạo dòng mới.
 *
 * Khoảng tạm dừng: nếu `fields` không nhắc tới thì GIỮ khoảng đang có (sửa giờ/lặp không làm lịch
 * tự hết tạm dừng), trừ khi dòng đang bị xóa mềm (lịch tạo lại "từ đầu" nên không dừng).
 */
export const upsertSchedule = async (
  userId: string,
  templateId: string,
  fields: ScheduleFields
): Promise<ScheduleRow> => {
  const now = nowISO();
  const pauseGiven = fields.paused_from !== undefined || fields.paused_until !== undefined;
  await turso.execute({
    sql: `INSERT INTO checklist_schedules
          (id, user_id, template_id, start_date, time, recurrence_type, recurrence_interval,
           recurrence_days_of_week, recurrence_end_date, enabled, paused_from, paused_until,
           created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(user_id, template_id) DO UPDATE SET
            start_date = excluded.start_date,
            time = excluded.time,
            recurrence_type = excluded.recurrence_type,
            recurrence_interval = excluded.recurrence_interval,
            recurrence_days_of_week = excluded.recurrence_days_of_week,
            recurrence_end_date = excluded.recurrence_end_date,
            enabled = excluded.enabled,
            paused_from = CASE WHEN ? = 1 THEN excluded.paused_from
                               WHEN checklist_schedules.deleted_at IS NOT NULL THEN NULL
                               ELSE checklist_schedules.paused_from END,
            paused_until = CASE WHEN ? = 1 THEN excluded.paused_until
                                WHEN checklist_schedules.deleted_at IS NOT NULL THEN NULL
                                ELSE checklist_schedules.paused_until END,
            updated_at = excluded.updated_at,
            deleted_at = NULL`,
    args: [
      newId(),
      userId,
      templateId,
      fields.start_date,
      fields.time,
      fields.recurrence_type,
      fields.recurrence_interval,
      fields.recurrence_days_of_week,
      fields.recurrence_end_date,
      fields.enabled ? 1 : 0,
      fields.paused_from ?? null,
      fields.paused_until ?? null,
      now,
      now,
      pauseGiven ? 1 : 0,
      pauseGiven ? 1 : 0,
    ],
  });
  const row = await getLiveSchedule(userId, templateId);
  if (!row) throw new Error("upsertSchedule: row missing after upsert");
  return row;
};

/** Xóa mềm lịch cùng các ghi đè của nó. Trả true nếu có lịch còn hiệu lực bị xóa. */
export const softDeleteSchedule = async (
  userId: string,
  templateId: string
): Promise<boolean> => {
  const now = nowISO();
  const results = await turso.batch(
    [
      {
        sql: `UPDATE checklist_schedules SET deleted_at = ?, updated_at = ?
              WHERE user_id = ? AND template_id = ? AND deleted_at IS NULL`,
        args: [now, now, userId, templateId],
      },
      {
        sql: `UPDATE checklist_schedule_overrides SET deleted_at = ?, updated_at = ?
              WHERE user_id = ? AND template_id = ? AND deleted_at IS NULL`,
        args: [now, now, userId, templateId],
      },
    ],
    "write"
  );
  return results[0].rowsAffected > 0;
};

/**
 * Lịch còn hiệu lực của các người dùng, chỉ khi checklist còn tồn tại. Có kèm tiêu đề để
 * GET /checklists/occurrences không phải đọc lại.
 */
export const listLiveSchedulesForUsers = async (
  userIds: readonly string[],
  templateId?: string
): Promise<Array<ScheduleRow & { template_title: string }>> => {
  const out: Array<ScheduleRow & { template_title: string }> = [];
  for (const part of chunks(userIds)) {
    const res = await turso.execute({
      sql: `SELECT ${SCHEDULE_COLUMNS.split(", ").map((c) => `s.${c}`).join(", ")},
                   t.title AS template_title
            FROM checklist_schedules s
            JOIN checklist_templates t ON t.id = s.template_id AND t.deleted_at IS NULL
            WHERE s.deleted_at IS NULL
              AND s.user_id IN (${placeholders(part.length)})
              ${templateId ? "AND s.template_id = ?" : ""}`,
      args: templateId ? [...part, templateId] : part,
    });
    for (const row of rowsOf(res)) {
      out.push({ ...mapSchedule(row), template_title: row.template_title as string });
    }
  }
  return out;
};

// ── Ghi đè theo ngày ─────────────────────────────────────────────────────────

export const getOverrideById = async (id: string): Promise<OverrideRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${OVERRIDE_COLUMNS} FROM checklist_schedule_overrides WHERE id = ?`,
    args: [id],
  });
  return res.rows.length === 0 ? null : mapOverride(rowsOf(res)[0]);
};

export const getLiveOverride = async (
  userId: string,
  templateId: string,
  localDate: string
): Promise<OverrideRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${OVERRIDE_COLUMNS} FROM checklist_schedule_overrides
          WHERE user_id = ? AND template_id = ? AND local_date = ? AND deleted_at IS NULL`,
    args: [userId, templateId, localDate],
  });
  return res.rows.length === 0 ? null : mapOverride(rowsOf(res)[0]);
};

export const upsertOverride = async (
  userId: string,
  templateId: string,
  localDate: string,
  time: string
): Promise<OverrideRow> => {
  const now = nowISO();
  await turso.execute({
    sql: `INSERT INTO checklist_schedule_overrides
          (id, user_id, template_id, local_date, time, created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(user_id, template_id, local_date) DO UPDATE SET
            time = excluded.time,
            updated_at = excluded.updated_at,
            deleted_at = NULL`,
    args: [newId(), userId, templateId, localDate, time, now, now],
  });
  const row = await getLiveOverride(userId, templateId, localDate);
  if (!row) throw new Error("upsertOverride: row missing after upsert");
  return row;
};

/** Trả true nếu có ghi đè còn hiệu lực bị xóa. */
export const softDeleteOverride = async (
  userId: string,
  templateId: string,
  localDate: string
): Promise<boolean> => {
  const now = nowISO();
  const res = await turso.execute({
    sql: `UPDATE checklist_schedule_overrides SET deleted_at = ?, updated_at = ?
          WHERE user_id = ? AND template_id = ? AND local_date = ? AND deleted_at IS NULL`,
    args: [now, now, userId, templateId, localDate],
  });
  return res.rowsAffected > 0;
};

/** Ghi đè còn hiệu lực trong [from, to] của các người dùng. */
export const listLiveOverridesForUsers = async (
  userIds: readonly string[],
  from: string,
  to: string
): Promise<OverrideRow[]> => {
  const out: OverrideRow[] = [];
  for (const part of chunks(userIds)) {
    const res = await turso.execute({
      sql: `SELECT ${OVERRIDE_COLUMNS} FROM checklist_schedule_overrides
            WHERE deleted_at IS NULL AND local_date >= ? AND local_date <= ?
              AND user_id IN (${placeholders(part.length)})`,
      args: [from, to, ...part],
    });
    out.push(...rowsOf(res).map(mapOverride));
  }
  return out;
};

// ── Đánh dấu tay theo ngày ───────────────────────────────────────────────────

export const getMarkById = async (id: string): Promise<MarkRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${MARK_COLUMNS} FROM checklist_occurrence_marks WHERE id = ?`,
    args: [id],
  });
  return res.rows.length === 0 ? null : mapMark(rowsOf(res)[0]);
};

export const getLiveMark = async (
  userId: string,
  templateId: string,
  localDate: string
): Promise<MarkRow | null> => {
  const res = await turso.execute({
    sql: `SELECT ${MARK_COLUMNS} FROM checklist_occurrence_marks
          WHERE user_id = ? AND template_id = ? AND local_date = ? AND deleted_at IS NULL`,
    args: [userId, templateId, localDate],
  });
  return res.rows.length === 0 ? null : mapMark(rowsOf(res)[0]);
};

/** Đặt (hoặc hồi sinh) dấu của một ngày; `updated_at` mới là mốc để so với lần hoàn thành sau đó. */
export const upsertMark = async (
  userId: string,
  templateId: string,
  localDate: string,
  status: MarkStatus
): Promise<MarkRow> => {
  const now = nowISO();
  await turso.execute({
    sql: `INSERT INTO checklist_occurrence_marks
          (id, user_id, template_id, local_date, status, created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(user_id, template_id, local_date) DO UPDATE SET
            status = excluded.status,
            updated_at = excluded.updated_at,
            deleted_at = NULL`,
    args: [newId(), userId, templateId, localDate, status, now, now],
  });
  const row = await getLiveMark(userId, templateId, localDate);
  if (!row) throw new Error("upsertMark: row missing after upsert");
  return row;
};

/** Trả true nếu có dấu còn hiệu lực bị xóa (về lại chế độ tự động). */
export const softDeleteMark = async (
  userId: string,
  templateId: string,
  localDate: string
): Promise<boolean> => {
  const now = nowISO();
  const res = await turso.execute({
    sql: `UPDATE checklist_occurrence_marks SET deleted_at = ?, updated_at = ?
          WHERE user_id = ? AND template_id = ? AND local_date = ? AND deleted_at IS NULL`,
    args: [now, now, userId, templateId, localDate],
  });
  return res.rowsAffected > 0;
};

/** Dấu còn hiệu lực trong [from, to] (ngày địa phương) của các người dùng. */
export const listLiveMarksForUsers = async (
  userIds: readonly string[],
  from: string,
  to: string,
  templateIds?: readonly string[]
): Promise<MarkRow[]> => {
  const out: MarkRow[] = [];
  const templateFilter =
    templateIds && templateIds.length > 0
      ? `AND template_id IN (${placeholders(templateIds.length)})`
      : "";
  for (const part of chunks(userIds)) {
    const res = await turso.execute({
      sql: `SELECT ${MARK_COLUMNS} FROM checklist_occurrence_marks
            WHERE deleted_at IS NULL AND local_date >= ? AND local_date <= ?
              AND user_id IN (${placeholders(part.length)})
              ${templateFilter}`,
      args: [from, to, ...part, ...(templateIds ?? [])],
    });
    out.push(...rowsOf(res).map(mapMark));
  }
  return out;
};

// ── Dữ liệu phụ cho occurrences ──────────────────────────────────────────────

/** Số bước (chưa xóa) của mỗi checklist. */
export const countStepsByTemplate = async (
  templateIds: readonly string[]
): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();
  for (const part of chunks(templateIds)) {
    const res = await turso.execute({
      sql: `SELECT template_id, COUNT(*) AS c FROM checklist_template_items
            WHERE deleted_at IS NULL AND template_id IN (${placeholders(part.length)})
            GROUP BY template_id`,
      args: part,
    });
    for (const row of rowsOf(res)) counts.set(row.template_id as string, Number(row.c));
  }
  return counts;
};

/** Một lần chạy đã hoàn thành. Ngày của nó tính theo `started_at`, không phải `completed_at`. */
export type CompletedRun = {
  user_id: string;
  template_id: string;
  started_at: string;
  completed_at: string;
};

/**
 * Run đã hoàn thành (status = 'completed', chưa xóa) có started_at trong [fromIso, toIso). Ngày của
 * một lần chạy là ngày BẮT ĐẦU: bắt đầu 23:30 và xong 00:30 vẫn thuộc ngày hôm trước. Run bị bỏ dở
 * (abandoned) cũng có completed_at nhưng KHÔNG tính là xong.
 */
export const listCompletedRunsStartedBetween = async (
  userIds: readonly string[],
  fromIso: string,
  toIso: string,
  templateIds?: readonly string[]
): Promise<CompletedRun[]> => {
  const out: CompletedRun[] = [];
  const templateFilter =
    templateIds && templateIds.length > 0
      ? `AND template_id IN (${placeholders(templateIds.length)})`
      : "";
  for (const part of chunks(userIds)) {
    const res = await turso.execute({
      sql: `SELECT user_id, template_id, started_at, completed_at FROM checklist_runs
            WHERE status = 'completed' AND deleted_at IS NULL
              AND started_at >= ? AND started_at < ?
              AND user_id IN (${placeholders(part.length)})
              ${templateFilter}`,
      args: [fromIso, toIso, ...part, ...(templateIds ?? [])],
    });
    for (const row of rowsOf(res)) {
      out.push({
        user_id: row.user_id as string,
        template_id: row.template_id as string,
        started_at: row.started_at as string,
        completed_at: (row.completed_at as string | null) ?? (row.started_at as string),
      });
    }
  }
  return out;
};

// ── Dọn lịch hết hạn ─────────────────────────────────────────────────────────

export type ExpiryCandidate = ScheduleRow & { timezone: string };

/**
 * Lịch còn hiệu lực của người dùng còn hoạt động mà ngày kết thúc hiệu lực (ngày kết thúc, hoặc
 * chính start_date với lịch không lặp) <= `utcToday`. Chỉ là danh sách ứng viên: múi giờ của từng
 * người quyết định lịch đã qua hạn thật chưa. Sắp theo ngày kết thúc tăng dần để lịch chắc chắn
 * đã hết hạn được xử lý trước.
 */
export const listExpiryCandidates = async (
  utcToday: string,
  limit: number
): Promise<ExpiryCandidate[]> => {
  const end = "COALESCE(s.recurrence_end_date, CASE WHEN s.recurrence_type IS NULL THEN s.start_date END)";
  const res = await turso.execute({
    sql: `SELECT ${SCHEDULE_COLUMNS.split(", ").map((c) => `s.${c}`).join(", ")}, u.timezone
          FROM checklist_schedules s
          JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
          WHERE s.deleted_at IS NULL AND ${end} <= ?
          ORDER BY ${end} ASC, s.user_id ASC, s.template_id ASC
          LIMIT ?`,
    args: [utcToday, limit],
  });
  return rowsOf(res).map((row) => ({ ...mapSchedule(row), timezone: row.timezone as string }));
};

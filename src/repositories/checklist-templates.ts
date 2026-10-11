import { turso } from "../config/db.js";
import { newId, SYSTEM_USER_ID } from "../utils/id.js";
import { nowISO } from "../utils/time.js";

export type TemplateRow = {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  category_id: string | null;
  sort_order: number;
  is_system: number;
  times_used: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type ItemRow = {
  id: string;
  template_id: string;
  position: number;
  title: string;
  description: string | null;
  is_required: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

const mapTemplate = (row: Record<string, unknown>): TemplateRow => ({
  id: row.id as string,
  user_id: row.user_id as string,
  title: row.title as string,
  description: (row.description as string | null) ?? null,
  icon: (row.icon as string | null) ?? null,
  category: (row.category as string | null) ?? null,
  category_id: (row.category_id as string | null) ?? null,
  sort_order: Number(row.resolved_sort_order ?? row.sort_order ?? 0),
  is_system: Number(row.is_system),
  times_used: Number(row.times_used),
  last_used_at: (row.last_used_at as string | null) ?? null,
  created_at: row.created_at as string,
  updated_at: row.updated_at as string,
  deleted_at: (row.deleted_at as string | null) ?? null,
});

const mapItem = (row: Record<string, unknown>): ItemRow => ({
  id: row.id as string,
  template_id: row.template_id as string,
  position: Number(row.position),
  title: row.title as string,
  description: (row.description as string | null) ?? null,
  is_required: Number(row.is_required),
  created_at: row.created_at as string,
  updated_at: row.updated_at as string,
  deleted_at: (row.deleted_at as string | null) ?? null,
});

export const listSystemTemplates = async (filter: "all" | "active" | "deleted"): Promise<TemplateRow[]> => {
  const where: string[] = ["is_system = 1"];
  if (filter === "active") where.push("deleted_at IS NULL");
  if (filter === "deleted") where.push("deleted_at IS NOT NULL");
  const res = await turso.execute({
    sql: `SELECT * FROM checklist_templates WHERE ${where.join(" AND ")} ORDER BY created_at DESC`,
    args: [],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapTemplate);
};

export const getSystemTemplateById = async (id: string): Promise<TemplateRow | null> => {
  const res = await turso.execute({
    sql: "SELECT * FROM checklist_templates WHERE id = ? AND is_system = 1",
    args: [id],
  });
  if (res.rows.length === 0) return null;
  return mapTemplate(res.rows[0] as unknown as Record<string, unknown>);
};

export const listItems = async (templateId: string): Promise<ItemRow[]> => {
  const res = await turso.execute({
    sql: "SELECT * FROM checklist_template_items WHERE template_id = ? AND deleted_at IS NULL ORDER BY position ASC",
    args: [templateId],
  });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapItem);
};

export const getItemById = async (id: string): Promise<ItemRow | null> => {
  const res = await turso.execute({
    sql: "SELECT * FROM checklist_template_items WHERE id = ?",
    args: [id],
  });
  if (res.rows.length === 0) return null;
  return mapItem(res.rows[0] as unknown as Record<string, unknown>);
};

export type CreateTemplateInput = {
  title: string;
  description?: string | null;
  icon?: string | null;
  category?: string | null;
  category_id?: string | null;
  sort_order?: number;
  items: { title: string; description?: string | null; is_required: number }[];
};

export const createSystemTemplate = async (input: CreateTemplateInput): Promise<string> => {
  const templateId = newId();
  const now = nowISO();

  const stmts: { sql: string; args: (string | number | null)[] }[] = [
    {
      sql: `INSERT INTO checklist_templates
        (id, user_id, title, description, icon, category, category_id, sort_order, times_used, is_system, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
      args: [
        templateId,
        SYSTEM_USER_ID,
        input.title,
        input.description ?? null,
        input.icon ?? null,
        input.category ?? null,
        input.category_id ?? null,
        input.sort_order ?? 0,
        now,
        now,
      ],
    },
    ...input.items.map((it, idx) => ({
      sql: `INSERT INTO checklist_template_items
        (id, template_id, position, title, description, is_required, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [newId(), templateId, idx + 1, it.title, it.description ?? null, it.is_required, now, now] as (string | number | null)[],
    })),
  ];

  await turso.batch(stmts, "write");
  return templateId;
};

export const updateSystemTemplate = async (
  id: string,
  patch: { title?: string; description?: string | null; icon?: string | null; category?: string | null; category_id?: string | null }
): Promise<void> => {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.title !== undefined) { sets.push("title = ?"); args.push(patch.title); }
  if (patch.description !== undefined) { sets.push("description = ?"); args.push(patch.description); }
  if (patch.icon !== undefined) { sets.push("icon = ?"); args.push(patch.icon); }
  if (patch.category !== undefined) { sets.push("category = ?"); args.push(patch.category); }
  if (patch.category_id !== undefined) { sets.push("category_id = ?"); args.push(patch.category_id); }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  args.push(nowISO());
  args.push(id);
  await turso.execute({
    sql: `UPDATE checklist_templates SET ${sets.join(", ")} WHERE id = ? AND is_system = 1`,
    args,
  });
};

export const softDeleteSystemTemplate = async (id: string): Promise<void> => {
  const now = nowISO();
  // Lịch của mọi người dùng trên mẫu hệ thống này cũng hết nghĩa (job còn chờ sẽ tự bị hủy khi gửi).
  await turso.batch(
    [
      {
        sql: "UPDATE checklist_templates SET deleted_at = ?, updated_at = ? WHERE id = ? AND is_system = 1 AND deleted_at IS NULL",
        args: [now, now, id],
      },
      {
        sql: "UPDATE checklist_schedules SET deleted_at = ?, updated_at = ? WHERE template_id = ? AND deleted_at IS NULL",
        args: [now, now, id],
      },
      {
        sql: "UPDATE checklist_schedule_overrides SET deleted_at = ?, updated_at = ? WHERE template_id = ? AND deleted_at IS NULL",
        args: [now, now, id],
      },
    ],
    "write"
  );
};

export const addItem = async (
  templateId: string,
  input: { title: string; description?: string | null; is_required: number }
): Promise<void> => {
  const now = nowISO();
  // Tính position kế tiếp
  const maxRes = await turso.execute({
    sql: "SELECT COALESCE(MAX(position), 0) AS m FROM checklist_template_items WHERE template_id = ? AND deleted_at IS NULL",
    args: [templateId],
  });
  const nextPos = Number((maxRes.rows[0] as Record<string, unknown>).m) + 1;
  await turso.execute({
    sql: `INSERT INTO checklist_template_items
      (id, template_id, position, title, description, is_required, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [newId(), templateId, nextPos, input.title, input.description ?? null, input.is_required, now, now],
  });
};

export const updateItem = async (
  id: string,
  patch: { title?: string; description?: string | null; is_required?: number }
): Promise<void> => {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.title !== undefined) { sets.push("title = ?"); args.push(patch.title); }
  if (patch.description !== undefined) { sets.push("description = ?"); args.push(patch.description); }
  if (patch.is_required !== undefined) { sets.push("is_required = ?"); args.push(patch.is_required); }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  args.push(nowISO());
  args.push(id);
  await turso.execute({
    sql: `UPDATE checklist_template_items SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
};

export const deleteItem = async (id: string): Promise<void> => {
  const now = nowISO();
  await turso.execute({
    sql: "UPDATE checklist_template_items SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
    args: [now, now, id],
  });
};

// ============================================================
// Mobile API — user-scoped templates (system + own union)
// ============================================================

export const listTemplatesForUser = async (
  userId: string,
  opts: {
    scope: "system" | "own" | "all";
    category?: string;
    category_id?: string;
    uncategorized?: boolean;
  }
): Promise<TemplateRow[]> => {
  const where: string[] = ["t.deleted_at IS NULL"];
  const args: (string | number | null)[] = [userId];

  if (opts.scope === "system") {
    where.push("t.is_system = 1");
  } else if (opts.scope === "own") {
    where.push("t.is_system = 0 AND t.user_id = ?");
    args.push(userId);
  } else {
    where.push("(t.is_system = 1 OR (t.is_system = 0 AND t.user_id = ?))");
    args.push(userId);
  }
  if (opts.category !== undefined) {
    where.push("t.category = ?");
    args.push(opts.category);
  }
  if (opts.category_id !== undefined) {
    where.push("t.category_id = ?");
    args.push(opts.category_id);
  } else if (opts.uncategorized) {
    where.push("t.category_id IS NULL");
  }
  const sql = `SELECT t.*, COALESCE(o.sort_order, t.sort_order, 0) AS resolved_sort_order
               FROM checklist_templates t
               LEFT JOIN checklist_template_orders o
                 ON o.template_id = t.id
                AND o.user_id = ?
                AND o.deleted_at IS NULL
               WHERE ${where.join(" AND ")}
               ORDER BY resolved_sort_order ASC, t.updated_at DESC, t.title ASC, t.id ASC`;
  const res = await turso.execute({ sql, args });
  return (res.rows as unknown as Record<string, unknown>[]).map(mapTemplate);
};

export const getTemplateForUser = async (
  id: string,
  userId: string
): Promise<TemplateRow | null> => {
  const res = await turso.execute({
    sql: `SELECT t.*, COALESCE(o.sort_order, t.sort_order, 0) AS resolved_sort_order
          FROM checklist_templates t
          LEFT JOIN checklist_template_orders o
            ON o.template_id = t.id
           AND o.user_id = ?
           AND o.deleted_at IS NULL
          WHERE t.id = ? AND t.deleted_at IS NULL
            AND (t.is_system = 1 OR (t.is_system = 0 AND t.user_id = ?))`,
    args: [userId, id, userId],
  });
  if (res.rows.length === 0) return null;
  return mapTemplate(res.rows[0] as unknown as Record<string, unknown>);
};

const nextSortOrderForUser = async (
  userId: string,
  categoryId: string | null
): Promise<number> => {
  const where = [
    "t.deleted_at IS NULL",
    "(t.is_system = 1 OR (t.is_system = 0 AND t.user_id = ?))",
    categoryId === null ? "t.category_id IS NULL" : "t.category_id = ?",
  ];
  const args: (string | number | null)[] = [userId, userId];
  if (categoryId !== null) args.push(categoryId);

  const res = await turso.execute({
    sql: `SELECT COALESCE(MAX(COALESCE(o.sort_order, t.sort_order, 0)), 0) + 1 AS next_order
          FROM checklist_templates t
          LEFT JOIN checklist_template_orders o
            ON o.template_id = t.id
           AND o.user_id = ?
           AND o.deleted_at IS NULL
          WHERE ${where.join(" AND ")}`,
    args,
  });
  return Number((res.rows[0] as unknown as Record<string, unknown>).next_order ?? 1);
};

export const createUserTemplate = async (
  userId: string,
  input: CreateTemplateInput
): Promise<string> => {
  const templateId = newId();
  const sortOrder =
    input.sort_order ?? (await nextSortOrderForUser(userId, input.category_id ?? null));
  const now = nowISO();

  const stmts: { sql: string; args: (string | number | null)[] }[] = [
    {
      sql: `INSERT INTO checklist_templates
            (id, user_id, title, description, icon, category, category_id, sort_order, times_used, is_system, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      args: [
        templateId,
        userId,
        input.title,
        input.description ?? null,
        input.icon ?? null,
        input.category ?? null,
        input.category_id ?? null,
        sortOrder,
        now,
        now,
      ],
    },
    {
      sql: `INSERT INTO checklist_template_orders
            (id, user_id, template_id, sort_order, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [newId(), userId, templateId, sortOrder, now, now],
    },
    ...input.items.map((it, idx) => ({
      sql: `INSERT INTO checklist_template_items
            (id, template_id, position, title, description, is_required, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId(),
        templateId,
        idx + 1,
        it.title,
        it.description ?? null,
        it.is_required,
        now,
        now,
      ] as (string | number | null)[],
    })),
  ];

  await turso.batch(stmts, "write");
  return templateId;
};

export const updateUserTemplate = async (
  id: string,
  userId: string,
  patch: { title?: string; description?: string | null; icon?: string | null; category?: string | null; category_id?: string | null }
): Promise<boolean> => {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.title !== undefined) { sets.push("title = ?"); args.push(patch.title); }
  if (patch.description !== undefined) { sets.push("description = ?"); args.push(patch.description); }
  if (patch.icon !== undefined) { sets.push("icon = ?"); args.push(patch.icon); }
  if (patch.category !== undefined) { sets.push("category = ?"); args.push(patch.category); }
  if (patch.category_id !== undefined) { sets.push("category_id = ?"); args.push(patch.category_id); }
  if (sets.length === 0) return true;
  sets.push("updated_at = ?");
  args.push(nowISO());
  args.push(id, userId);
  const res = await turso.execute({
    sql: `UPDATE checklist_templates SET ${sets.join(", ")}
          WHERE id = ? AND user_id = ? AND is_system = 0 AND deleted_at IS NULL`,
    args,
  });
  return res.rowsAffected > 0;
};

export const reorderTemplatesForUser = async (
  userId: string,
  input: {
    template_ids: string[];
    category_id?: string | null;
    uncategorized?: boolean;
  }
): Promise<boolean> => {
  const ids = input.template_ids;
  if (new Set(ids).size !== ids.length) return false;

  const where = [
    "deleted_at IS NULL",
    "(is_system = 1 OR (is_system = 0 AND user_id = ?))",
    `id IN (${ids.map(() => "?").join(", ")})`,
  ];
  const args: (string | number | null)[] = [userId, ...ids];
  if (input.category_id !== undefined && input.category_id !== null) {
    where.push("category_id = ?");
    args.push(input.category_id);
  } else if (input.uncategorized || input.category_id === null) {
    where.push("category_id IS NULL");
  }

  const check = await turso.execute({
    sql: `SELECT COUNT(*) AS c FROM checklist_templates WHERE ${where.join(" AND ")}`,
    args,
  });
  if (Number((check.rows[0] as unknown as Record<string, unknown>).c) !== ids.length) {
    return false;
  }

  const now = nowISO();
  const stmts = ids.map((templateId, idx) => ({
    sql: `INSERT INTO checklist_template_orders
          (id, user_id, template_id, sort_order, created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(user_id, template_id) DO UPDATE SET
            sort_order = excluded.sort_order,
            updated_at = excluded.updated_at,
            deleted_at = NULL`,
    args: [newId(), userId, templateId, idx + 1, now, now] as (string | number | null)[],
  }));
  await turso.batch(stmts, "write");
  return true;
};

export const softDeleteUserTemplate = async (
  id: string,
  userId: string
): Promise<boolean> => {
  const now = nowISO();
  // §7.2 Cascade: soft-delete template → soft-delete items trong cùng transaction
  const res = await turso.batch(
    [
      {
        sql: `UPDATE checklist_templates
              SET deleted_at = ?, updated_at = ?
              WHERE id = ? AND user_id = ? AND is_system = 0 AND deleted_at IS NULL`,
        args: [now, now, id, userId],
      },
      {
        sql: `UPDATE checklist_template_items
              SET deleted_at = ?, updated_at = ?
              WHERE template_id = ? AND deleted_at IS NULL`,
        args: [now, now, id],
      },
      {
        sql: `UPDATE checklist_template_orders
              SET deleted_at = ?, updated_at = ?
              WHERE template_id = ? AND user_id = ? AND deleted_at IS NULL`,
        args: [now, now, id, userId],
      },
      {
        sql: `UPDATE checklist_schedules
              SET deleted_at = ?, updated_at = ?
              WHERE template_id = ? AND user_id = ? AND deleted_at IS NULL`,
        args: [now, now, id, userId],
      },
      {
        sql: `UPDATE checklist_schedule_overrides
              SET deleted_at = ?, updated_at = ?
              WHERE template_id = ? AND user_id = ? AND deleted_at IS NULL`,
        args: [now, now, id, userId],
      },
    ],
    "write"
  );
  return (res[0].rowsAffected ?? 0) > 0;
};

const userTemplateGuardSql =
  "id IN (SELECT id FROM checklist_templates WHERE user_id = ? AND is_system = 0 AND deleted_at IS NULL)";

export const addItemUserScoped = async (
  templateId: string,
  userId: string,
  input: { title: string; description?: string | null; is_required: number }
): Promise<string | null> => {
  // Verify template thuộc user và lấy next position
  const tpl = await turso.execute({
    sql: `SELECT 1 FROM checklist_templates
          WHERE id = ? AND user_id = ? AND is_system = 0 AND deleted_at IS NULL`,
    args: [templateId, userId],
  });
  if (tpl.rows.length === 0) return null;

  const maxRes = await turso.execute({
    sql: "SELECT COALESCE(MAX(position), 0) AS m FROM checklist_template_items WHERE template_id = ? AND deleted_at IS NULL",
    args: [templateId],
  });
  const nextPos = Number((maxRes.rows[0] as Record<string, unknown>).m) + 1;
  const itemId = newId();
  const now = nowISO();
  await turso.batch(
    [
      {
        sql: `INSERT INTO checklist_template_items
              (id, template_id, position, title, description, is_required, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [itemId, templateId, nextPos, input.title, input.description ?? null, input.is_required, now, now],
      },
      {
        sql: "UPDATE checklist_templates SET updated_at = ? WHERE id = ?",
        args: [now, templateId],
      },
    ],
    "write"
  );
  return itemId;
};

export const updateItemUserScoped = async (
  itemId: string,
  templateId: string,
  userId: string,
  patch: { title?: string; description?: string | null; is_required?: number }
): Promise<boolean> => {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.title !== undefined) { sets.push("title = ?"); args.push(patch.title); }
  if (patch.description !== undefined) { sets.push("description = ?"); args.push(patch.description); }
  if (patch.is_required !== undefined) { sets.push("is_required = ?"); args.push(patch.is_required); }
  if (sets.length === 0) return true;
  sets.push("updated_at = ?");
  args.push(nowISO());
  args.push(itemId, templateId, userId);
  const res = await turso.execute({
    sql: `UPDATE checklist_template_items
          SET ${sets.join(", ")}
          WHERE id = ? AND template_id = ?
            AND template_id IN (
              SELECT id FROM checklist_templates
              WHERE user_id = ? AND is_system = 0 AND deleted_at IS NULL
            )`,
    args,
  });
  return res.rowsAffected > 0;
};

export const deleteItemUserScoped = async (
  itemId: string,
  templateId: string,
  userId: string
): Promise<boolean> => {
  const now = nowISO();
  const res = await turso.execute({
    sql: `UPDATE checklist_template_items
          SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND template_id = ?
            AND deleted_at IS NULL
            AND template_id IN (
              SELECT id FROM checklist_templates
              WHERE user_id = ? AND is_system = 0 AND deleted_at IS NULL
            )`,
    args: [now, now, itemId, templateId, userId],
  });
  return res.rowsAffected > 0;
};

export const reorderItemsUserScoped = async (
  templateId: string,
  userId: string,
  itemIds: string[]
): Promise<boolean> => {
  const tpl = await turso.execute({
    sql: `SELECT 1 FROM checklist_templates
          WHERE id = ? AND user_id = ? AND is_system = 0 AND deleted_at IS NULL`,
    args: [templateId, userId],
  });
  if (tpl.rows.length === 0) return false;
  // Verify mọi item thuộc template
  const placeholders = itemIds.map(() => "?").join(", ");
  const check = await turso.execute({
    sql: `SELECT COUNT(*) AS c FROM checklist_template_items
          WHERE template_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
    args: [templateId, ...itemIds],
  });
  if (Number((check.rows[0] as Record<string, unknown>).c) !== itemIds.length) {
    return false;
  }
  const now = nowISO();
  const stmts = itemIds.map((id, idx) => ({
    sql: "UPDATE checklist_template_items SET position = ?, updated_at = ? WHERE id = ?",
    args: [idx + 1, now, id] as (string | number)[],
  }));
  await turso.batch(stmts, "write");
  return true;
};

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";

const { turso } = await import("../src/config/db.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const checklists = await import("../src/services/checklists.js");
const { processPush } = await import("../src/services/sync.service.js");
const { getChangesSince } = await import("../src/repositories/sync.repo.js");
const { newId, SYSTEM_USER_ID } = await import("../src/utils/id.js");

const USER_A = "11111111-1111-7111-8111-111111111111";
const USER_B = "22222222-2222-7222-8222-222222222222";
const NOW = "2026-01-01T00:00:00.000Z";

const insertUser = async (id: string): Promise<void> => {
  await turso.execute({
    sql: `INSERT INTO users
          (id, email, password_hash, timezone, is_admin, created_at, updated_at)
          VALUES (?, ?, 'test-hash', 'Asia/Ho_Chi_Minh', 0, ?, ?)`,
    args: [id, `${id}@test.local`, NOW, NOW],
  });
};

const insertTemplate = async (
  input: {
    id: string;
    userId?: string;
    title: string;
    categoryId?: string | null;
    sortOrder?: number;
    isSystem?: number;
    updatedAt?: string;
  }
): Promise<void> => {
  await turso.execute({
    sql: `INSERT INTO checklist_templates
          (id, user_id, title, description, icon, category, category_id,
           sort_order, is_system, times_used, last_used_at, created_at, updated_at)
          VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, 0, NULL, ?, ?)`,
    args: [
      input.id,
      input.userId ?? USER_A,
      input.title,
      input.categoryId ?? null,
      input.sortOrder ?? 0,
      input.isSystem ?? 0,
      NOW,
      input.updatedAt ?? NOW,
    ],
  });
};

const listedIds = async (
  userId: string,
  query: Parameters<typeof checklists.listTemplates>[1] = { scope: "all" }
): Promise<string[]> => {
  const listed = await checklists.listTemplates(userId, query);
  return listed.items.map((item) => item.id);
};

before(() => applyAllMigrations(turso));
after(() => turso.close());

beforeEach(async () => {
  for (const table of [
    "checklist_run_items",
    "checklist_runs",
    "checklist_template_items",
    "checklist_template_orders",
    "checklist_templates",
    "checklist_categories",
    "habit_logs",
    "habits",
    "notes",
    "todos",
    "tags",
    "users",
  ]) {
    await turso.execute(`DELETE FROM ${table}`);
  }
  await insertUser(USER_A);
  await insertUser(USER_B);
});

test("old checklist templates without user order resolve sort_order to default 0", async () => {
  const id = newId();
  await insertTemplate({ id, title: "Old template" });

  const detail = await checklists.getTemplateDetail(USER_A, id);

  assert.equal(detail.template.sort_order, 0);
});

test("new checklist template is appended to the current uncategorized list", async () => {
  await insertTemplate({ id: newId(), title: "Old A" });
  await insertTemplate({ id: newId(), title: "Old B" });

  const created = await checklists.createTemplate(USER_A, {
    title: "New bottom",
    items: [{ title: "Step", is_required: true }],
  });

  assert.equal(created.template.sort_order, 1);
  const ids = await listedIds(USER_A, { scope: "own", uncategorized: true });
  assert.equal(ids.at(-1), created.template.id);
});

test("reorder multiple checklist templates stores user order", async () => {
  const first = await checklists.createTemplate(USER_A, {
    title: "First",
    items: [{ title: "Step", is_required: true }],
  });
  const second = await checklists.createTemplate(USER_A, {
    title: "Second",
    items: [{ title: "Step", is_required: true }],
  });
  const third = await checklists.createTemplate(USER_A, {
    title: "Third",
    items: [{ title: "Step", is_required: true }],
  });

  const result = await checklists.reorderTemplates(USER_A, {
    template_ids: [third.template.id, first.template.id, second.template.id],
    uncategorized: true,
  });

  assert.deepEqual(
    result.items.slice(0, 3).map((item) => [item.id, item.sort_order]),
    [
      [third.template.id, 1],
      [first.template.id, 2],
      [second.template.id, 3],
    ]
  );
});

test("reorder with category_id only affects that category view", async () => {
  const { category } = await checklists.createCategory(USER_A, {
    name: "Code",
    color: "#3366ff",
  });
  const catA = await checklists.createTemplate(USER_A, {
    title: "Code A",
    category_id: category.id,
    items: [{ title: "Step", is_required: true }],
  });
  const catB = await checklists.createTemplate(USER_A, {
    title: "Code B",
    category_id: category.id,
    items: [{ title: "Step", is_required: true }],
  });
  const uncat = await checklists.createTemplate(USER_A, {
    title: "No category",
    items: [{ title: "Step", is_required: true }],
  });

  const result = await checklists.reorderTemplates(USER_A, {
    template_ids: [catB.template.id, catA.template.id],
    category_id: category.id,
  });

  assert.deepEqual(result.items.map((item) => item.id), [
    catB.template.id,
    catA.template.id,
  ]);
  assert.deepEqual(await listedIds(USER_A, { scope: "own", uncategorized: true }), [
    uncat.template.id,
  ]);
});

test("reordering system templates is user-scoped and does not mutate global rows", async () => {
  await insertUser(SYSTEM_USER_ID);
  const systemA = newId();
  const systemB = newId();
  await insertTemplate({
    id: systemA,
    userId: SYSTEM_USER_ID,
    title: "System A",
    isSystem: 1,
  });
  await insertTemplate({
    id: systemB,
    userId: SYSTEM_USER_ID,
    title: "System B",
    isSystem: 1,
  });

  await checklists.reorderTemplates(USER_A, {
    template_ids: [systemB, systemA],
    uncategorized: true,
  });

  assert.deepEqual(await listedIds(USER_A, { scope: "system", uncategorized: true }), [
    systemB,
    systemA,
  ]);
  assert.deepEqual(await listedIds(USER_B, { scope: "system", uncategorized: true }), [
    systemA,
    systemB,
  ]);

  const rows = await turso.execute({
    sql: `SELECT id, sort_order FROM checklist_templates
          WHERE id IN (?, ?)
          ORDER BY title ASC`,
    args: [systemA, systemB],
  });
  assert.deepEqual(
    (rows.rows as unknown as { id: string; sort_order: number }[]).map((row) => [
      row.id,
      Number(row.sort_order),
    ]),
    [
      [systemA, 0],
      [systemB, 0],
    ]
  );
});

test("sync push and changes carry checklist_template_order sort_order", async () => {
  const templateId = newId();
  const orderId = newId();
  await insertTemplate({ id: templateId, title: "Synced template" });

  const pushed = await processPush(USER_A, [
    {
      op: "create",
      type: "checklist_template_order",
      payload: {
        id: orderId,
        template_id: templateId,
        sort_order: 7,
        created_at: NOW,
        updated_at: "2026-01-02T00:00:00.000Z",
      },
    },
  ]);

  assert.equal(pushed[0]?.status, "applied");

  const changes = await getChangesSince(USER_A, null);
  const order = changes.checklist_template_orders.find((item) => item.id === orderId);
  assert.ok(order);
  assert.equal(order.template_id, templateId);
  assert.equal(order.sort_order, 7);

  const template = changes.checklist_templates.find((item) => item.id === templateId);
  assert.ok(template);
  assert.equal(template.sort_order, 0);
});

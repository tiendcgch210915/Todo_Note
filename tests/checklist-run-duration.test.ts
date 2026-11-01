import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

process.env.TURSO_DATABASE_URL = "file::memory:";
process.env.TURSO_AUTH_TOKEN = "";

const { turso } = await import("../src/config/db.js");
const { applyAllMigrations } = await import("./helpers/migrations.js");
const checklists = await import("../src/services/checklists.js");
const { CompleteRunSchema } = await import("../src/schemas/api/checklists.js");
const { processPush } = await import("../src/services/sync.service.js");
const { getChangesSince } = await import("../src/repositories/sync.repo.js");
const { newId } = await import("../src/utils/id.js");

const USER_ID = "11111111-1111-7111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-7222-8222-222222222222";
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
  id: string,
  userId = USER_ID
): Promise<string> => {
  await turso.execute({
    sql: `INSERT INTO checklist_templates
          (id, user_id, title, description, icon, category, category_id,
           sort_order, is_system, times_used, last_used_at, created_at, updated_at)
          VALUES (?, ?, ?, NULL, NULL, NULL, NULL, 0, 0, 0, NULL, ?, ?)`,
    args: [id, userId, `Template ${id}`, NOW, NOW],
  });

  const itemId = newId();
  await turso.execute({
    sql: `INSERT INTO checklist_template_items
          (id, template_id, position, title, description, is_required, created_at, updated_at)
          VALUES (?, ?, 1, 'Required step', NULL, 1, ?, ?)`,
    args: [itemId, id, NOW, NOW],
  });
  return itemId;
};

const insertRun = async (
  input: {
    id: string;
    templateId: string;
    itemId: string;
    itemStatus?: "pending" | "done" | "skipped";
    durationMs?: number | null;
  }
): Promise<void> => {
  await turso.batch(
    [
      {
        sql: `INSERT INTO checklist_runs
              (id, template_id, user_id, name, status, started_at, completed_at,
               duration_ms, created_at, updated_at)
              VALUES (?, ?, ?, NULL, 'in_progress', ?, NULL, ?, ?, ?)`,
        args: [
          input.id,
          input.templateId,
          USER_ID,
          NOW,
          input.durationMs ?? null,
          NOW,
          NOW,
        ],
      },
      {
        sql: `INSERT INTO checklist_run_items
              (id, run_id, template_item_id, status, completed_at, note, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        args: [
          newId(),
          input.id,
          input.itemId,
          input.itemStatus ?? "done",
          input.itemStatus === "done" ? NOW : null,
          NOW,
          NOW,
        ],
      },
    ],
    "write"
  );
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
  await insertUser(USER_ID);
  await insertUser(OTHER_USER_ID);
});

test("complete run stores provided duration_ms and exposes it in detail/list", async () => {
  const templateId = newId();
  const itemId = await insertTemplate(templateId);
  const runId = newId();
  await insertRun({ id: runId, templateId, itemId });

  const completed = await checklists.completeRun(USER_ID, runId, {
    duration_ms: 90_000,
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.duration_ms, 90_000);

  const detail = await checklists.getRunDetail(USER_ID, runId);
  assert.equal(detail.run.duration_ms, 90_000);

  const listed = await checklists.listRuns(USER_ID, {
    status: "completed",
    limit: 20,
  });
  assert.equal(listed.rows[0]?.duration_ms, 90_000);
});

test("complete run without duration keeps duration_ms null", async () => {
  const templateId = newId();
  const itemId = await insertTemplate(templateId);
  const runId = newId();
  await insertRun({ id: runId, templateId, itemId });

  const completed = await checklists.completeRun(USER_ID, runId, {});

  assert.equal(completed.status, "completed");
  assert.equal(completed.duration_ms, null);
});

test("complete run is idempotent and does not overwrite stored duration_ms", async () => {
  const templateId = newId();
  const itemId = await insertTemplate(templateId);
  const runId = newId();
  await insertRun({ id: runId, templateId, itemId });

  await checklists.completeRun(USER_ID, runId, { duration_ms: 90_000 });
  const second = await checklists.completeRun(USER_ID, runId, {
    duration_ms: 5_000,
  });

  assert.equal(second.duration_ms, 90_000);
});

test("complete run still blocks pending required items", async () => {
  const templateId = newId();
  const itemId = await insertTemplate(templateId);
  const runId = newId();
  await insertRun({ id: runId, templateId, itemId, itemStatus: "pending" });

  await assert.rejects(
    () => checklists.completeRun(USER_ID, runId, { duration_ms: 90_000 }),
    { code: "incomplete_required" }
  );
});

test("complete run schema rejects invalid duration_ms", async () => {
  assert.equal(CompleteRunSchema.safeParse({ duration_ms: -1 }).success, false);
  assert.equal(CompleteRunSchema.safeParse({ duration_ms: 1.5 }).success, false);
  assert.equal(
    CompleteRunSchema.safeParse({ duration_ms: "90000" }).success,
    false
  );
});

test("list runs can filter by template_id", async () => {
  const firstTemplateId = newId();
  const firstItemId = await insertTemplate(firstTemplateId);
  const secondTemplateId = newId();
  const secondItemId = await insertTemplate(secondTemplateId);

  const firstRunId = newId();
  const secondRunId = newId();
  await insertRun({ id: firstRunId, templateId: firstTemplateId, itemId: firstItemId });
  await insertRun({ id: secondRunId, templateId: secondTemplateId, itemId: secondItemId });

  const listed = await checklists.listRuns(USER_ID, {
    template_id: secondTemplateId,
    limit: 20,
  });

  assert.deepEqual(
    listed.rows.map((row) => row.id),
    [secondRunId]
  );
});

test("sync push and changes preserve checklist_run duration_ms", async () => {
  const templateId = newId();
  await insertTemplate(templateId);
  const runId = newId();

  const pushed = await processPush(USER_ID, [
    {
      op: "create",
      type: "checklist_run",
      payload: {
        id: runId,
        template_id: templateId,
        name: null,
        status: "completed",
        started_at: NOW,
        completed_at: "2026-01-01T00:05:00.000Z",
        duration_ms: 300_000,
        created_at: NOW,
        updated_at: "2026-01-01T00:05:00.000Z",
      },
    },
  ]);

  assert.equal(pushed[0]?.status, "applied");

  const changes = await getChangesSince(USER_ID, null);
  const run = changes.checklist_runs.find((item) => item.id === runId);
  assert.ok(run);
  assert.equal(run.duration_ms, 300_000);
});

test("sync push rejects invalid checklist_run duration_ms", async () => {
  const templateId = newId();
  await insertTemplate(templateId);
  const runId = newId();

  const pushed = await processPush(USER_ID, [
    {
      op: "create",
      type: "checklist_run",
      payload: {
        id: runId,
        template_id: templateId,
        status: "completed",
        started_at: NOW,
        completed_at: "2026-01-01T00:05:00.000Z",
        duration_ms: -1,
        created_at: NOW,
        updated_at: "2026-01-01T00:05:00.000Z",
      },
    },
  ]);

  assert.equal(pushed[0]?.status, "error");
  assert.equal(pushed[0]?.error, "bad_input");
});

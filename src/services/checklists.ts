import * as tplRepo from "../repositories/checklist-templates.js";
import * as catRepo from "../repositories/checklist-categories.js";
import * as runsRepo from "../repositories/checklist-runs.js";
import * as notificationTriggers from "./notification-triggers.js";
import type {
  CreateCategoryInput,
  UpdateCategoryInput,
  ListCategoriesQueryInput,
  CreateTemplateInput,
  UpdateTemplateInput,
  UpsertTemplateItemInput,
  PatchTemplateItemInput,
  ReorderItemsInput,
  ReorderTemplatesInput,
  ListTemplatesQueryInput,
  StartRunInput,
  CompleteRunInput,
  UpdateRunItemInput,
  ListRunsQueryInput,
} from "../schemas/api/checklists.js";

export class ServiceError extends Error {
  constructor(
    public code:
      | "not_found"
      | "incomplete_required"
      | "duplicate"
      | "invalid_category"
  ) {
    super(code);
  }
}

const wrapCategory = (e: unknown): never => {
  if (e instanceof catRepo.CategoryRepoError) {
    throw new ServiceError(e.code);
  }
  throw e;
};

const wrapRun = (e: unknown): never => {
  if (e instanceof runsRepo.RunRepoError) {
    throw new ServiceError(e.code);
  }
  throw e;
};

// ============================================================
// Categories
// ============================================================

export const listCategories = async (
  userId: string,
  query: ListCategoriesQueryInput
): Promise<{ items: catRepo.CategoryRow[] }> => {
  const items = await catRepo.listCategoriesForUser(userId, query);
  return { items };
};

export const getCategoryDetail = async (
  userId: string,
  id: string
): Promise<{ category: catRepo.CategoryRow }> => {
  const category = await catRepo.getCategoryForUser(id, userId);
  if (!category) throw new ServiceError("not_found");
  return { category };
};

export const createCategory = async (
  userId: string,
  input: CreateCategoryInput
): Promise<{ category: catRepo.CategoryRow }> => {
  try {
    const category = await catRepo.createUserCategory(userId, input);
    return { category };
  } catch (e) {
    return wrapCategory(e);
  }
};

export const updateCategory = async (
  userId: string,
  id: string,
  patch: UpdateCategoryInput
): Promise<catRepo.CategoryRow> => {
  try {
    const ok = await catRepo.updateUserCategory(id, userId, patch);
    if (!ok) throw new ServiceError("not_found");
  } catch (e) {
    return wrapCategory(e);
  }
  const row = await catRepo.getUserCategoryById(id, userId);
  if (!row) throw new ServiceError("not_found");
  return row;
};

export const deleteCategory = async (userId: string, id: string): Promise<void> => {
  const ok = await catRepo.softDeleteUserCategory(id, userId);
  if (!ok) throw new ServiceError("not_found");
};

// ============================================================
// Templates
// ============================================================

const resolveTemplateCategory = async (
  userId: string,
  input: {
    category_id?: string | null;
    category?: string | null;
  }
): Promise<{ category_id?: string | null; category?: string | null }> => {
  if (input.category_id !== undefined) {
    if (input.category_id === null) {
      return { category_id: null, category: input.category ?? null };
    }
    const category = await catRepo.getCategoryForUser(input.category_id, userId);
    if (!category) throw new ServiceError("invalid_category");
    return { category_id: category.id, category: category.name };
  }

  if (input.category !== undefined) {
    return { category_id: null, category: input.category };
  }

  return {};
};

export const listTemplates = async (
  userId: string,
  query: ListTemplatesQueryInput
): Promise<{
  items: (tplRepo.TemplateRow & { items_count?: number })[];
}> => {
  const items = await tplRepo.listTemplatesForUser(userId, query);
  return { items };
};

export const getTemplateDetail = async (
  userId: string,
  id: string
): Promise<{
  template: tplRepo.TemplateRow;
  items: tplRepo.ItemRow[];
}> => {
  const template = await tplRepo.getTemplateForUser(id, userId);
  if (!template) throw new ServiceError("not_found");
  const items = await tplRepo.listItems(id);
  return { template, items };
};

export const createTemplate = async (
  userId: string,
  input: CreateTemplateInput
): Promise<{ template: tplRepo.TemplateRow; items: tplRepo.ItemRow[] }> => {
  const categoryPatch = await resolveTemplateCategory(userId, input);
  const id = await tplRepo.createUserTemplate(userId, {
    title: input.title,
    description: input.description ?? null,
    icon: input.icon ?? null,
    category: categoryPatch.category ?? null,
    category_id: categoryPatch.category_id ?? null,
    sort_order: input.sort_order,
    items: input.items.map((i) => ({
      title: i.title,
      description: i.description ?? null,
      is_required: i.is_required ? 1 : 0,
    })),
  });
  const template = await tplRepo.getTemplateForUser(id, userId);
  if (!template) throw new ServiceError("not_found");
  const items = await tplRepo.listItems(id);
  return { template, items };
};

export const updateTemplate = async (
  userId: string,
  id: string,
  patch: UpdateTemplateInput
): Promise<tplRepo.TemplateRow> => {
  const categoryPatch = await resolveTemplateCategory(userId, patch);
  const ok = await tplRepo.updateUserTemplate(id, userId, {
    ...patch,
    ...categoryPatch,
  });
  if (!ok) throw new ServiceError("not_found");
  const row = await tplRepo.getTemplateForUser(id, userId);
  if (!row) throw new ServiceError("not_found");
  return row;
};

export const deleteTemplate = async (userId: string, id: string): Promise<void> => {
  const ok = await tplRepo.softDeleteUserTemplate(id, userId);
  if (!ok) throw new ServiceError("not_found");
};

export const reorderTemplates = async (
  userId: string,
  body: ReorderTemplatesInput
): Promise<{ items: tplRepo.TemplateRow[] }> => {
  const ok = await tplRepo.reorderTemplatesForUser(userId, body);
  if (!ok) throw new ServiceError("not_found");
  const items = await tplRepo.listTemplatesForUser(userId, {
    scope: "all",
    category_id: body.category_id ?? undefined,
    uncategorized: body.uncategorized || body.category_id === null,
  });
  return { items };
};

export const addTemplateItem = async (
  userId: string,
  templateId: string,
  input: UpsertTemplateItemInput
): Promise<tplRepo.ItemRow> => {
  const itemId = await tplRepo.addItemUserScoped(templateId, userId, {
    title: input.title,
    description: input.description ?? null,
    is_required: input.is_required ? 1 : 0,
  });
  if (!itemId) throw new ServiceError("not_found");
  const item = await tplRepo.getItemById(itemId);
  if (!item) throw new ServiceError("not_found");
  return item;
};

export const patchTemplateItem = async (
  userId: string,
  templateId: string,
  itemId: string,
  patch: PatchTemplateItemInput
): Promise<tplRepo.ItemRow> => {
  const ok = await tplRepo.updateItemUserScoped(itemId, templateId, userId, {
    title: patch.title,
    description: patch.description,
    is_required: patch.is_required === undefined ? undefined : patch.is_required ? 1 : 0,
  });
  if (!ok) throw new ServiceError("not_found");
  const item = await tplRepo.getItemById(itemId);
  if (!item) throw new ServiceError("not_found");
  return item;
};

export const deleteTemplateItem = async (
  userId: string,
  templateId: string,
  itemId: string
): Promise<void> => {
  const ok = await tplRepo.deleteItemUserScoped(itemId, templateId, userId);
  if (!ok) throw new ServiceError("not_found");
};

export const reorderTemplateItems = async (
  userId: string,
  templateId: string,
  body: ReorderItemsInput
): Promise<tplRepo.ItemRow[]> => {
  const ok = await tplRepo.reorderItemsUserScoped(
    templateId,
    userId,
    body.item_ids
  );
  if (!ok) throw new ServiceError("not_found");
  return tplRepo.listItems(templateId);
};

// ============================================================
// Runs
// ============================================================

export const startRun = async (
  userId: string,
  input: StartRunInput
): Promise<{ run: runsRepo.RunRow; items: runsRepo.RunItemDetail[] }> => {
  try {
    const runId = await runsRepo.startRun(
      userId,
      input.template_id,
      input.name ?? null
    );
    const run = await runsRepo.getRunById(runId, userId);
    if (!run) throw new ServiceError("not_found");
    const items = await runsRepo.listRunItems(runId);
    await notificationTriggers.onChecklistRunChanged(userId, runId);
    return { run, items };
  } catch (e) {
    return wrapRun(e);
  }
};

export const listRuns = async (
  userId: string,
  query: ListRunsQueryInput
): Promise<{ rows: runsRepo.RunRow[]; nextCursor: string | null }> => {
  return runsRepo.listRunsByUser(userId, query);
};

export const getRunDetail = async (
  userId: string,
  id: string
): Promise<{ run: runsRepo.RunRow; items: runsRepo.RunItemDetail[] }> => {
  const run = await runsRepo.getRunById(id, userId);
  if (!run) throw new ServiceError("not_found");
  const items = await runsRepo.listRunItems(id);
  return { run, items };
};

export const updateRunItem = async (
  userId: string,
  _runId: string,
  itemId: string,
  patch: UpdateRunItemInput
): Promise<runsRepo.RunItemDetail> => {
  const ok = await runsRepo.updateRunItem(itemId, userId, patch);
  if (!ok) throw new ServiceError("not_found");
  const items = await runsRepo.listRunItems(_runId);
  const updated = items.find((i) => i.id === itemId);
  if (!updated) throw new ServiceError("not_found");
  return updated;
};

export const completeRun = async (
  userId: string,
  id: string,
  body: CompleteRunInput
): Promise<runsRepo.RunRow> => {
  try {
    const run = await runsRepo.completeRun(id, userId, body.duration_ms ?? null);
    await notificationTriggers.onChecklistRunChanged(userId, id);
    return run;
  } catch (e) {
    return wrapRun(e);
  }
};

export const abandonRun = async (userId: string, id: string): Promise<void> => {
  const ok = await runsRepo.abandonRun(id, userId);
  if (!ok) throw new ServiceError("not_found");
  await notificationTriggers.onChecklistRunChanged(userId, id);
};

export const deleteRun = async (userId: string, id: string): Promise<void> => {
  const ok = await runsRepo.deleteRun(id, userId);
  if (!ok) throw new ServiceError("not_found");
  await notificationTriggers.onChecklistRunChanged(userId, id);
};

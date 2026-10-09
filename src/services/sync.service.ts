/**
 * sync.service.ts
 *
 * Business logic for sync push:
 *  - Ownership verification (§5.1)
 *  - LWW (Last-Write-Wins) (§5.2)
 *  - Server-only field stripping (§5.3) via fromSyncEntity
 *  - Junction reconcile (§5.4)
 *  - Tag natural-key conflict (§3.3)
 *  - Habit-log natural-key conflict (§3.5)
 *  - Recurring-occurrence (series, date) natural-key conflict (§3.6)
 *  - System-template protection (§8 read_only)
 *  - Soft-delete cascade (§6)
 */
import { nowISO } from "../utils/time.js";
import { fromSyncEntity } from "../sync/sync-serializer.js";
import type { SyncOp } from "../schemas/api/sync.js";
import * as habitsRepo from "../repositories/habits.js";
import * as todosRepo from "../repositories/todos.js";
import * as notesRepo from "../repositories/notes.js";
import * as todosService from "./todos.js";
import * as notesService from "./notes.js";
import { autoLogHabitForCompletedTodo } from "./todo-habit-logs.js";
import { ensurePastTodoDayClosedForMutation } from "./daily-todo-logs.js";
import {
  getEntityInfo,
  isSystemTemplate,
  isSystemCategory,
  getTagByNaturalKey,
  getHabitLogByNaturalKey,
  getLiveOccurrenceBySeriesDate,
  resurrectTagRow,
  resurrectHabitLogRow,
  getFullEntity,
  upsertEntity,
  softDeleteEntity,
  reconcileJunctions,
} from "../repositories/sync.repo.js";

const hasOwn = (obj: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

const TODO_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const todoDeleteScope = (
  payload: Record<string, unknown>
): todosRepo.TodoDeleteScope | null => {
  const raw = payload.delete_scope ?? payload.scope ?? "this";
  if (raw === "this") return "this";
  if (raw === "future" || raw === "this_and_future") return "future";
  if (raw === "all") return "all";
  return null;
};

// ── Result type ───────────────────────────────────────────────────────────────

export type OpResult = {
  id: string;
  status: "applied" | "conflict" | "error";
  server_version?: Record<string, unknown>;
  error?: string;
};

// ── processPush ───────────────────────────────────────────────────────────────

/**
 * Process a batch of sync operations for one user.
 * Operations are independent — one error does NOT roll back others.
 */
export const processPush = async (
  userId: string,
  ops: SyncOp[]
): Promise<OpResult[]> => {
  const results: OpResult[] = [];
  // Todos the server refused to create (§3.6). Their cloned subtree travels in
  // the same batch; inserting it would break the parent_id foreign key and fail
  // the whole request, so those operations are skipped instead.
  const refused = new Set<string>();
  for (const op of ops) {
    results.push(await processOp(userId, op, refused));
  }
  return results;
};

// ── processOp (per-operation logic) ──────────────────────────────────────────

async function processOp(
  userId: string,
  op: SyncOp,
  refused: Set<string>
): Promise<OpResult> {
  const { op: opType, type, payload } = op;

  // id must be present and a string
  const id = payload.id;
  if (!id || typeof id !== "string") {
    return { id: "unknown", status: "error", error: "bad_input" };
  }

  // A child of a refused occurrence (or a trigger pointing into it) has nothing
  // to attach to. Mobile already purged that local subtree when it processes the
  // parent's conflict, so acknowledging the operation is what lets it clear it.
  if (type === "todo" && opType !== "delete") {
    const parentId = payload.parent_id;
    const triggerId = payload.trigger_after_todo_id;
    if (
      (typeof parentId === "string" && refused.has(parentId)) ||
      (typeof triggerId === "string" && refused.has(triggerId))
    ) {
      refused.add(id);
      return { id, status: "applied" };
    }
  }

  if (
    type === "checklist_run" &&
    opType !== "delete" &&
    "duration_ms" in payload
  ) {
    const durationMs = payload.duration_ms;
    if (
      durationMs !== null &&
      (typeof durationMs !== "number" ||
        !Number.isInteger(durationMs) ||
        durationMs < 0)
    ) {
      return { id, status: "error", error: "bad_input" };
    }
  }

  if (
    type === "todo" &&
    opType !== "delete" &&
    hasOwn(payload, "time") &&
    payload.time !== null
  ) {
    if (typeof payload.time !== "string" || !TODO_TIME_RE.test(payload.time)) {
      return { id, status: "error", error: "bad_input" };
    }
  }

  if (
    type === "todo" &&
    opType !== "delete" &&
    hasOwn(payload, "habit_id") &&
    payload.habit_id !== null
  ) {
    if (typeof payload.habit_id !== "string") {
      return { id, status: "error", error: "bad_input" };
    }
    const habit = await habitsRepo.getHabitById(payload.habit_id, userId);
    if (!habit) return { id, status: "error", error: "invalid_habit" };
  }

  const deleteScope =
    type === "todo" && opType === "delete"
      ? todoDeleteScope(payload)
      : "this";
  if (deleteScope === null) {
    return { id, status: "error", error: "bad_input" };
  }

  // ── §5.3 Strip server-only fields + convert booleans ─────────────────────
  // fromSyncEntity does NOT strip junction fields (tag_ids, note_links, etc.)
  // so we can pass the original `payload` to reconcileJunctions later.
  const dbPayload = fromSyncEntity(payload, type);

  // ── §8 System-template protection ────────────────────────────────────────
  // system templates are read-only for mobile (create is also blocked
  // because is_system is a server field; but update/delete must be blocked).
  if (type === "checklist_template" && opType !== "create") {
    const sys = await isSystemTemplate(id);
    if (sys) return { id, status: "error", error: "read_only" };
  }
  if (type === "checklist_category" && opType !== "create") {
    const sys = await isSystemCategory(id);
    if (sys) return { id, status: "error", error: "read_only" };
  }

  // ── §5.1 Ownership check ─────────────────────────────────────────────────
  let entityInfo: { user_id: string | null; updated_at: string | null } | null = null;

  if (opType === "create") {
    // Force user_id = jwt.sub — ignore whatever mobile sent
    dbPayload.user_id = userId;
  } else {
    entityInfo = await getEntityInfo(type, id);

    if (entityInfo === null) {
      if (opType === "delete") {
        // Idempotent: entity already gone
        return { id, status: "applied" };
      }
      // update of non-existing → treat as implicit create
      dbPayload.user_id = userId;
    } else {
      if (entityInfo.user_id !== userId) {
        return { id, status: "error", error: "forbidden" };
      }
    }
  }

  if (type === "note" && opType !== "delete") {
    const currentNote =
      entityInfo === null
        ? null
        : await notesRepo.getNoteById(id);
    try {
      const normalizedContent = notesService.normalizeSyncNoteContent(
        currentNote,
        payload
      );
      Object.assign(
        dbPayload,
        fromSyncEntity(
          normalizedContent as unknown as Record<string, unknown>,
          "note"
        )
      );
    } catch (e) {
      if (
        e instanceof notesService.ServiceError &&
        e.code === "bad_input"
      ) {
        return { id, status: "error", error: "bad_input" };
      }
      throw e;
    }
  }

  // ── §3.3 Tag natural-key conflict ─────────────────────────────────────────
  if (type === "tag" && opType !== "delete") {
    const name = payload.name as string | undefined;
    if (name) {
      const nk = await getTagByNaturalKey(userId, name);
      if (nk && nk.id !== id) {
        // Different server row has same (user_id, name)
        if (nk.deleted_at !== null) {
          // Resurrect the dead row with the pushed data
          await resurrectTagRow(nk.id, {
            name: payload.name,
            color: payload.color,
            updated_at: payload.updated_at,
          });
        }
        // Either way: canonical id is nk.id — tell mobile to remap
        const sv = await getFullEntity("tag", nk.id, userId);
        return { id, status: "conflict", server_version: sv ?? {} };
      }
    }
  }

  // ── §3.5 Habit-log natural-key conflict ───────────────────────────────────
  if (type === "habit_log" && opType !== "delete") {
    const habitId = payload.habit_id as string | undefined;
    const logDate = payload.log_date as string | undefined;
    if (habitId && logDate) {
      const nk = await getHabitLogByNaturalKey(habitId, logDate, userId);
      if (nk && nk.id !== id) {
        if (nk.deleted_at !== null) {
          // Resurrect
          await resurrectHabitLogRow(nk.id, {
            completed: payload.completed,
            note: payload.note,
            updated_at: payload.updated_at,
          });
        }
        const sv = await getFullEntity("habit_log", nk.id, userId);
        return { id, status: "conflict", server_version: sv ?? {} };
      }
    }
  }

  // ── §3.6 Recurring-occurrence natural key (series, date) ──────────────────
  // Two devices completing the same todo offline each create "the next
  // occurrence" under different ids. Only the first one in wins; the other gets
  // the canonical row back and drops its local duplicate. Rows that already
  // exist are left alone so a reschedule can never make an occurrence vanish.
  if (type === "todo" && opType !== "delete" && entityInfo === null) {
    const seriesId = payload.recurrence_template_id;
    const scheduledDate = payload.scheduled_date;
    if (
      typeof seriesId === "string" &&
      typeof scheduledDate === "string" &&
      payload.recurrence_type != null &&
      payload.parent_id == null
    ) {
      const canonical = await getLiveOccurrenceBySeriesDate(
        userId,
        seriesId,
        scheduledDate,
        id
      );
      if (canonical) {
        refused.add(id);
        const sv = await getFullEntity("todo", canonical.id, userId);
        return { id, status: "conflict", server_version: sv ?? {} };
      }
    }
  }

  // ── §5.2 LWW ─────────────────────────────────────────────────────────────
  if (entityInfo !== null && entityInfo.updated_at !== null) {
    const serverUA = entityInfo.updated_at;
    const payloadUA = payload.updated_at as string | undefined;

    if (payloadUA) {
      if (payloadUA < serverUA) {
        // Server wins — return current server state
        const sv = await getFullEntity(type, id, userId);
        return { id, status: "conflict", server_version: sv ?? {} };
      }
      if (payloadUA === serverUA) {
        // Exact same timestamp → no-op, but still "applied"
        return { id, status: "applied" };
      }
      // payloadUA > serverUA → client wins → APPLY (fall through)
    }
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  const beforeTodo =
    type === "todo" && opType !== "delete"
      ? await todosRepo.getTodoByIdScoped(id, userId)
      : null;
  let frogDateToEnforce: string | null = null;
  let frogUpdatedAt: string | undefined;

  if (type === "todo" && opType !== "delete") {
    await ensurePastTodoDayClosedForMutation(
      userId,
      beforeTodo?.scheduled_date
    );
    if (hasOwn(dbPayload, "scheduled_date")) {
      await ensurePastTodoDayClosedForMutation(
        userId,
        (dbPayload.scheduled_date as string | null) ?? null
      );
    }

    const finalParentId = hasOwn(dbPayload, "parent_id")
      ? (dbPayload.parent_id as string | null) ?? null
      : beforeTodo?.parent_id ?? null;
    const finalScheduledDate = hasOwn(dbPayload, "scheduled_date")
      ? (dbPayload.scheduled_date as string | null) ?? null
      : beforeTodo?.scheduled_date ?? null;
    const finalTime = hasOwn(dbPayload, "time")
      ? (dbPayload.time as string | null) ?? null
      : beforeTodo?.time ?? null;
    const finalFrogDate = hasOwn(dbPayload, "frog_date")
      ? (dbPayload.frog_date as string | null) ?? null
      : beforeTodo?.is_frog === 1 && hasOwn(dbPayload, "scheduled_date")
        ? finalScheduledDate
        : beforeTodo?.frog_date ?? null;
    const clearFrogBecauseDateRemoved =
      beforeTodo?.is_frog === 1 &&
      !hasOwn(dbPayload, "is_frog") &&
      hasOwn(dbPayload, "scheduled_date") &&
      finalScheduledDate === null &&
      !hasOwn(dbPayload, "frog_date");
    const finalIsFrog = clearFrogBecauseDateRemoved
      ? false
      : hasOwn(dbPayload, "is_frog")
      ? Number(dbPayload.is_frog) === 1
      : beforeTodo?.is_frog === 1;

    if (finalTime !== null && (finalParentId !== null || finalScheduledDate === null)) {
      return { id, status: "error", error: "bad_input" };
    }
    if (finalIsFrog) {
      frogDateToEnforce = finalFrogDate ?? finalScheduledDate;
      if (!frogDateToEnforce) {
        return { id, status: "error", error: "bad_input" };
      }
      dbPayload.is_frog = 1;
      dbPayload.frog_date = frogDateToEnforce;
      dbPayload.is_important = 1;
      dbPayload.is_urgent = 1;
      frogUpdatedAt =
        typeof payload.updated_at === "string" ? payload.updated_at : undefined;
    } else if (clearFrogBecauseDateRemoved) {
      dbPayload.is_frog = 0;
      dbPayload.frog_date = null;
    } else if (
      hasOwn(dbPayload, "is_frog") &&
      Number(dbPayload.is_frog) === 0 &&
      !hasOwn(dbPayload, "frog_date")
    ) {
      dbPayload.frog_date = null;
    }
  }

  if (opType === "delete") {
    const delAt = (payload.deleted_at as string | undefined) ?? nowISO();
    if (type === "todo") {
      try {
        await todosService.deleteTodo(userId, id, deleteScope, delAt);
      } catch (e) {
        if (
          e instanceof todosService.ServiceError &&
          e.code === "not_found"
        ) {
          return { id, status: "applied" };
        }
        throw e;
      }
    } else {
      await softDeleteEntity(type, id, delAt);
    }
  } else {
    await upsertEntity(userId, type, dbPayload, {
      partialUpdate: opType === "update" && entityInfo !== null,
    });

    // §5.4 Junction reconcile (todo / note only)
    // Skip entirely if all junction arrays are empty AND this is a create:
    // a brand-new entity has no existing junctions to remove, so reconciling
    // against empty arrays would be 3 pointless read round-trips.
    if (type === "todo" || type === "note") {
      const hasJunctions =
        (payload.tag_ids as unknown[] | undefined)?.length ||
        (payload.note_links as unknown[] | undefined)?.length ||
        (payload.linked_todo_ids as unknown[] | undefined)?.length;
      if (opType !== "create" || hasJunctions) {
        await reconcileJunctions(type, id, userId, payload);
      }
    }

    if (type === "todo") {
      if (frogDateToEnforce) {
        await todosRepo.setSingleFrogForDay(
          id,
          userId,
          frogDateToEnforce,
          frogUpdatedAt
        );
      }
      const afterTodo = await todosRepo.getTodoByIdScoped(id, userId);
      if (afterTodo?.status === "done" && beforeTodo?.status !== "done") {
        await autoLogHabitForCompletedTodo(userId, afterTodo);
      }
    }
  }

  return { id, status: "applied" };
}

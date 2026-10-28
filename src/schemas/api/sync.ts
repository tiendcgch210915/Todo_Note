/**
 * sync.ts — Zod schemas for sync endpoints
 *
 * API_CONTRACT §4 (pull) + §5 (push)
 */
import { z } from "zod";

// ── Pull ─────────────────────────────────────────────────────────────────────

/** GET /api/v1/sync/changes?since=<ISO> */
export const PullQuerySchema = z.object({
  since: z.iso.datetime({ offset: true }).optional(),
});
export type PullQuery = z.infer<typeof PullQuerySchema>;

// ── Push ─────────────────────────────────────────────────────────────────────

/** Entity type enum — mirrors sync-serializer EntityType */
export const EntityTypeEnum = z.enum([
  "todo",
  "note",
  "tag",
  "habit",
  "habit_log",
  "checklist_category",
  "checklist_template",
  "checklist_template_order",
  "checklist_template_item",
  "checklist_run",
  "checklist_run_item",
  "checklist_schedule",
  "checklist_schedule_override",
  "checklist_occurrence_mark",
  "user",
]);

export const SyncOpSchema = z.object({
  op: z.enum(["create", "update", "delete"]),
  type: EntityTypeEnum,
  payload: z.record(z.string(), z.unknown()),
});
export type SyncOp = z.infer<typeof SyncOpSchema>;

/** POST /api/v1/sync/push — max 100 ops per §5 */
export const PushBodySchema = z.object({
  operations: z.array(SyncOpSchema).min(1).max(100),
});
export type PushBody = z.infer<typeof PushBodySchema>;

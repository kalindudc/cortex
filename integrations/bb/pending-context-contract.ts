import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { sectionEligibilitySchema } from "./section-contract";
import { actorSchema, contextThreadIdSchema, knowledgeIdSchema, workstreamIdSchema } from "./workstream-contract";

/** The mention provider whose pill references a pending selection; bb sends its items as `<provider>:<id>`. */
export const PENDING_MENTION_PROVIDER = "new-thread-context";
/** A pending selection lives this long after its last change; an unsent draft keeps it only that long. */
export const PENDING_TTL_MS = 2 * 60 * 60 * 1000;
export const PENDING_CHANGE_MAX = 50;
export const PENDING_UNKNOWN =
  "Cortex has no record of the changes this Cortex pill refers to, so nothing was changed. Remove the pill and send again; the thread then starts with the section brief as shared.";

const timestamp = z.string().datetime();
const sectionId = z.string().min(1).max(100);
export const pendingIdSchema = z.string().uuid();
const projectId = z.string().min(1).max(200);
const draftKey = z.string().min(1).max(500);

/** One thread-only change: leave the entry out, or replace its text. Never both, never neither. */
export const pendingChangeSchema = z
  .object({
    knowledgeId: knowledgeIdSchema,
    canonicalRevision: z.number().int().positive(),
    excluded: z.boolean(),
    text: z.string().trim().min(1).max(24000).nullable(),
  })
  .strict()
  .refine(change => change.excluded !== (change.text !== null), {
    message: "A change either leaves an entry out or replaces its text.",
  });

export const pendingSelectionSchema = z
  .object({
    id: pendingIdSchema,
    projectId,
    sectionId,
    workstreamId: workstreamIdSchema,
    bindingRevision: z.number().int().positive(),
    draftKey,
    actor: actorSchema,
    caller: z.literal("client"),
    singleUse: z.literal(true),
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp,
    changes: z.array(pendingChangeSchema).min(1).max(PENDING_CHANGE_MAX),
    usedBy: contextThreadIdSchema.nullable(),
    usedAt: timestamp.nullable(),
    refusedPlacement: z.object({ sectionId: sectionId.nullable(), at: timestamp.optional() }).strict().nullable().default(null),
  })
  .strict();

export const newThreadMemorySchema = z
  .object({
    mode: z.enum(["write", "read", "off"]),
    summary: z
      .object({
        cached: z.boolean(),
        ids: z.array(z.number().int().positive()),
        chars: z.number().int().nonnegative(),
        shortened: z.boolean(),
      })
      .strict(),
    lookup: z
      .object({ maxTasks: z.number().int().nonnegative(), providers: z.array(z.string()) })
      .strict()
      .nullable(),
  })
  .strict();

export const pendingContextRpcMethods = {
  newThreadContext: {
    input: z
      .object({ projectId: projectId.nullable(), sectionId: sectionId.nullable(), pendingId: pendingIdSchema.nullable() })
      .strict(),
    output: z
      .object({
        section: z
          .object({
            id: sectionId,
            bindingRevision: z.number().int().nonnegative(),
            requiredKnowledgeIds: z.array(knowledgeIdSchema).default([]),
            binding: z
              .object({ workstreamId: workstreamIdSchema, workstreamName: z.string(), topic: z.string().nullable() })
              .strict()
              .nullable(),
          })
          .strict()
          .nullable(),
        sectionSummaries: z.array(z.object({ sectionId, entries: z.number().int().nonnegative(), estimatedTokens: z.number().int().nonnegative(), budgetTokens: z.number().int().positive() }).strict()).default([]),
        base: sectionEligibilitySchema.nullable(),
        applied: sectionEligibilitySchema.nullable(),
        pending: pendingSelectionSchema.nullable(),
        pendingProblem: z.string().nullable(),
        memory: newThreadMemorySchema,
      })
      .strict(),
  },
  pendingContextSet: {
    input: z
      .object({
        pendingId: pendingIdSchema.nullable(),
        projectId,
        sectionId,
        expectedBindingRevision: z.number().int().positive(),
        draftKey,
        changes: z.array(pendingChangeSchema).max(PENDING_CHANGE_MAX),
      })
      .strict(),
    output: z.object({ pending: pendingSelectionSchema.nullable() }).strict(),
  },
};
export const pendingContextRpcContract = pendingContextRpcMethods satisfies PluginRpcContract;
export type PendingSelection = z.input<typeof pendingSelectionSchema>;
export type PendingChange = z.infer<typeof pendingChangeSchema>;
export type NewThreadMemory = z.infer<typeof newThreadMemorySchema>;

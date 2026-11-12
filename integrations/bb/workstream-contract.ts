import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const workstreamIdSchema = z
  .string()
  .regex(/^ws_[a-zA-Z0-9_-]+$/)
  .max(100);
export const knowledgeIdSchema = z
  .string()
  .regex(/^kn_[a-zA-Z0-9_-]+$/)
  .max(100);
export const contextThreadIdSchema = z.string().regex(/^thr_[0-9a-z]{6,40}$/);
const timestamp = z.string().datetime();
const revision = z.number().int().positive();
export const actorSchema = z
  .object({ id: z.string().min(1).max(200), type: z.enum(["human", "agent", "system"]) })
  .strict();
export const dimensionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("value"), value: z.string().min(1).max(200) }).strict(),
  z.object({ mode: z.literal("not-applicable") }).strict(),
  z.object({ mode: z.literal("unknown") }).strict(),
]);
export const applicabilitySchema = z.object({ environment: dimensionSchema, host: dimensionSchema }).strict();
export const KNOWLEDGE_SOURCE_EXCERPT_MAX = 8192;
export const SOURCE_EXCERPT_LIMIT_MESSAGE =
  "Source excerpts can contain at most 8192 characters. Select a shorter verified quote, or explicitly write/copy a manual takeaway. No evidence is clipped; an earlier pending write may still have succeeded.";
export const knowledgeSourceSchema = z
  .object({
    ref: z.string().min(1).max(2000),
    excerpt: z.string().max(KNOWLEDGE_SOURCE_EXCERPT_MAX, SOURCE_EXCERPT_LIMIT_MESSAGE).optional(),
    authorType: z.enum(["human", "agent", "system", "unknown"]),
    observedAt: timestamp,
    status: z.enum(["available", "archived", "unreachable"]).optional(),
  })
  .strict();
export const workstreamSchema = z
  .object({
    id: workstreamIdSchema,
    name: z.string(),
    description: z.string(),
    revision,
    archived: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
    actor: actorSchema,
  })
  .strict();
export const knowledgeStates = [
  "candidate",
  "approved",
  "disputed",
  "superseded",
  "recheck",
  "archived",
  "rejected",
  "forgotten",
] as const;
export const knowledgeSchema = z
  .object({
    id: knowledgeIdSchema,
    workstreamId: workstreamIdSchema,
    subject: z.string(),
    title: z.string(),
    text: z.string(),
    kind: z.enum(["directive", "finding"]),
    state: z.enum(knowledgeStates),
    facet: z.string(),
    applicability: applicabilitySchema,
    sources: z.array(knowledgeSourceSchema),
    revision,
    actor: actorSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp.nullable(),
    approval: z.object({ actor: actorSchema, at: timestamp }).strict().nullable(),
    supersedes: z.array(knowledgeIdSchema),
    supersededBy: knowledgeIdSchema.nullable(),
    conflicts: z.array(knowledgeIdSchema),
  })
  .strict();
export const contextNoticeSchema = z
  .object({ id: knowledgeIdSchema, revision, reason: z.string(), sources: z.array(knowledgeSourceSchema) })
  .strict();
export const measuredNoticeSchema = contextNoticeSchema.extend({ estimatedTokens: z.number().int().nonnegative() });
export const coreContextSchema = z
  .object({
    workstream: workstreamSchema,
    entries: z.array(knowledgeSchema),
    notices: z.array(contextNoticeSchema),
    applicability: applicabilitySchema,
    topic: z.string().nullable(),
  })
  .strict();
export const mutationResultSchema = z
  .object({
    outcome: z.enum(["created", "updated", "no-save"]),
    workstream: workstreamSchema.optional(),
    entry: knowledgeSchema.optional(),
    hints: z
      .array(
        z.object({ id: knowledgeIdSchema, reason: z.enum(["same-subject", "same-text", "shared-source"]) }).strict(),
      )
      .optional(),
    reason: z.string().optional(),
  })
  .strict();
export const bindingSchema = z
  .object({
    workstreamId: workstreamIdSchema,
    topic: z.string().trim().min(1).max(200).nullable(),
    budgetTokens: z.number().int().min(128).max(6000),
    requiredKnowledgeIds: z.array(knowledgeIdSchema).max(50),
    applicability: applicabilitySchema.optional(),
  })
  .strict();
export const bindingRowSchema = z
  .object({ key: z.string(), revision: z.number().int().nonnegative(), binding: bindingSchema.nullable() })
  .strict();
export const threadOverrideSchema = z
  .object({
    knowledgeId: knowledgeIdSchema,
    excluded: z.boolean(),
    text: z.string().min(1).max(24000).nullable(),
    canonicalRevision: revision,
    actor: actorSchema,
    updatedAt: timestamp,
  })
  .strict();
export const threadGrantSchema = z
  .object({
    kind: z.enum(["knowledge", "legacy-task"]),
    id: z.string().min(1).max(100),
    actor: actorSchema,
    grantedAt: timestamp,
    revokedAt: timestamp.nullable(),
  })
  .strict();
export const selectedContextSchema = z
  .object({
    knowledge: knowledgeSchema,
    text: z.string(),
    origin: z.enum(["canonical", "thread-only", "human-grant"]),
    overrideActor: actorSchema.nullable(),
    estimatedTokens: z.number().int().nonnegative(),
  })
  .strict();
export const deliveryReceiptSchema = z
  .object({
    id: z.string(),
    threadId: contextThreadIdSchema,
    emittedAt: timestamp,
    route: z.enum(["configure", "match", "recall"]),
    text: z.string(),
    estimatedTokens: z.number().int().nonnegative(),
    budgetTokens: z.number().int().positive(),
    binding: bindingSchema.nullable(),
    bindingRevision: z.number().int().nonnegative(),
    references: z.array(z.object({ id: z.string(), revision }).strict()),
  })
  .strict();
export const threadContextSchema = z
  .object({
    threadId: contextThreadIdSchema,
    revision: z.number().int().nonnegative(),
    binding: bindingSchema.nullable(),
    bindingRevision: z.number().int().nonnegative(),
    bindingSource: z.enum(["manual", "section", "parent", "none"]),
    inheritedFrom: contextThreadIdSchema.nullable(),
    workstream: workstreamSchema.nullable(),
    applicability: applicabilitySchema,
    entries: z.array(selectedContextSchema),
    notices: z.array(measuredNoticeSchema),
    exclusions: z.array(z.object({ id: z.string(), reason: z.string() }).strict()),
    overrides: z.array(threadOverrideSchema),
    grants: z.array(threadGrantSchema),
    exactText: z.string(),
    estimatedTokens: z.number().int().nonnegative(),
    budgetTokens: z.number().int().positive(),
    status: z.enum(["ready", "unbound", "over-budget", "missing-required", "unavailable"]),
    error: z.string().nullable(),
    dismissed: z.boolean(),
    dismissedPreference: z.boolean().nullable(),
    bindingChanged: z.boolean(),
    lastReceipt: deliveryReceiptSchema.nullable(),
  })
  .strict();
const page = { limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().nonnegative().default(0) };
const thread = { threadId: contextThreadIdSchema };
const expected = { expectedRevision: z.number().int().nonnegative() };
const reason = z.string().trim().min(1).max(4096);
export const proposalInputSchema = z
  .object({
    workstreamId: workstreamIdSchema,
    subject: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(500),
    text: z.string().trim().min(1).max(24000),
    kind: z.enum(["directive", "finding"]),
    facet: z.string().trim().min(1).max(200),
    applicability: applicabilitySchema,
    sources: z.array(knowledgeSourceSchema).max(50),
    expiresAt: timestamp.nullable().optional(),
  })
  .strict();
export const workstreamRpcMethods = {
  workstreamList: {
    input: z.object({ ...page, archived: z.boolean().default(false) }).strict(),
    output: z
      .object({ workstreams: z.array(workstreamSchema), total: z.number(), limit: z.number(), offset: z.number() })
      .strict(),
  },
  workstreamShow: {
    input: z.object({ id: workstreamIdSchema, ...page }).strict(),
    output: z
      .object({
        workstream: workstreamSchema,
        entries: z.array(knowledgeSchema),
        total: z.number(),
        limit: z.number(),
        offset: z.number(),
      })
      .strict(),
  },
  workstreamCreate: {
    input: z
      .object({ name: z.string().trim().min(1).max(200), description: z.string().max(24000).optional() })
      .strict(),
    output: mutationResultSchema,
  },
  workstreamEdit: {
    input: z
      .object({
        id: workstreamIdSchema,
        expectedRevision: revision,
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(24000).optional(),
        archived: z.boolean().optional(),
        reason,
      })
      .strict(),
    output: mutationResultSchema,
  },
  knowledgeShow: {
    input: z.object({ id: knowledgeIdSchema }).strict(),
    output: z.object({ entry: knowledgeSchema, workstream: workstreamSchema }).strict(),
  },
  knowledgePropose: { input: proposalInputSchema, output: mutationResultSchema },
  knowledgeEdit: {
    input: z
      .object({
        id: knowledgeIdSchema,
        expectedRevision: revision,
        title: z.string().min(1).max(500).optional(),
        text: z.string().min(1).max(24000).optional(),
        facet: z.string().min(1).max(200).optional(),
        sources: z.array(knowledgeSourceSchema).max(50).optional(),
        expiresAt: timestamp.nullable().optional(),
        reason,
      })
      .strict(),
    output: mutationResultSchema,
  },
  knowledgeEvidence: {
    input: z
      .object({
        id: knowledgeIdSchema,
        expectedRevision: revision,
        sources: z.array(knowledgeSourceSchema).min(1).max(50),
        reason,
      })
      .strict(),
    output: mutationResultSchema,
  },
  knowledgeTransition: {
    input: z
      .object({
        id: knowledgeIdSchema,
        expectedRevision: revision,
        state: z.enum(["approved", "recheck", "archived", "rejected", "forgotten"]),
        reason,
      })
      .strict(),
    output: mutationResultSchema,
  },
  knowledgeConflict: {
    input: z
      .object({
        id: knowledgeIdSchema,
        expectedRevision: revision,
        otherId: knowledgeIdSchema,
        otherExpectedRevision: revision,
        reason,
      })
      .strict(),
    output: mutationResultSchema,
  },
  knowledgeSupersede: {
    input: z
      .object({
        id: knowledgeIdSchema,
        expectedRevision: revision,
        otherId: knowledgeIdSchema,
        otherExpectedRevision: revision,
        reason,
      })
      .strict(),
    output: mutationResultSchema,
  },
  workstreamHistory: {
    input: z.object({ id: z.union([workstreamIdSchema, knowledgeIdSchema]), ...page }).strict(),
    output: z
      .object({
        revisions: z.array(
          z
            .object({
              id: z.string(),
              revision,
              actor: actorSchema,
              at: timestamp,
              action: z.string(),
              reason: z.string(),
              snapshot: z.union([workstreamSchema, knowledgeSchema]),
            })
            .strict(),
        ),
        total: z.number(),
        limit: z.number(),
        offset: z.number(),
      })
      .strict(),
  },
  knowledgeSearch: {
    input: z
      .object({
        query: z.string().trim().min(1).max(200),
        workstreamId: workstreamIdSchema.optional(),
        states: z.array(z.enum(knowledgeStates)).max(8).optional(),
        ...page,
      })
      .strict(),
    output: z
      .object({
        items: z.array(
          z
            .object({
              entry: knowledgeSchema,
              workstream: workstreamSchema,
              hints: mutationResultSchema.shape.hints.unwrap(),
            })
            .strict(),
        ),
        total: z.number(),
        limit: z.number(),
        offset: z.number(),
      })
      .strict(),
  },
  reviewQueue: {
    input: z.object({ workstreamId: workstreamIdSchema.optional(), ...page }).strict(),
    output: z
      .object({
        items: z.array(
          z
            .object({
              entry: knowledgeSchema,
              workstream: workstreamSchema,
              hints: mutationResultSchema.shape.hints.unwrap(),
            })
            .strict(),
        ),
        total: z.number(),
        limit: z.number(),
        offset: z.number(),
      })
      .strict(),
  },
  sectionBindings: { input: z.null(), output: z.object({ bindings: z.array(bindingRowSchema) }).strict() },
  setSectionBinding: {
    input: z.object({ sectionId: z.string().min(1).max(100), ...expected, binding: bindingSchema.nullable() }).strict(),
    output: bindingRowSchema,
  },
  threadContext: { input: z.object(thread).strict(), output: threadContextSchema },
  setThreadBinding: {
    input: z.object({ ...thread, ...expected, binding: bindingSchema.nullable() }).strict(),
    output: threadContextSchema,
  },
  setThreadOverride: {
    input: z
      .object({
        ...thread,
        ...expected,
        knowledgeId: knowledgeIdSchema,
        canonicalRevision: revision,
        excluded: z.boolean(),
        text: z.string().min(1).max(24000).nullable(),
      })
      .strict(),
    output: threadContextSchema,
  },
  setThreadGrant: {
    input: z
      .object({
        ...thread,
        ...expected,
        kind: z.enum(["knowledge", "legacy-task"]),
        id: z.string().min(1).max(100),
        granted: z.boolean(),
      })
      .strict(),
    output: threadContextSchema,
  },
  contextVisibility: {
    input: z.object({ threadIds: z.array(contextThreadIdSchema).max(200) }).strict(),
    output: z
      .object({
        threads: z.array(
          z
            .object({
              threadId: contextThreadIdSchema,
              dismissed: z.boolean(),
              dismissedPreference: z.boolean().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  setContextDismissed: {
    input: z.object({ ...thread, dismissed: z.boolean().nullable() }).strict(),
    output: threadContextSchema,
  },
  prepareThreadContext: {
    input: z.object(thread).strict(),
    output: z
      .object({
        threadId: contextThreadIdSchema,
        text: z.string(),
        estimatedTokens: z.number(),
        status: threadContextSchema.shape.status,
        error: z.string().nullable(),
      })
      .strict(),
  },
  deliveryReceipts: {
    input: z.object({ ...thread, ...page }).strict(),
    output: z
      .object({ receipts: z.array(deliveryReceiptSchema), total: z.number(), limit: z.number(), offset: z.number() })
      .strict(),
  },
};
export const workstreamRpcContract = workstreamRpcMethods satisfies PluginRpcContract;
export type Workstream = z.infer<typeof workstreamSchema>;
export type Knowledge = z.infer<typeof knowledgeSchema>;
export type Applicability = z.infer<typeof applicabilitySchema>;
export type WorkstreamBinding = z.infer<typeof bindingSchema>;
export type ThreadContext = z.infer<typeof threadContextSchema>;
export type DeliveryReceipt = z.infer<typeof deliveryReceiptSchema>;
export type KnowledgeProposal = z.infer<typeof proposalInputSchema>;

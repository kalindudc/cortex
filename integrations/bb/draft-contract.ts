import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { actorSchema, contextThreadIdSchema, knowledgeIdSchema, knowledgeSourceSchema, workstreamIdSchema } from "./workstream-contract";

export const DRAFT_LIMITS = { activePerSection: 1, activeGlobal: 3, findings: 3, messages: 12, sourceChars: 16384, outputBytes: 32768, segments: 6, rows: 256, snapshots: 40 } as const;
export const DRAFT_SOURCE_LIFETIME_MS = 10 * 60_000;
export const DRAFT_DEADLINE_MS = 5 * 60_000;
const revision = z.number().int().nonnegative();
const id = z.string().min(1).max(200);
const at = z.string().datetime();
export const draftSelectionSchema = z.object({ providerId: id, model: z.string().min(1).max(500), reasoningLevel: z.string().max(200), serviceTier: z.string().min(1).max(200).optional() }).strict();
export const draftConfigSchema = z.object({ revision, selection: draftSelectionSchema.nullable(), updatedAt: at.nullable(), updatedBy: actorSchema.extend({ type: z.literal("human") }).nullable() }).strict();
export const draftExecutionSchema = draftSelectionSchema.extend({ hostId: id, configRevision: revision, origin: z.enum(["configured", "source-thread", "override"]) }).strict();
// A message delivered during a running turn keeps the sequence it was sent at, which is before its own range.
export const draftSourceMessageSchema = z.object({ messageId: id, messageSeq: revision, threadId: contextThreadIdSchema, turnId: id, completedAt: at,
  sourceSeqStart: revision, sourceSeqEnd: revision, role: z.enum(["user", "assistant"]), authorType: z.enum(["human", "agent", "system", "unknown"]), observedAt: at,
  ref: z.string().min(1).max(2000), start: revision, end: revision, totalChars: revision,
  quote: knowledgeSourceSchema.shape.excerpt.unwrap().min(1), messageHash: z.string().regex(/^[a-f0-9]{64}$/), quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(m => m.start <= m.end && m.end <= m.totalChars && m.end - m.start === m.quote.length && m.sourceSeqStart <= m.sourceSeqEnd && m.messageSeq <= m.sourceSeqEnd, "Source excerpt span/sequence does not match its dimensions.");
export const draftSourceSnapshotSchema = z.object({ snapshotId: z.string().uuid(), sectionId: id, sourceThreadId: contextThreadIdSchema,
  bindingRevision: revision, workstreamId: workstreamIdSchema, workstreamRevision: z.number().int().positive(), capturedAt: at, expiresAt: at, historySnapshot: z.string().min(1).max(1000),
  label: z.string().min(1).max(1000), omittedMessages: revision, messages: z.array(draftSourceMessageSchema).min(1).max(DRAFT_LIMITS.messages),
}).strict().superRefine((s, ctx) => {
  if (s.messages.reduce((total, m) => total + m.quote.length, 0) > DRAFT_LIMITS.sourceChars) ctx.addIssue({ code: "custom", path: ["messages"], message: "Combined source excerpts exceed 16384 characters." });
  const ids = new Set<string>(); const sequences = new Set<number>();
  for (const [i, m] of s.messages.entries()) {
    if (m.threadId !== s.sourceThreadId || m.ref !== `@thread:${m.threadId}#msg=${m.messageSeq}` || ids.has(m.messageId) || sequences.has(m.messageSeq)) ctx.addIssue({ code: "custom", path: ["messages", i], message: "Source thread/reference identity is foreign or duplicated." });
    ids.add(m.messageId); sequences.add(m.messageSeq);
  }
});
export const draftPreviewSchema = draftSourceSnapshotSchema.safeExtend({ execution: draftExecutionSchema }).strict();
export const draftOutputSchema = z.object({ findings: z.array(z.object({ title: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(4000),
  sources: z.array(z.object({ messageId: id, messageSeq: revision, quote: knowledgeSourceSchema.shape.excerpt.unwrap().min(1) }).strict()).min(1).max(6),
}).strict()).max(DRAFT_LIMITS.findings) }).strict();
export const draftStatusSchema = z.enum(["prepared", "setup-requested", "setup-uncertain", "queued", "activating", "running", "validating", "saving", "needs-recovery", "failed", "completed", "nothing-to-save", "cancel-requested", "stopped"]);
const worker = z.object({ threadId: contextThreadIdSchema.nullable(), state: z.enum(["not-requested", "requesting", "unknown", "known", "stopped"]) }).strict();
const cancellation = z.object({ state: z.enum(["none", "requested", "confirmed"]), requestedAt: at.nullable(), confirmedAt: at.nullable() }).strict();
const result = z.object({ intendedId: knowledgeIdSchema, canonicalId: knowledgeIdSchema.nullable(), status: z.enum(["pending", "saved", "no-save", "failed"]), error: z.string().nullable() }).strict();
export const draftJobSchema = z.object({ requestId: z.string().uuid(), revision: revision.refine(n => n > 0), sectionId: id, sourceThreadId: contextThreadIdSchema, sourceSnapshotId: z.string().uuid(),
  bindingRevision: revision, workstreamId: workstreamIdSchema, workstreamRevision: z.number().int().positive(), requestedAt: at, updatedAt: at, deadlineAt: at,
  status: draftStatusSchema, execution: draftExecutionSchema, worker, cancellation, candidateResults: z.array(result).max(DRAFT_LIMITS.findings),
  progress: z.string().max(2000).nullable(), error: z.string().max(8000).nullable(), retry: z.enum(["none", "lookup-save", "discover-stop"]),
}).strict();
export const draftStartInputSchema = z.object({ requestId: z.string().uuid(), sectionId: id, expectedBindingRevision: revision, sourceThreadId: contextThreadIdSchema,
  sourceSnapshotId: z.string().uuid(), expectedConfigRevision: revision }).strict();
export const draftRecordSchema = draftJobSchema.extend({ candidateResults: z.array(result).length(DRAFT_LIMITS.findings), intent: draftStartInputSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), source: draftSourceSnapshotSchema,
  requester: actorSchema.extend({ type: z.literal("human") }), workerNonce: z.string().uuid(), bootstrapQueueId: id.nullable(), activationQueueId: id.nullable(),
  active: z.boolean(), output: draftOutputSchema.nullable(),
  findingCount: z.number().int().nonnegative().max(3).nullable().default(null), proposalAttemptedIds: z.array(knowledgeIdSchema).max(3).default([]),
  personalProjectId: id.nullable().default(null), setupUpdatedAt: revision.nullable().default(null), setupSendAt: revision.nullable().default(null), activationHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null), activationAttempted: z.boolean().default(false), activationUpdatedAt: revision.nullable().default(null), admittedRequestId: id.nullable().default(null), terminalTurnId: id.nullable().default(null), archived: z.boolean().default(false),
}).strict();
const target = { sectionId: id, requestId: z.string().uuid() };
const guarded = z.object({ ...target, expectedRevision: revision.refine(n => n > 0) }).strict();
export const draftRpcMethods = {
  draftConfigGet: { input: z.null(), output: draftConfigSchema },
  draftConfigSet: { input: z.object({ expectedRevision: revision, selection: draftSelectionSchema.nullable() }).strict(), output: draftConfigSchema },
  draftCapabilities: { input: z.null(), output: z.object({ available: z.boolean(), reason: z.string().nullable(), maxActivePerSection: z.literal(1), maxActiveGlobal: z.literal(3), maxFindings: z.literal(3), maxMessages: z.literal(12), maxSourceChars: z.literal(16384), maxQuoteChars: z.literal(8192), maxOutputBytes: z.literal(32768) }).strict() },
  // `selection` picks the model for this one draft instead of the Drafting setting.
  draftSourcePreview: { input: z.object({ sectionId: id, expectedBindingRevision: revision, sourceThreadId: contextThreadIdSchema, selection: draftSelectionSchema.optional() }).strict(), output: draftPreviewSchema },
  draftStart: { input: draftStartInputSchema, output: draftJobSchema },
  draftJob: { input: z.object(target).strict(), output: draftJobSchema },
  draftJobs: { input: z.object({ sectionId: id, limit: z.number().int().min(1).max(50).default(20), offset: revision.default(0) }).strict(), output: z.object({ jobs: z.array(draftJobSchema), total: revision, limit: revision, offset: revision }).strict() },
  draftCancel: { input: guarded, output: draftJobSchema },
  draftResumeSave: { input: guarded, output: draftJobSchema },
} satisfies PluginRpcContract;
export const draftRpcContract = draftRpcMethods;
export type DraftConfig = z.infer<typeof draftConfigSchema>;
export type DraftSelection = z.infer<typeof draftSelectionSchema>;
export type DraftExecution = z.infer<typeof draftExecutionSchema>;
export type DraftSource = z.infer<typeof draftSourceSnapshotSchema>;
export type DraftPreview = z.infer<typeof draftPreviewSchema>;
export type DraftOutput = z.infer<typeof draftOutputSchema>;
export type DraftRecord = z.infer<typeof draftRecordSchema>;
export type DraftJob = z.infer<typeof draftJobSchema>;

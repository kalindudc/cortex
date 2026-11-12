import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  applicabilitySchema,
  bindingRowSchema,
  contextThreadIdSchema,
  knowledgeIdSchema,
  knowledgeSchema,
  knowledgeSourceSchema,
  mutationResultSchema,
  threadContextSchema,
  workstreamIdSchema,
  workstreamRpcMethods,
} from "./workstream-contract";

const sectionId = z.string().min(1).max(100);
const requestId = z.string().uuid();
const revision = z.number().int().nonnegative();
const reason = z.string().trim().min(1).max(4096);
const title = z.string().trim().min(1).max(500);
const text = z.string().trim().min(1).max(24000);
export const titleMarkSchema = z
  .object({
    status: z.enum(["unmarked", "owned", "user-marked", "conflict", "failed"]),
    originalTitle: z.string().nullable(),
    decoratedTitle: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export const connectionJobSchema = z
  .object({
    requestId,
    sectionId,
    workstreamId: workstreamIdSchema,
    status: z.enum(["pending", "connecting", "connected", "failed"]),
    expectedRevision: revision,
    bindingRevision: revision.nullable(),
    error: z.string().nullable(),
    marker: titleMarkSchema,
  })
  .strict();
export const sectionSchema = z
  .object({
    id: sectionId,
    name: z.string(),
    canonicalName: z.string(),
    threadCount: revision,
    binding: bindingRowSchema,
    marker: titleMarkSchema,
    connectionJob: connectionJobSchema.nullable(),
  })
  .strict();
export const sectionEligibilitySchema = z
  .object({
    computedAt: z.string().datetime(),
    status: threadContextSchema.shape.status,
    error: z.string().nullable(),
    entries: threadContextSchema.shape.entries,
    notices: threadContextSchema.shape.notices,
    exclusions: threadContextSchema.shape.exclusions,
    exactText: z.string(),
    estimatedTokens: revision,
    budgetTokens: z.number().int().positive(),
  })
  .strict();
export const captureSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual"), threadId: contextThreadIdSchema.optional() }).strict(),
  z
    .object({
      kind: z.literal("message"),
      threadId: contextThreadIdSchema,
      messageId: z.string().min(1).max(200),
      messageSeq: z.number().int().nonnegative(),
      quote: knowledgeSourceSchema.shape.excerpt.unwrap().min(1).optional(),
    })
    .strict(),
]);
export const captureJobSchema = z
  .object({
    requestId,
    sectionId,
    intendedKnowledgeId: knowledgeIdSchema,
    knowledgeId: knowledgeIdSchema.nullable(),
    status: z.enum(["pending", "saved", "no-save", "failed"]),
    entry: knowledgeSchema.nullable(),
    error: z.string().nullable(),
  })
  .strict();
const candidate = {
  sectionId,
  expectedBindingRevision: revision,
  id: knowledgeIdSchema,
  expectedRevision: revision.refine(n => n > 0),
  reason,
};
export const sectionRpcMethods = {
  sectionList: { input: z.null(), output: z.object({ sections: z.array(sectionSchema) }).strict() },
  sectionDetail: {
    input: z
      .object({ sectionId, limit: z.number().int().min(1).max(100).default(50), offset: revision.default(0) })
      .strict(),
    output: z
      .object({
        section: sectionSchema,
        threads: z.array(z.object({ id: contextThreadIdSchema, name: z.string() }).strict()),
        eligibility: sectionEligibilitySchema,
        review: workstreamRpcMethods.reviewQueue.output,
      })
      .strict(),
  },
  sectionEligibility: { input: z.object({ sectionId }).strict(), output: sectionEligibilitySchema },
  sectionConnect: {
    input: z
      .object({
        requestId,
        sectionId,
        expectedRevision: revision,
        expectedTitle: z.string().max(2000),
        choice: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("create"),
              name: z.string().trim().min(1).max(200),
              description: z.string().max(24000).optional(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("reuse"),
              workstreamId: workstreamIdSchema,
              expectedWorkstreamRevision: revision.refine(n => n > 0),
            })
            .strict(),
        ]),
        markTitle: z.boolean().default(false),
      })
      .strict(),
    output: connectionJobSchema,
  },
  sectionConnectRetry: { input: z.object({ requestId }).strict(), output: connectionJobSchema },
  sectionTitleMark: {
    input: z.object({ sectionId, expectedTitle: z.string().max(2000), action: z.enum(["apply", "remove"]) }).strict(),
    output: titleMarkSchema,
  },
  sectionCapture: {
    input: z
      .object({
        requestId,
        sectionId,
        expectedBindingRevision: revision,
        source: captureSourceSchema,
        title,
        text,
        subject: z.string().trim().min(1).max(200).optional(),
        applicability: applicabilitySchema,
        mode: z.enum(["review", "accept"]),
        kind: z.enum(["finding", "directive"]).default("finding"),
        reason: reason.optional(),
      })
      .strict(),
    output: captureJobSchema,
  },
  sectionCaptureRetry: { input: z.object({ requestId }).strict(), output: captureJobSchema },
  sectionCaptureJobs: {
    input: z
      .object({ sectionId, limit: z.number().int().min(1).max(50).default(20), offset: revision.default(0) })
      .strict(),
    output: z
      .object({
        jobs: z.array(
          captureJobSchema
            .extend({
              workstreamId: workstreamIdSchema,
              expectedBindingRevision: revision,
              intent: z
                .object({
                  title,
                  kind: z.enum(["finding", "directive"]),
                  applicability: applicabilitySchema,
                  mode: z.enum(["review", "accept"]),
                })
                .strict(),
              sources: knowledgeSchema.shape.sources,
            })
            .strict(),
        ),
        total: revision,
        limit: revision,
        offset: revision,
      })
      .strict(),
  },
  sectionCaptureDismiss: {
    input: z.object({ sectionId, requestId }).strict(),
    output: z.object({ requestId, dismissed: z.literal(true) }).strict(),
  },
  sectionCandidateEdit: {
    input: z
      .object({
        ...candidate,
        title: title.optional(),
        text: text.optional(),
        kind: z.enum(["finding", "directive"]).optional(),
        applicability: applicabilitySchema.optional(),
      })
      .strict(),
    output: mutationResultSchema,
  },
  sectionCandidateAccept: {
    input: z
      .object({
        ...candidate,
        applicability: applicabilitySchema,
        title: title.optional(),
        text: text.optional(),
        kind: z.enum(["finding", "directive"]).optional(),
        supersede: z
          .object({ id: knowledgeIdSchema, expectedRevision: revision.refine(n => n > 0) })
          .strict()
          .optional(),
      })
      .strict(),
    output: mutationResultSchema,
  },
  sectionDraftStatus: {
    input: z.object({ sectionId }).strict(),
    output: z.object({ available: z.boolean(), reason: z.string() }).strict(),
  },
};
export const sectionRpcContract = sectionRpcMethods satisfies PluginRpcContract;
export type TitleMark = z.infer<typeof titleMarkSchema>;
export type ConnectionJob = z.infer<typeof connectionJobSchema>;
export type CaptureJob = z.infer<typeof captureJobSchema>;
export type Section = z.infer<typeof sectionSchema>;
export type SectionEligibility = z.infer<typeof sectionEligibilitySchema>;
export type ConnectInput = z.infer<typeof sectionRpcMethods.sectionConnect.input>;
export type CaptureInput = z.infer<typeof sectionRpcMethods.sectionCapture.input>;

import { z } from "zod";
import { applicabilitySchema, knowledgeIdSchema, mutationResultSchema } from "./workstream-contract";
export const problemActionSchema = z.object({
  kind: z.enum(["open-section", "open-entry", "edit-entry", "archive-entry", "remove-required", "retry-connection", "retry-capture", "dismiss-capture", "recover-draft", "stop-draft", "dismiss-draft", "set-applicability"]),
  label: z.string(), id: z.string().optional(), revision: z.number().int().optional(),
}).strict();
export const problemEntrySchema = z.object({
  id: knowledgeIdSchema, revision: z.number().int().positive(), title: z.string(),
  reason: z.enum(["duplicate", "topic", "scope"]), detail: z.string(), duplicateOf: knowledgeIdSchema.optional(), match: z.enum(["text", "title"]).optional(),
}).strict();
const entryInput = z.object({ sectionId: z.string().min(1).max(200), id: knowledgeIdSchema, expectedRevision: z.number().int().positive() }).strict();
export const problemSchema = z.object({
  id: z.string(), kind: z.string(), sectionId: z.string().nullable(), sectionName: z.string().nullable(),
  severity: z.enum(["Blocks", "Held back", "Failed", "Needs attention"]),
  blocking: z.boolean(), title: z.string(), consequence: z.string(), details: z.string(),
  actions: z.array(problemActionSchema).max(3), entries: z.array(problemEntrySchema).optional(),
}).strict();
export const problemRpcMethods = {
  problems: { input: z.null(), output: z.object({ problems: z.array(problemSchema) }).strict() },
  knowledgeMoveToBasics: { input: entryInput, output: z.object({ result: mutationResultSchema, waitingInReview: z.boolean(), refusal: z.string().nullable() }).strict() },
  problemEntryDismiss: { input: entryInput, output: z.object({ dismissed: z.boolean() }).strict() },
  problemEntryUndo: { input: entryInput, output: z.object({ dismissed: z.boolean() }).strict() },
  knowledgeSetApplicability: {
    input: z.object({ id: knowledgeIdSchema, expectedRevision: z.number().int().positive(), applicability: applicabilitySchema }).strict(),
    output: mutationResultSchema,
  },
};
export type ProblemEntry = z.infer<typeof problemEntrySchema>;
export type Problem = z.infer<typeof problemSchema>;
export type ProblemAction = z.infer<typeof problemActionSchema>;

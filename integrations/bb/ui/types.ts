import type { z } from "zod";
import type {
  actorSchema,
  bindingRowSchema,
  deliveryReceiptSchema,
  dimensionSchema,
  knowledgeSchema,
  knowledgeSourceSchema,
  threadContextSchema,
  workstreamSchema,
} from "../workstream-contract";

// Type-only views of the shared wire contract; the app bundle never imports its schemas.
export type Actor = z.infer<typeof actorSchema>;
export type Dimension = z.infer<typeof dimensionSchema>;
export type Workstream = z.infer<typeof workstreamSchema>;
export type Knowledge = z.infer<typeof knowledgeSchema>;
export type ThreadContext = z.infer<typeof threadContextSchema>;
export type ContextEntry = ThreadContext["entries"][number];
export type ContextNotice = ThreadContext["notices"][number];
export type DeliveryReceipt = z.infer<typeof deliveryReceiptSchema>;
export type BindingRow = z.infer<typeof bindingRowSchema>;
/** Targets are optional on the wire until every backend sends them; missing means not chosen. */
export type Binding = NonNullable<BindingRow["binding"]> & { applicability?: Knowledge["applicability"] };
export type SourceStatus = "available" | "archived" | "unreachable";
/** A source as the wire sends it; `status` is caller-reported and optional, never a live check. */
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema> & { status?: SourceStatus };
export type AdmissionHint = { id: string; reason: "same-subject" | "same-text" | "shared-source" };
export type ReviewItem = { entry: Knowledge; workstream: Workstream; hints: AdmissionHint[] };

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DRAFT_LIMITS, DRAFT_SOURCE_LIFETIME_MS, draftOutputSchema, draftSourceSnapshotSchema, type DraftOutput, type DraftRecord, type DraftSource } from "./draft-contract";
import { KNOWLEDGE_SOURCE_EXCERPT_MAX, type KnowledgeProposal } from "./workstream-contract";

export const draftHash = (text: string) => createHash("sha256").update(text).digest("hex");
const rowSourceSchema = z.object({ kind: z.literal("conversation"), id: z.string().min(1), messageSeq: z.number().int().nonnegative(), sourceSeqStart: z.number().int().nonnegative(), sourceSeqEnd: z.number().int().nonnegative(), threadId: z.string(), turnId: z.string(), role: z.enum(["user", "assistant"]), initiator: z.enum(["user", "agent", "system"]).optional(), text: z.string().max(1_000_000), createdAt: z.number().finite(), turnRequest: z.object({ status: z.enum(["accepted", "pending", "rejected"]) }).passthrough().nullable().optional() }).passthrough();
const turnSchema = z.object({ kind: z.literal("turn"), threadId: z.string(), turnId: z.string().min(1), sourceSeqStart: z.number().int().nonnegative(), sourceSeqEnd: z.number().int().nonnegative(), status: z.enum(["completed", "pending", "error", "interrupted"]), completedAt: z.number().finite().nullable(), children: z.array(z.unknown()).max(DRAFT_LIMITS.rows).nullable() }).passthrough();
type Frame = Pick<DraftSource, "sectionId" | "sourceThreadId" | "bindingRevision" | "workstreamId" | "workstreamRevision" | "historySnapshot">;
const turnEventSchema = z.object({ seq: z.number().int().nonnegative(), createdAt: z.number().finite(), type: z.literal("turn/completed"), threadId: z.string().optional(), scope: z.object({ kind: z.literal("turn"), turnId: z.string().min(1) }).passthrough(), data: z.object({ status: z.string() }).passthrough() }).passthrough();
/** How one turn ended, from bb's `turn/completed` event: needed when the timeline lists messages flat, without turn rows. */
export type TurnOutcome = { status: string; completedAt: number; seq: number };
/**
 * Each turn's outcome by turn id, from a thread's `turn/completed` events; rows that are not one, or belong to another
 * thread, are ignored.
 */
export function turnOutcomes(events: readonly unknown[], threadId: string): Map<string, TurnOutcome> {
  const outcomes = new Map<string, TurnOutcome>();
  for (const raw of events) {
    const event = turnEventSchema.safeParse(raw);
    if (!event.success || (event.data.threadId !== undefined && event.data.threadId !== threadId)) continue;
    outcomes.set(event.data.scope.turnId, { status: event.data.data.status, completedAt: event.data.createdAt, seq: event.data.seq });
  }
  return outcomes;
}
export function extractDraftSource(frame: Frame, rawRows: unknown[], now = Date.now(), turns: ReadonlyMap<string, TurnOutcome> = new Map()): DraftSource {
  if (rawRows.length > DRAFT_LIMITS.rows) throw new Error("Source exceeds the bounded timeline row limit.");
  const eligible: Array<{ message: z.infer<typeof rowSourceSchema>; completedAt: number }> = [];
  let count = rawRows.length;
  const admit = (message: z.infer<typeof rowSourceSchema>, completedAt: number) => {
    if (message.turnRequest && message.turnRequest.status !== "accepted") throw new Error("Source message was not accepted in the completed turn.");
    if (message.text.length === 0) return;
    if (eligible.some(e => e.message.id === message.id || e.message.messageSeq === message.messageSeq)) throw new Error("Duplicate source message identity in timeline.");
    eligible.push({ message, completedAt });
  };
  for (const raw of rawRows) {
    if (typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "conversation") {
      // A flat timeline: the message counts only when its turn's own event says that turn completed after it. A
      // thread's first message has no turn id, in the timeline or when re-read, so it cannot be pinned and is left out.
      const turnId = Reflect.get(raw, "turnId");
      const outcome = typeof turnId === "string" ? turns.get(turnId) : undefined;
      if (!outcome || outcome.status !== "completed") continue;
      const message = rowSourceSchema.parse(raw);
      if (message.threadId !== frame.sourceThreadId) throw new Error("Source message thread or completed turn does not match.");
      if (message.messageSeq > message.sourceSeqEnd || message.sourceSeqEnd > outcome.seq) throw new Error("Source message is outside its completed turn range.");
      admit(message, outcome.completedAt);
      continue;
    }
    if (typeof raw !== "object" || raw === null || !("kind" in raw) || raw.kind !== "turn") continue;
    const turn = turnSchema.parse(raw);
    if (turn.threadId !== frame.sourceThreadId) throw new Error("Source turn belongs to a foreign thread.");
    if (turn.status !== "completed" || turn.completedAt === null) continue;
    for (const child of turn.children ?? []) {
      if (++count > DRAFT_LIMITS.rows) throw new Error("Source exceeds the bounded timeline row limit.");
      if (typeof child !== "object" || child === null || !("kind" in child) || child.kind !== "conversation") continue;
      const message = rowSourceSchema.parse(child);
      if (message.threadId !== frame.sourceThreadId || message.turnId !== turn.turnId) throw new Error("Source message thread or completed turn does not match.");
      if (message.sourceSeqStart < turn.sourceSeqStart || message.sourceSeqEnd > turn.sourceSeqEnd || message.messageSeq > message.sourceSeqEnd) throw new Error("Source message is outside its completed turn range.");
      admit(message, turn.completedAt);
    }
  }
  if (eligible.length === 0) throw new Error("No recent completed messages are available for drafting.");
  eligible.sort((a, b) => b.message.messageSeq - a.message.messageSeq);
  let remaining = DRAFT_LIMITS.sourceChars;
  const messages: DraftSource["messages"] = [];
  for (const { message, completedAt } of eligible) {
    if (messages.length >= DRAFT_LIMITS.messages || remaining <= 0) break;
    const start = Math.max(0, message.text.length - Math.min(remaining, KNOWLEDGE_SOURCE_EXCERPT_MAX));
    const quote = message.text.slice(start); remaining -= quote.length;
    messages.push({ messageId: message.id, messageSeq: message.messageSeq, threadId: message.threadId, turnId: message.turnId, completedAt: new Date(completedAt).toISOString(), sourceSeqStart: message.sourceSeqStart, sourceSeqEnd: message.sourceSeqEnd, role: message.role,
      authorType: message.role === "assistant" ? "agent" : message.initiator === "user" ? "human" : message.initiator ?? "unknown", observedAt: new Date(message.createdAt).toISOString(), ref: `@thread:${message.threadId}#msg=${message.messageSeq}`,
      start, end: message.text.length, totalChars: message.text.length, quote, messageHash: draftHash(message.text), quoteHash: draftHash(quote),
    });
  }
  return draftSourceSnapshotSchema.parse({ ...frame, snapshotId: randomUUID(), capturedAt: new Date(now).toISOString(), expiresAt: new Date(now + DRAFT_SOURCE_LIFETIME_MS).toISOString(), label: "Recent completed-message excerpt window, not the whole thread. Older and omitted messages are not supplied to drafting.", omittedMessages: eligible.length - messages.length, messages: messages.reverse() });
}
export function verifyDraftSource(input: DraftSource, rawMessages: unknown[], now = Date.now()): void {
  const source = draftSourceSnapshotSchema.parse(input);
  if (Date.parse(source.expiresAt) <= now) throw new Error("Draft source snapshot expired. Choose a fresh explicit source.");
  if (rawMessages.length !== source.messages.length) throw new Error("Source message count does not match the pinned snapshot.");
  for (const pinned of source.messages) {
    const raw = rawMessages.find(m => typeof m === "object" && m !== null && "id" in m && m.id === pinned.messageId);
    const message = rowSourceSchema.safeParse(raw);
    if (!message.success) throw new Error("Source message no longer matches the pinned snapshot.");
    const m = message.data;
    const authorType = m.role === "assistant" ? "agent" : m.initiator === "user" ? "human" : m.initiator ?? "unknown";
    if (m.threadId !== source.sourceThreadId || m.threadId !== pinned.threadId || m.turnId !== pinned.turnId || m.messageSeq !== pinned.messageSeq || m.sourceSeqStart !== pinned.sourceSeqStart || m.sourceSeqEnd !== pinned.sourceSeqEnd || m.role !== pinned.role || authorType !== pinned.authorType || new Date(m.createdAt).toISOString() !== pinned.observedAt || draftHash(m.text) !== pinned.messageHash || m.text.length !== pinned.totalChars || m.text.slice(pinned.start, pinned.end) !== pinned.quote || draftHash(pinned.quote) !== pinned.quoteHash || pinned.ref !== `@thread:${m.threadId}#msg=${m.messageSeq}`) throw new Error("Source identity, range, provenance or original content changed.");
  }
}
export function validateDraftOutput(json: string, input: DraftSource): DraftOutput {
  if (Buffer.byteLength(json, "utf8") > DRAFT_LIMITS.outputBytes) throw new Error("Draft output exceeds the bounded JSON byte limit.");
  const source = draftSourceSnapshotSchema.parse(input);
  const output = draftOutputSchema.parse(JSON.parse(json));
  for (const finding of output.findings) {
    const seen = new Set<string>();
    for (const ref of finding.sources) {
      const message = source.messages.find(m => m.messageId === ref.messageId && m.messageSeq === ref.messageSeq);
      if (!message || !message.quote.includes(ref.quote) || draftHash(message.quote) !== message.quoteHash) throw new Error("Draft output source reference or exact quote does not match the captured excerpt.");
      const key = JSON.stringify(ref);
      if (seen.has(key)) throw new Error("Duplicate exact source claim in draft output.");
      seen.add(key);
    }
  }
  return output;
}
export function draftProposals(record: DraftRecord, output: DraftOutput): Array<KnowledgeProposal & { op: "propose"; id: string; actor: { id: string; type: "agent" } }> {
  const checked = validateDraftOutput(JSON.stringify(output), record.source);
  return checked.findings.map((finding, index) => {
    const sources = finding.sources.map(ref => {
      const message = record.source.messages.find(m => m.messageId === ref.messageId && m.messageSeq === ref.messageSeq)!;
      return { ref: message.ref, excerpt: ref.quote, authorType: message.authorType, observedAt: message.observedAt, status: "available" as const };
    });
    const identity = sources.map(s => [s.ref, draftHash(s.excerpt)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const title = finding.title.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    return { op: "propose", id: record.candidateResults[index].intendedId, actor: { id: `cortex-draft-${record.requestId}`, type: "agent" as const }, workstreamId: record.workstreamId, subject: `bb:draft:${draftHash(JSON.stringify([identity, title])).slice(0, 40)}`, title: finding.title, text: finding.text, kind: "finding", facet: "orientation", applicability: { environment: { mode: "unknown" }, host: { mode: "unknown" } }, sources, expiresAt: null };
  });
}

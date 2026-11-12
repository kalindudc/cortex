import { randomUUID } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, test } from "vitest";
import { draftOutputSchema, draftSourceSnapshotSchema, draftRpcContract, type DraftRecord, type DraftSource } from "./draft-contract";
import { createDraftStore, DRAFT_MIGRATIONS } from "./draft-store";
import { draftProposals, extractDraftSource, validateDraftOutput, verifyDraftSource } from "./draft-validation";

const now = Date.now();
const at = new Date(now).toISOString();
const actor = { id: "you", type: "human" as const };
const selection = { providerId: "provider-a", model: "chosen-model", reasoningLevel: "", serviceTier: "default" };
const message = { kind: "conversation", id: "msg_one", messageSeq: 14, sourceSeqStart: 14, sourceSeqEnd: 14, threadId: "thr_aaaaaaaa", turnId: "turn_one", role: "user", initiator: "system", text: "Exact `Markdown` evidence", createdAt: now - 2000, startedAt: now - 2000 };
const turn = { kind: "turn", id: "row_one", threadId: message.threadId, turnId: message.turnId, sourceSeqStart: 13, sourceSeqEnd: 15, status: "completed", completedAt: now - 1000, children: [message] };
const frame = { sectionId: "sec_one", sourceThreadId: message.threadId, bindingRevision: 1, workstreamId: "ws_one", workstreamRevision: 3, historySnapshot: "history_one" };
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function setup() {
  const host = createFakePluginHost({ pluginId: "cortex" });
  disposers.push(() => host.harness.lifecycle.dispose());
  const db = host.bb.storage.database(); host.bb.storage.migrate(db, DRAFT_MIGRATIONS);
  return { ...host, store: createDraftStore(db) };
}
function source(): DraftSource { return extractDraftSource(frame, [turn], now); }
function record(source = sourceFixture()): DraftRecord {
  const requestId = randomUUID();
  const intent = { requestId, sectionId: source.sectionId, expectedBindingRevision: source.bindingRevision, sourceThreadId: source.sourceThreadId, sourceSnapshotId: source.snapshotId, expectedConfigRevision: 0 };
  return { requestId, revision: 1, sectionId: source.sectionId, sourceThreadId: source.sourceThreadId, sourceSnapshotId: source.snapshotId, bindingRevision: source.bindingRevision, workstreamId: source.workstreamId, workstreamRevision: source.workstreamRevision,
    requestedAt: at, updatedAt: at, deadlineAt: new Date(now + 300_000).toISOString(), status: "prepared", execution: { ...selection, hostId: "host_one", configRevision: 0, origin: "source-thread" },
    worker: { threadId: null, state: "not-requested" }, cancellation: { state: "none", requestedAt: null, confirmedAt: null }, candidateResults: Array.from({ length: 3 }, () => ({ intendedId: `kn_${randomUUID()}`, canonicalId: null, status: "pending", error: null })), progress: null, error: null, retry: "none", intent, fingerprint: "a".repeat(64), source, requester: actor, workerNonce: randomUUID(), bootstrapQueueId: null, activationQueueId: null, active: true, output: null, findingCount: null, proposalAttemptedIds: [], personalProjectId: null, setupUpdatedAt: null, setupSendAt: null, activationHash: null, activationAttempted: false, activationUpdatedAt: null, admittedRequestId: null, terminalTurnId: null, archived: false };
}
function sourceFixture(): DraftSource { return { ...frame, snapshotId: randomUUID(), capturedAt: at, expiresAt: new Date(now + 600_000).toISOString(), label: "Recent completed-message excerpt", omittedMessages: 0, messages: [{ messageId: message.id, messageSeq: message.messageSeq, threadId: message.threadId, turnId: message.turnId, completedAt: new Date(now - 1000).toISOString(), sourceSeqStart: 14, sourceSeqEnd: 14, role: "user", authorType: "system", observedAt: new Date(message.createdAt).toISOString(), ref: "@thread:thr_aaaaaaaa#msg=14", start: 0, end: message.text.length, totalChars: message.text.length, quote: message.text, messageHash: "b".repeat(64), quoteHash: "c".repeat(64) }] }; }
const output = { findings: [{ title: "Specific takeaway", text: "Quoted prohibition is evidence, not a Rule.", sources: [{ messageId: message.id, messageSeq: message.messageSeq, quote: "`Markdown`" }] }] };

test("config defaults to follow source and uses CAS structured picker values, including reset", () => {
  const { store } = setup();
  expect(store.configGet()).toEqual({ revision: 0, selection: null, updatedAt: null, updatedBy: null });
  expect(store.configSet(0, selection, actor)).toMatchObject({ revision: 1, selection, updatedBy: actor });
  expect(() => store.configSet(0, null, actor)).toThrow(/revision/);
  expect(store.configGet().selection).toEqual(selection);
  expect(store.configSet(1, null, actor)).toMatchObject({ revision: 2, selection: null });
});

test("config schema requires a concrete structured choice and preserves optional service tiers", () => {
  const schema = draftRpcContract.draftConfigSet.input;
  expect(schema.safeParse({ expectedRevision: 0, selection: "model-a" }).success).toBe(false);
  expect(schema.safeParse({ expectedRevision: 0, selection: { ...selection, model: "" } }).success).toBe(false);
  expect(schema.parse({ expectedRevision: 0, selection })).toEqual({ expectedRevision: 0, selection });
});

test("durable job stores immutable intent, nonce and candidate IDs; duplicate clicks reuse original", () => {
  const { store } = setup(); const r = record();
  const first = store.create(r); const second = store.create({ ...r, workerNonce: randomUUID() });
  expect(second).toEqual(first);
  expect(store.get(r.requestId)).toMatchObject({ workerNonce: r.workerNonce, candidateResults: r.candidateResults });
  expect(() => store.create({ ...r, fingerprint: "d".repeat(64), intent: { ...r.intent, sourceThreadId: "thr_bbbbbbbb" } })).toThrow(/intent/);
});

test("config changes affect future jobs only and cannot reroute a pinned job", () => {
  const { store } = setup(); const r = store.create(record());
  store.configSet(0, selection, actor);
  expect(store.get(r.requestId)!.execution).toEqual(r.execution);
  expect(() => store.update({ ...r, execution: { ...r.execution, model: "other" } }, r.revision)).toThrow(/immutable|pinned/);
  expect(() => store.create(record())).toThrow(/config.*revision/);
});

test("one active per section, three globally; unknown workers retain capacity after cancel", () => {
  const { store } = setup(); const first = store.create(record());
  expect(() => store.create(record())).toThrow(/section/);
  const unknown = store.update({ ...first, worker: { threadId: null, state: "requesting" }, status: "setup-requested" }, first.revision);
  const canceled = store.cancel(first.sectionId, first.requestId, unknown.revision);
  expect(canceled).toMatchObject({ status: "cancel-requested", active: true, cancellation: { state: "requested" } });
  expect(() => store.create(record())).toThrow(/section/);
  for (const sectionId of ["sec_two", "sec_three"]) store.create(record({ ...sourceFixture(), sectionId }));
  expect(() => store.create(record({ ...sourceFixture(), sectionId: "sec_four" }))).toThrow(/global/);
});

test("cancel before any worker request is confirmed locally, preserves partial saved IDs and releases capacity", () => {
  const { store } = setup(); const r = record(); r.candidateResults[0] = { ...r.candidateResults[0], canonicalId: r.candidateResults[0].intendedId, status: "saved" };
  store.create(r);
  const canceled = store.cancel(r.sectionId, r.requestId, r.revision);
  expect(canceled).toMatchObject({ status: "stopped", active: false, cancellation: { state: "confirmed" }, candidateResults: r.candidateResults });
  expect(store.create(record()).active).toBe(true);
});

test("job CAS, immutable source/binding and lost-spawn guard refuse stale or retargeted transitions", () => {
  const { store } = setup(); const r = store.create(record());
  const requested = store.update({ ...r, worker: { threadId: null, state: "requesting" }, status: "setup-requested" }, r.revision);
  const lost = store.update({ ...requested, worker: { threadId: null, state: "unknown" }, status: "setup-uncertain" }, requested.revision);
  expect(() => store.update({ ...lost, worker: { threadId: null, state: "requesting" } }, lost.revision)).toThrow(/uncertain|discover/i);
  expect(() => store.update(lost, r.revision)).toThrow(/revision/);
  expect(() => store.update({ ...lost, workstreamId: "ws_other" }, lost.revision)).toThrow(/immutable|pinned/);
  expect(() => store.update({ ...lost, active: false }, lost.revision)).toThrow(/confirm|worker/);
});

test("job queries are bounded and section-scoped, and private state survives reload", async () => {
  const host = setup(); const r = host.store.create(record());
  expect(host.store.list("sec_foreign", 20, 0)).toMatchObject({ jobs: [], total: 0 });
  expect(host.store.list("sec_one", 1, 0)).toMatchObject({ jobs: [r], total: 1, limit: 1, offset: 0 });
  expect(() => host.store.list("sec_one", 51, 0)).toThrow();
  const reloaded = await host.harness.lifecycle.reload(async () => {});
  const db = reloaded.bb.storage.database(); reloaded.bb.storage.migrate(db, DRAFT_MIGRATIONS);
  expect(createDraftStore(db).get(r.requestId)).toEqual(r);
});

test("source excerpts come only from completed selected-thread turns and retain exact ranges and reported provenance", () => {
  const s = source();
  expect(s.messages[0]).toMatchObject({ quote: message.text, start: 0, end: message.text.length, ref: "@thread:thr_aaaaaaaa#msg=14", authorType: "system" });
  expect(s.label).toMatch(/excerpt/i);
  expect(() => extractDraftSource(frame, [{ ...turn, status: "pending" }], now)).toThrow(/completed/);
  expect(() => extractDraftSource(frame, [{ ...turn, children: [{ ...message, threadId: "thr_bbbbbbbb" }] }], now)).toThrow(/thread|source/);
  expect(() => extractDraftSource(frame, [{ ...turn, children: [{ ...message, messageSeq: 99 }] }], now)).toThrow(/range/);
});

test("source window is explicitly bounded rather than a whole-message claim", () => {
  const s = extractDraftSource(frame, [{ ...turn, children: [{ ...message, text: "x".repeat(9000) }] }], now);
  expect(s.messages[0]).toMatchObject({ start: 808, end: 9000, totalChars: 9000, quote: "x".repeat(8192) });
  expect(() => extractDraftSource(frame, Array.from({ length: 257 }, () => turn), now)).toThrow(/bounded|limit/);
});

test("source schema enforces combined excerpt budget, exact span dimensions and one selected thread", () => {
  const s = source(); const m = s.messages[0];
  const many = [0, 1, 2].map(i => ({ ...m, messageId: `msg_${i}`, messageSeq: i, start: 0, end: 8192, totalChars: 8192, quote: "x".repeat(8192) }));
  expect(draftSourceSnapshotSchema.safeParse({ ...s, messages: many }).success).toBe(false);
  expect(draftSourceSnapshotSchema.safeParse({ ...s, messages: [{ ...m, end: m.end + 1 }] }).success).toBe(false);
  expect(draftSourceSnapshotSchema.safeParse({ ...s, messages: [{ ...m, threadId: "thr_bbbbbbbb" }] }).success).toBe(false);
});

test("refetched original must match selected ID/sequence/turn/time/hash/exact span", () => {
  const s = source(); expect(() => verifyDraftSource(s, [message], now)).not.toThrow();
  for (const patch of [{ id: "foreign" }, { messageSeq: 15 }, { text: "edited" }, { threadId: "thr_bbbbbbbb" }, { turnId: "other" }, { createdAt: now }]) expect(() => verifyDraftSource(s, [{ ...message, ...patch }], now)).toThrow(/source|changed|match/);
  expect(() => verifyDraftSource(s, [message], now + 600_001)).toThrow(/expired/);
});

test("strict output permits empty or at most three findings and forbids directives/approval/provenance fields", () => {
  const s = source(); expect(validateDraftOutput('{"findings":[]}', s)).toEqual({ findings: [] });
  expect(validateDraftOutput(JSON.stringify(output), s)).toEqual(output);
  for (const extra of [{ kind: "directive" }, { approval: { actor } }, { applicability: {} }, { actor }, { role: "human" }]) expect(() => validateDraftOutput(JSON.stringify({ findings: [{ ...output.findings[0], ...extra }] }), s)).toThrow();
  expect(draftOutputSchema.safeParse({ findings: Array.from({ length: 4 }, () => output.findings[0]) }).success).toBe(false);
  expect(() => validateDraftOutput("```json\n{}\n```", s)).toThrow();
  expect(() => validateDraftOutput(" ".repeat(32769), s)).toThrow(/bounded|limit|bytes/);
});

test("output refs/quotes must be exact captured source spans, not model claims or normalized similarities", () => {
  const s = source();
  for (const ref of [{ messageId: "foreign" }, { messageSeq: 1 }, { quote: "markdown" }, { quote: "not original" }, { authorType: "human" }]) expect(() => validateDraftOutput(JSON.stringify({ findings: [{ ...output.findings[0], sources: [{ ...output.findings[0].sources[0], ...ref }] }] }), s)).toThrow();
});

test("projection is only system/agent unapproved findings, unknown scope and original source provenance", () => {
  const s = source(); const r = record(s); const parsed = validateDraftOutput(JSON.stringify(output), s);
  const proposals = draftProposals(r, parsed);
  expect(proposals[0]).toMatchObject({ op: "propose", id: r.candidateResults[0].intendedId, workstreamId: r.workstreamId, kind: "finding", facet: "orientation", actor: { type: "agent" }, applicability: { environment: { mode: "unknown" }, host: { mode: "unknown" } }, sources: [{ authorType: "system", excerpt: "`Markdown`", ref: s.messages[0].ref }] });
  expect(proposals[0]).not.toHaveProperty("approval");
  expect(draftProposals(record(s), parsed)[0].subject).toBe(proposals[0].subject);
});

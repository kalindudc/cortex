import { afterEach, expect, spyOn, test } from "bun:test";
import { Store } from "../../src/store.ts";
import type { Actor, Applicability, Knowledge, Workstream } from "../../src/workstreams.ts";

const human: Actor = { id: "reviewer", type: "human" };
const agent: Actor = { id: "drafting-agent", type: "agent" };
const system: Actor = { id: "system", type: "system" };
const stable: Applicability = { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } };
const unknown: Applicability = { environment: { mode: "unknown" }, host: { mode: "unknown" } };
const sources = [
  { ref: "message:42", excerpt: "Adopt this rule", authorType: "human", observedAt: "2026-01-01T00:00:00.000Z" },
];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const store = Store.open(":memory:");
  stores.push(store);
  const w = store.mutateWorkstream({ op: "create", actor: human, name: "Shared" }).workstream as Workstream;
  const propose = (patch: Record<string, unknown> = {}) =>
    store.mutateWorkstream({
      op: "propose",
      actor: agent,
      workstreamId: w.id,
      subject: "gateway",
      title: "Gateway",
      text: "Use filter A",
      kind: "finding",
      facet: "orientation",
      applicability: unknown,
      sources,
      ...patch,
    }).entry as Knowledge;
  const accept = (entry: Knowledge, patch: Record<string, unknown> = {}) =>
    store.mutateWorkstream({
      op: "accept",
      actor: human,
      id: entry.id,
      expectedRevision: entry.revision,
      reason: "Reviewed",
      applicability: stable,
      ...patch,
    });
  return { store, w, propose, accept };
}
const id = (prefix: "ws" | "kn") => `${prefix}_${crypto.randomUUID()}`;

function expectConflict(fn: () => unknown) {
  try {
    fn();
    throw new Error("Expected collision");
  } catch (error) {
    expect(error).toMatchObject({ status: 409 });
    expect(JSON.stringify(error)).not.toContain("Adopt this rule");
  }
}

test("stable create ID survives a lost response without duplicate workstreams or exposing collision content", () => {
  const { store } = fixture();
  const intended = id("ws");
  const input = { op: "create", actor: human, id: intended, name: "Private project" };
  const first = store.mutateWorkstream(input).workstream as Workstream;
  expect(first.id).toBe(intended);
  for (const patch of [{}, { actor: agent, name: "Overwrite" }])
    expectConflict(() => store.mutateWorkstream({ ...input, ...patch }));
  expect(store.showWorkstream(intended).workstream).toEqual(first);
  expect(store.listWorkstreams().total).toBe(2);
  expect(store.workstreamHistory(intended).total).toBe(1);
});

test("stable candidate IDs preserve up to three distinct suggestions and keep normalized no-save semantics", () => {
  const { store, w, propose } = fixture();
  const candidates = Array.from({ length: 3 }, (_, n) => propose({ id: id("kn"), text: `Suggestion ${n}` }));
  expect(new Set(candidates.map(e => e.id)).size).toBe(3);
  const other = store.mutateWorkstream({ op: "create", actor: human, name: "Other" }).workstream as Workstream;
  for (const entry of candidates) {
    expectConflict(() => propose({ id: entry.id, actor: human, workstreamId: other.id }));
    expect(store.workstreamEntry(entry.id)).toEqual(entry);
  }
  expect(store.showWorkstream(w.id).total).toBe(3);
  const unused = id("kn");
  expect(propose({ id: unused, text: "  SUGGESTION 0  " }).id).toBe(candidates[0]?.id);
  expect(() => store.workstreamHistory(unused)).toThrow("not found");
  expect(() => store.workstreamEntry(unused)).toThrow("not found");
  expect(propose({ text: "Suggestion 0" }).id).toBe(candidates[0]?.id);
  const first = candidates[0] as Knowledge;
  store.mutateWorkstream({
    op: "edit",
    actor: agent,
    id: first.id,
    expectedRevision: 1,
    reason: "Revised draft",
    text: "Changed candidate",
  });
  expect(propose({ id: unused, text: "Suggestion 0" }).id).toBe(unused);
  expect(store.showWorkstream(w.id).total).toBe(4);
});

test("stable candidate retries never restore forgotten data or change provenance", () => {
  const { store, propose } = fixture();
  const entry = propose({ id: id("kn") });
  store.mutateWorkstream({
    op: "transition",
    actor: human,
    id: entry.id,
    expectedRevision: 1,
    state: "forgotten",
    reason: "Forget",
  });
  expectConflict(() => propose({ id: entry.id, actor: human, text: "Restore" }));
  expect(store.workstreamEntry(entry.id)).toMatchObject({ state: "forgotten", text: "", sources: [], revision: 2 });
  expect(store.workstreamHistory(entry.id).revisions.every(r => "text" in r.snapshot && r.snapshot.text === "")).toBe(
    true,
  );
});

test("stable IDs validate canonical shape and reject cross-entity collisions", () => {
  const { store, w, propose } = fixture();
  for (const invalid of ["", "arbitrary", "ws_nope", "kn_nope", "../escape", id("kn")]) {
    expect(() => store.mutateWorkstream({ op: "create", id: invalid, actor: human, name: "Invalid" })).toThrow();
  }
  expect(() => propose({ id: w.id })).toThrow();
  expect(store.listWorkstreams().total).toBe(1);
});

test("caller IDs cannot reuse an identity reserved only by canonical history", () => {
  const { store, w, propose } = fixture();
  for (const prefix of ["ws", "kn"] as const) {
    const intended = id(prefix);
    const snapshot = { ...w, id: intended };
    const revision = {
      id: intended,
      revision: 1,
      actor: human,
      at: w.createdAt,
      action: "import",
      reason: "Historical identity",
      snapshot,
    };
    store.restoreWorkstreamRows({
      workstream_revisions: [{ id: intended, revision: 1, data: JSON.stringify(revision) }],
    });
    expectConflict(() =>
      prefix === "ws"
        ? store.mutateWorkstream({ op: "create", id: intended, actor: human, name: "Reused" })
        : propose({ id: intended }),
    );
    expect(store.workstreamHistory(intended).revisions).toEqual([revision]);
  }
});

test("human accept finalizes scope, text and Rule in one guarded revision without replacing sources", () => {
  const { store, w, propose, accept } = fixture();
  const entry = propose();
  const result = accept(entry, { title: "Final rule", text: "Never remove filter A", kind: "directive" });
  expect(result.entry).toMatchObject({
    id: entry.id,
    revision: 2,
    state: "approved",
    applicability: stable,
    title: "Final rule",
    text: "Never remove filter A",
    kind: "directive",
    sources: entry.sources,
    approval: { actor: human },
  });
  expect(store.workstreamHistory(entry.id).revisions.map(r => r.snapshot)).toMatchObject([
    { id: entry.id, state: "candidate", actor: agent, applicability: unknown, sources: entry.sources },
    { id: entry.id, state: "approved", actor: human, sources: entry.sources },
  ]);
  expect(store.readWorkstream(w.id).entries.map(e => e.id)).toEqual([entry.id]);
  expect(() => accept(entry, { text: "Stale edit" })).toThrow("revision conflict");
  expect(store.workstreamHistory(entry.id).total).toBe(2);
});

test("human draft edit retains kind, scope, source and identity across reads and history without approving", () => {
  const { store, w, propose } = fixture();
  const entry = propose();
  const scoped: Applicability = { environment: { mode: "value", value: "staging" }, host: { mode: "not-applicable" } };
  const saved = store.mutateWorkstream({
    op: "edit",
    actor: human,
    id: entry.id,
    expectedRevision: 1,
    reason: "Save draft",
    text: "Edited rule",
    kind: "directive",
    applicability: scoped,
  }).entry as Knowledge;
  expect(saved).toMatchObject({
    id: entry.id,
    revision: 2,
    state: "candidate",
    kind: "directive",
    applicability: scoped,
    text: "Edited rule",
    actor: human,
    sources: entry.sources,
    approval: null,
  });
  expect(store.workstreamEntry(entry.id)).toEqual(saved);
  expect(store.workstreamHistory(entry.id).revisions.map(r => r.snapshot)).toEqual([entry, saved]);
  expect(saved.createdAt).toBe(entry.createdAt);
  expect(saved.subject).toBe(entry.subject);
  expect(saved.conflicts).toEqual(entry.conflicts);
  expect(saved.supersedes).toEqual(entry.supersedes);
  expect(store.readWorkstream(w.id, { environment: "staging" }).entries).toEqual([]);
});

test("human draft edit may retain unknown applicability but acceptance still refuses it", () => {
  const { store, w, propose, accept } = fixture();
  const entry = propose({ applicability: stable });
  const saved = store.mutateWorkstream({
    op: "edit",
    actor: human,
    id: entry.id,
    expectedRevision: 1,
    reason: "Scope undecided",
    applicability: unknown,
    kind: "directive",
  }).entry as Knowledge;
  expect(saved).toMatchObject({
    state: "candidate",
    revision: 2,
    kind: "directive",
    applicability: unknown,
    sources: entry.sources,
    approval: null,
  });
  expect(store.workstreamHistory(entry.id).revisions.at(-1)?.snapshot).toEqual(saved);
  expect(() => accept(saved, { applicability: saved.applicability })).toThrow("known applicability");
  expect(store.workstreamEntry(entry.id)).toEqual(saved);
  expect(store.readWorkstream(w.id).entries).toEqual([]);
});

test("draft kind or scope fields require a human even when supplied values are unchanged", () => {
  const { store, propose } = fixture();
  const entry = propose();
  for (const actor of [agent, system]) {
    for (const fields of [
      { kind: entry.kind },
      { applicability: entry.applicability },
      { kind: "directive", applicability: stable },
    ]) {
      expect(() =>
        store.mutateWorkstream({
          op: "edit",
          actor,
          id: entry.id,
          expectedRevision: 1,
          reason: "Untrusted draft edit",
          ...fields,
        }),
      ).toThrow("human");
      expect(store.workstreamEntry(entry.id)).toEqual(entry);
    }
  }
  expect(store.workstreamHistory(entry.id).total).toBe(1);
});

test("draft kind or scope fields refuse noncandidates without reviving or demoting them", () => {
  for (const state of ["approved", "disputed", "recheck", "archived", "rejected", "forgotten", "superseded"] as const) {
    const { store, propose, accept } = fixture();
    const entry = propose({ applicability: stable });
    if (state === "disputed") {
      const other = propose({ applicability: stable, text: "A conflict" });
      store.mutateWorkstream({
        op: "conflict",
        actor: agent,
        id: entry.id,
        expectedRevision: 1,
        otherId: other.id,
        otherExpectedRevision: 1,
        reason: "Dispute",
      });
    } else if (state === "superseded") {
      accept(propose({ text: "Replacement" }), { supersede: { id: entry.id, expectedRevision: 1 } });
    } else {
      store.mutateWorkstream({
        op: "transition",
        actor: human,
        id: entry.id,
        expectedRevision: 1,
        state,
        reason: "Review",
      });
    }
    const before = store.workstreamEntry(entry.id);
    const history = store.workstreamHistory(entry.id);
    for (const fields of [{ kind: before.kind }, { applicability: before.applicability }]) {
      expect(() =>
        store.mutateWorkstream({
          op: "edit",
          actor: human,
          id: before.id,
          expectedRevision: before.revision,
          reason: "Save draft",
          ...fields,
        }),
      ).toThrow();
      expect(store.workstreamEntry(entry.id)).toEqual(before);
      expect(store.workstreamHistory(entry.id)).toEqual(history);
    }
  }
});

test("draft kind and scope edits retain CAS and legacy text edits preserve existing behavior and relations", () => {
  const { store, propose, accept } = fixture();
  const old = accept(propose(), { kind: "directive" }).entry as Knowledge;
  const replacement = accept(propose({ text: "Replacement" }), {
    kind: "directive",
    supersede: { id: old.id, expectedRevision: old.revision },
  }).entry as Knowledge;
  const conflicting = propose({ applicability: stable, text: "Contrary guidance" });
  store.mutateWorkstream({
    op: "conflict",
    actor: agent,
    id: replacement.id,
    expectedRevision: replacement.revision,
    otherId: conflicting.id,
    otherExpectedRevision: 1,
    reason: "Dispute",
  });
  const approved = store.workstreamEntry(replacement.id);
  const candidate = store.mutateWorkstream({
    op: "edit",
    actor: human,
    id: approved.id,
    expectedRevision: approved.revision,
    reason: "Legacy text edit",
    text: "Reconsidered",
  }).entry as Knowledge;
  expect(candidate).toMatchObject({
    state: "candidate",
    approval: null,
    conflicts: [conflicting.id],
    supersedes: [old.id],
  });
  const saved = store.mutateWorkstream({
    op: "edit",
    actor: human,
    id: candidate.id,
    expectedRevision: candidate.revision,
    reason: "Save draft",
    kind: "finding",
    applicability: unknown,
  }).entry as Knowledge;
  expect(saved).toMatchObject({
    state: "candidate",
    approval: null,
    conflicts: candidate.conflicts,
    supersedes: candidate.supersedes,
    supersededBy: candidate.supersededBy,
    sources: candidate.sources,
  });
  expect(() =>
    store.mutateWorkstream({
      op: "edit",
      actor: human,
      id: candidate.id,
      expectedRevision: candidate.revision,
      reason: "Stale draft",
      kind: "directive",
      applicability: stable,
    }),
  ).toThrow("revision conflict");
  expect(store.workstreamEntry(saved.id)).toEqual(saved);
  const legacyAgentEdit = store.mutateWorkstream({
    op: "edit",
    actor: agent,
    id: saved.id,
    expectedRevision: saved.revision,
    reason: "Legacy candidate edit",
    text: "More evidence needed",
  }).entry as Knowledge;
  expect(legacyAgentEdit).toMatchObject({
    state: "candidate",
    approval: null,
    kind: saved.kind,
    applicability: saved.applicability,
    sources: saved.sources,
    conflicts: saved.conflicts,
    supersedes: saved.supersedes,
  });
});

test("accept requires known explicit applicability, human action and immutable original provenance", () => {
  const { store, propose, accept } = fixture();
  const entry = propose();
  for (const applicability of [
    undefined,
    unknown,
    { ...stable, host: { mode: "unknown" } },
    { ...stable, environment: { mode: "unknown" } },
  ]) {
    expect(() => accept(entry, { applicability })).toThrow();
  }
  for (const actor of [agent, system]) expect(() => accept(entry, { actor, kind: "directive" })).toThrow("human");
  for (const patch of [
    { sources: [] },
    { subject: "another" },
    { workstreamId: "another" },
    { approval: { actor: human } },
  ])
    expect(() => accept(entry, patch)).toThrow("unknown field");
  expect(store.workstreamEntry(entry.id)).toEqual(entry);
  expect(store.workstreamHistory(entry.id).total).toBe(1);
});

test("accept requires a captured source rather than inventing human provenance", () => {
  const { store, propose, accept } = fixture();
  const entry = propose({ sources: [] });
  expect(() => accept(entry)).toThrow("source");
  expect(store.workstreamEntry(entry.id)).toEqual(entry);
});

test("accept refuses non-candidates, archived workstreams and current-subject conflicts without edits", () => {
  const { store, w, propose, accept } = fixture();
  const current = accept(propose()).entry as Knowledge;
  const candidate = propose({ text: "A correction" });
  expect(() => accept(candidate, { text: "Not saved" })).toThrow("subject");
  expect(store.workstreamEntry(candidate.id)).toEqual(candidate);
  expect(() => accept(current)).toThrow("candidate");
  store.mutateWorkstream({
    op: "edit-workstream",
    actor: human,
    id: w.id,
    expectedRevision: 1,
    archived: true,
    reason: "Archive",
  });
  expect(() => accept(candidate)).toThrow("archived");
  expect(store.workstreamEntry(candidate.id)).toEqual(candidate);
});

test("accept never revives disputed, recheck, approved or historical entries", () => {
  for (const state of ["disputed", "recheck", "approved", "archived", "rejected", "forgotten", "superseded"] as const) {
    const { store, propose, accept } = fixture();
    const entry = propose({ applicability: stable });
    if (state === "disputed") {
      const other = propose({ applicability: stable, text: "A conflict" });
      store.mutateWorkstream({
        op: "conflict",
        actor: agent,
        id: entry.id,
        expectedRevision: 1,
        otherId: other.id,
        otherExpectedRevision: 1,
        reason: "Dispute",
      });
    } else if (state === "superseded") {
      accept(propose({ text: "Replacement" }), { supersede: { id: entry.id, expectedRevision: 1 } });
    } else {
      store.mutateWorkstream({
        op: "transition",
        actor: human,
        id: entry.id,
        expectedRevision: 1,
        state,
        reason: "Review",
      });
    }
    const before = store.workstreamEntry(entry.id);
    const history = store.workstreamHistory(entry.id);
    expect(() => accept(before, { text: "Revived", kind: "directive" })).toThrow();
    expect(store.workstreamEntry(entry.id)).toEqual(before);
    expect(store.workstreamHistory(entry.id)).toEqual(history);
  }
});

test("accept with explicit supersession guards both revisions and atomically finalizes the replacement", () => {
  const { store, w, propose, accept } = fixture();
  const current = accept(propose(), { kind: "directive" }).entry as Knowledge;
  const candidate = propose({ text: "New observation" });
  for (const patch of [
    { supersede: { id: current.id, expectedRevision: 1 }, kind: "directive" },
    { supersede: { id: current.id, expectedRevision: current.revision }, kind: "finding" },
  ]) {
    expect(() => accept(candidate, patch)).toThrow();
    expect(store.workstreamEntry(candidate.id)).toEqual(candidate);
    expect(store.workstreamEntry(current.id)).toEqual(current);
  }
  const replacement = accept(candidate, {
    kind: "directive",
    text: "New rule",
    supersede: { id: current.id, expectedRevision: current.revision },
  }).entry as Knowledge;
  expect(replacement).toMatchObject({
    id: candidate.id,
    state: "approved",
    revision: 2,
    sources: candidate.sources,
    supersedes: [current.id],
  });
  expect(store.workstreamEntry(current.id)).toMatchObject({
    state: "superseded",
    revision: 3,
    supersededBy: candidate.id,
  });
  expect(store.readWorkstream(w.id).entries.map(e => e.id)).toEqual([candidate.id]);
});

test("accept replacement cannot bypass subject owners with unrelated, cross-scope or historical victims", () => {
  const { store, propose, accept } = fixture();
  const owner = accept(propose()).entry as Knowledge;
  const candidate = propose({ text: "Correction" });
  const unrelated = accept(propose({ subject: "independent" })).entry as Knowledge;
  const scoped = accept(propose({ subject: "scoped" }), {
    applicability: { ...stable, environment: { mode: "value", value: "prod" } },
  }).entry as Knowledge;
  const historical = propose({ subject: "old" });
  store.mutateWorkstream({
    op: "transition",
    actor: human,
    id: historical.id,
    expectedRevision: 1,
    state: "rejected",
    reason: "Reject",
  });
  for (const victim of [unrelated, scoped, { ...historical, revision: 2 }, { ...candidate, revision: 1 }]) {
    expect(() => accept(candidate, { supersede: { id: victim.id, expectedRevision: victim.revision } })).toThrow();
    expect(store.workstreamEntry(candidate.id)).toEqual(candidate);
    expect(store.workstreamEntry(owner.id)).toEqual(owner);
  }
});

test("accept checks replacement-victim and subject guards using final applicability and kind", () => {
  const { store, propose, accept } = fixture();
  const prod = { ...stable, environment: { mode: "value", value: "prod" } };
  const current = accept(propose(), { applicability: prod, kind: "directive" }).entry as Knowledge;
  const unrelated = accept(propose({ subject: "unrelated" }), { applicability: prod }).entry as Knowledge;
  const candidate = propose({ applicability: stable, text: "A correction" });
  expect(() =>
    accept(candidate, {
      applicability: prod,
      kind: "directive",
      supersede: { id: unrelated.id, expectedRevision: unrelated.revision },
    }),
  ).toThrow("subject");
  expect(() =>
    accept(candidate, {
      applicability: stable,
      kind: "directive",
      supersede: { id: current.id, expectedRevision: current.revision },
    }),
  ).toThrow("applicability");
  const replacement = accept(candidate, {
    applicability: prod,
    kind: "directive",
    supersede: { id: current.id, expectedRevision: current.revision },
  }).entry as Knowledge;
  expect(replacement).toMatchObject({ applicability: prod, kind: "directive", sources: candidate.sources });
  expect(store.workstreamEntry(current.id).state).toBe("superseded");
});

test("accept replacement refuses another workstream even when subject and final scope match", () => {
  const { store, propose, accept } = fixture();
  const other = store.mutateWorkstream({ op: "create", actor: human, name: "Other" }).workstream as Workstream;
  const victim = accept(propose({ workstreamId: other.id })).entry as Knowledge;
  const candidate = propose();
  expect(() => accept(candidate, { supersede: { id: victim.id, expectedRevision: victim.revision } })).toThrow(
    "workstream",
  );
  expect(store.workstreamEntry(victim.id)).toEqual(victim);
  expect(store.workstreamEntry(candidate.id)).toEqual(candidate);
});

test("accept does not partially resolve additional conflicts or elevate quoted messages", () => {
  const { store, propose, accept } = fixture();
  const owner = accept(propose(), { kind: "directive" }).entry as Knowledge;
  const candidate = propose({ applicability: stable, text: "Contrary claim" });
  const extra = propose({ applicability: stable, subject: "another", text: "Another conflict" });
  store.mutateWorkstream({
    op: "conflict",
    actor: agent,
    id: candidate.id,
    expectedRevision: 1,
    otherId: extra.id,
    otherExpectedRevision: 1,
    reason: "Dispute",
  });
  const disputed = store.workstreamEntry(candidate.id);
  expect(() => accept(disputed)).toThrow();
  expect(() =>
    accept(disputed, { supersede: { id: owner.id, expectedRevision: owner.revision }, kind: "directive" }),
  ).toThrow();
  expect(store.workstreamEntry(owner.id)).toEqual(owner);
  expect(store.workstreamEntry(candidate.id)).toEqual(disputed);
});

test("save-approved writes one human-approved revision and stable retries cannot duplicate or reapprove", () => {
  const { store, w } = fixture();
  const intended = id("kn");
  const input = {
    op: "save-approved",
    id: intended,
    actor: human,
    reason: "Written and reviewed",
    workstreamId: w.id,
    subject: "manual",
    title: "Manual note",
    text: "Keep this note",
    kind: "finding",
    facet: "orientation",
    applicability: stable,
    sources,
  };
  const first = store.mutateWorkstream(input).entry as Knowledge;
  expect(first).toMatchObject({ id: intended, revision: 1, state: "approved", approval: { actor: human } });
  expect(store.workstreamHistory(intended).total).toBe(1);
  expectConflict(() => store.mutateWorkstream(input));
  expect(store.showWorkstream(w.id).total).toBe(1);
  expect(store.readWorkstream(w.id).entries).toEqual([first]);
});

test("save-approved refuses exact duplicate candidates and historical entries rather than adopting them", () => {
  for (const state of ["candidate", "rejected", "archived"] as const) {
    const { store, w, propose } = fixture();
    const existing = propose({ applicability: stable });
    if (state !== "candidate")
      store.mutateWorkstream({
        op: "transition",
        actor: human,
        id: existing.id,
        expectedRevision: 1,
        state,
        reason: "Review",
      });
    const before = store.workstreamEntry(existing.id);
    const intended = id("kn");
    expect(() =>
      store.mutateWorkstream({
        op: "save-approved",
        id: intended,
        actor: human,
        reason: "Review",
        workstreamId: w.id,
        subject: existing.subject,
        title: existing.title,
        text: existing.text,
        kind: existing.kind,
        facet: existing.facet,
        applicability: stable,
        sources: existing.sources,
      }),
    ).toThrow();
    expect(store.workstreamEntry(existing.id)).toEqual(before);
    expect(store.showWorkstream(w.id).total).toBe(1);
    expect(() => store.workstreamHistory(intended)).toThrow("not found");
  }
});

test("accept replacement and save-approved roll back entity and history writes on storage failure", () => {
  for (const operation of ["accept", "save-approved"] as const) {
    const { store, w, propose, accept } = fixture();
    const current = accept(propose()).entry as Knowledge;
    const candidate = propose({ text: "Replacement" });
    const intended = id("kn");
    const target = store as unknown as { saveWorkstreamEntity(...args: unknown[]): void };
    const save = target.saveWorkstreamEntity.bind(store);
    let writes = 0;
    const failingSave = spyOn(target, "saveWorkstreamEntity").mockImplementation((...args: unknown[]) => {
      save(...args);
      writes++;
      if (writes === (operation === "accept" ? 2 : 1)) throw new Error("Injected storage failure");
    });
    try {
      expect(() =>
        operation === "accept"
          ? accept(candidate, { supersede: { id: current.id, expectedRevision: current.revision } })
          : store.mutateWorkstream({
              op: "save-approved",
              id: intended,
              actor: human,
              reason: "Written",
              workstreamId: w.id,
              subject: "manual",
              title: "Manual",
              text: "Human note",
              kind: "finding",
              facet: "orientation",
              applicability: stable,
              sources,
            }),
      ).toThrow("Injected storage failure");
    } finally {
      failingSave.mockRestore();
    }
    expect(store.workstreamEntry(current.id)).toEqual(current);
    expect(store.workstreamEntry(candidate.id)).toEqual(candidate);
    expect(store.workstreamHistory(current.id).total).toBe(2);
    expect(store.workstreamHistory(candidate.id).total).toBe(1);
    expect(store.showWorkstream(w.id).total).toBe(2);
    expect(() => store.workstreamHistory(intended)).toThrow("not found");
  }
});

test("save-approved validation and subject refusal leave no proposal, history or partial write", () => {
  const { store, w, propose, accept } = fixture();
  const current = accept(propose()).entry as Knowledge;
  const intended = id("kn");
  const input = {
    op: "save-approved",
    id: intended,
    actor: human,
    reason: "Written and reviewed",
    workstreamId: w.id,
    subject: current.subject,
    title: "Manual note",
    text: "A different note",
    kind: "finding",
    facet: "orientation",
    applicability: stable,
    sources,
  };
  for (const patch of [
    {},
    { actor: agent },
    { actor: system },
    { applicability: unknown },
    { id: undefined },
    { reason: undefined },
    { sources: [] },
  ])
    expect(() => store.mutateWorkstream({ ...input, ...patch })).toThrow();
  expect(() => store.workstreamHistory(intended)).toThrow("not found");
  expect(store.showWorkstream(w.id).total).toBe(1);
  expect(store.workstreamEntry(current.id)).toEqual(current);
});

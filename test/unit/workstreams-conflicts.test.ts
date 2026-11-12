import { afterEach, expect, test } from "bun:test";
import { Store } from "../../src/store.ts";
import type { Actor, Knowledge, Workstream } from "../../src/workstreams.ts";

const human: Actor = { id: "reviewer", type: "human" };
const agent: Actor = { id: "agent", type: "agent" };
const scope = { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } } as const;
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const store = Store.open(":memory:");
  stores.push(store);
  const w = store.mutateWorkstream({ op: "create", actor: human, name: "Envoy" }).workstream as Workstream;
  const propose = (subject: string) =>
    store.mutateWorkstream({
      op: "propose",
      actor: agent,
      workstreamId: w.id,
      subject,
      title: subject,
      text: subject,
      kind: "finding",
      facet: "orientation",
      applicability: scope,
      sources: [{ ref: "test:evidence", authorType: "agent", observedAt: "2026-01-01T00:00:00.000Z" }],
    }).entry as Knowledge;
  const current = (entry: Knowledge) => store.workstreamEntry(entry.id);
  const mutate = (entry: Knowledge, fields: Record<string, unknown>) =>
    store.mutateWorkstream({
      actor: human,
      id: entry.id,
      expectedRevision: current(entry).revision,
      reason: "Reviewed",
      ...fields,
    }).entry as Knowledge;
  const conflict = (a: Knowledge, b: Knowledge) =>
    mutate(a, { op: "conflict", otherId: b.id, otherExpectedRevision: current(b).revision });
  return { store, propose, current, mutate, conflict };
}

for (const state of ["archived", "rejected", "forgotten", "superseded"] as const) {
  test(`approval ignores ${state} conflict partners and preserves their history`, () => {
    const { store, propose, current, mutate, conflict } = fixture();
    const a = propose("Current");
    const b = propose("Old");
    conflict(a, b);
    if (state === "superseded") {
      const replacement = propose("Replacement");
      conflict(replacement, b);
      mutate(a, { op: "transition", state: "archived" });
      mutate(replacement, { op: "supersede", otherId: b.id, otherExpectedRevision: current(b).revision });
    } else mutate(b, { op: "transition", state });
    const historical = current(b);
    const history = store.workstreamHistory(b.id);
    expect(mutate(a, { op: "transition", state: "approved" })).toMatchObject({ state: "approved", conflicts: [] });
    expect(current(b)).toEqual(historical);
    expect(store.workstreamHistory(b.id)).toEqual(history);
  });
}

test("live conflict blocks approval, including restoring an archived entry", () => {
  const { propose, mutate, conflict } = fixture();
  const a = propose("Current");
  const b = propose("Live");
  conflict(a, b);
  expect(() => mutate(a, { op: "transition", state: "approved" })).toThrow("Resolve conflicts");
  mutate(a, { op: "transition", state: "archived" });
  expect(() => mutate(a, { op: "transition", state: "approved" })).toThrow("Resolve conflicts");
});

test("accept a candidate with stale conflicts but refuse a live conflict", () => {
  const { propose, mutate, conflict } = fixture();
  const a = propose("Current");
  const b = propose("Old");
  conflict(a, b);
  mutate(a, { op: "edit" });
  expect(() => mutate(a, { op: "accept", applicability: scope })).toThrow("Resolve conflicts");
  mutate(b, { op: "transition", state: "archived" });
  expect(mutate(a, { op: "accept", applicability: scope })).toMatchObject({ state: "approved", conflicts: [] });
});

for (const op of ["accept", "supersede"] as const) {
  test(`${op} ignores stale extra conflicts on both entries but still refuses historical replacement`, () => {
    const { propose, current, mutate, conflict } = fixture();
    const a = propose("Current");
    const b = propose("Other");
    const stale = propose("Stale");
    conflict(a, b);
    conflict(a, stale);
    conflict(b, stale);
    mutate(stale, { op: "transition", state: "archived" });
    if (op === "accept") mutate(a, { op: "edit" });
    const fields =
      op === "accept"
        ? { op, applicability: scope, supersede: { id: b.id, expectedRevision: current(b).revision } }
        : { op, otherId: b.id, otherExpectedRevision: current(b).revision };
    expect(mutate(a, fields)).toMatchObject({ state: "approved", conflicts: [] });
    expect(current(b)).toMatchObject({ state: "superseded", conflicts: [] });
    expect(current(stale).conflicts).toEqual([a.id, b.id]);
    expect(() =>
      mutate(
        propose("Another"),
        op === "accept"
          ? { op, applicability: scope, supersede: { id: stale.id, expectedRevision: current(stale).revision } }
          : { op, otherId: stale.id, otherExpectedRevision: current(stale).revision },
      ),
    ).toThrow("Historical entries");
  });
}

for (const state of ["archived", "rejected"] as const) {
  test(`only a human can restore ${state} to review with a reason-only edit`, () => {
    const { store, propose, current, mutate } = fixture();
    const a = propose("Saved");
    mutate(a, { op: "transition", state });
    expect(() => mutate(a, { op: "edit", actor: agent })).toThrow("human");
    const before = current(a);
    expect(mutate(a, { op: "edit" })).toMatchObject({
      state: "candidate",
      text: before.text,
      sources: before.sources,
      approval: null,
    });
    expect(store.workstreamHistory(a.id).revisions.at(-1)?.action).toBe("edit");
  });
}

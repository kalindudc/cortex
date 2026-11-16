import { expect, test } from "bun:test";
import { Store } from "../../src/store.ts";
import type { Applicability, WorkstreamMutation } from "../../src/workstreams.ts";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected fixture result");
  return value;
}
test.each([false, true])("human applicability correction preserves known dimensions: changeKnown=%s", changeKnown => {
  const store = Store.open(":memory:");
  try {
    const actor = { id: "person", type: "human" } as const;
    const ws = required(store.mutateWorkstream({ op: "create", actor, name: "Payments" }).workstream);
    const fields = {
      actor,
      workstreamId: ws.id,
      subject: "deploy",
      title: "Deploy",
      text: "Check rollout",
      kind: "directive" as const,
      facet: "orientation",
      sources: [{ ref: "test:human", authorType: "human" as const, observedAt: "2026-01-01T00:00:00.000Z" }],
    };
    const unknown: Applicability = { environment: { mode: "unknown" }, host: { mode: "not-applicable" } };
    const candidate = required(store.mutateWorkstream({ op: "propose", ...fields, applicability: unknown }).entry);
    const old = required(
      store.mutateWorkstream({
        op: "transition",
        actor,
        id: candidate.id,
        expectedRevision: candidate.revision,
        state: "approved",
        reason: "Reviewed",
      }).entry,
    );
    const applicability: Applicability = {
      environment: { mode: "value", value: "staging" },
      host: changeKnown ? { mode: "value", value: "new-host" } : { mode: "not-applicable" },
    };
    const next = required(store.mutateWorkstream({ op: "propose", ...fields, applicability }).entry);
    const mutation: WorkstreamMutation = {
      op: "accept",
      actor,
      id: next.id,
      expectedRevision: next.revision,
      applicability,
      reason: "Corrected where it applies",
      supersede: { id: old.id, expectedRevision: old.revision },
    };
    if (changeKnown) {
      expect(() => store.mutateWorkstream(mutation)).toThrow("same workstream and applicability");
    } else {
      const result = required(store.mutateWorkstream(mutation).entry);
      expect(result.state).toBe("approved");
      expect(result.applicability).toEqual(applicability);
      expect(store.listKnowledge({ workstream: ws.id }).items.find(row => row.entry.id === old.id)?.entry.state).toBe(
        "superseded",
      );
    }
  } finally {
    store.close();
  }
});

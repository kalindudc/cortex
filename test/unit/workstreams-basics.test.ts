import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/store.ts";
import type { Knowledge, Workstream } from "../../src/workstreams.ts";

test("human facet edit and guarded acceptance preserve identity and text in shared basics", () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-basics-"));
  const store = Store.open(join(dir, "cortex.db"));
  const actor = { id: "human", type: "human" } as const;
  const applicability = { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } } as const;
  try {
    const workstream = store.mutateWorkstream({ op: "create", actor, name: "Envoy" }).workstream as Workstream;
    const candidate = store.mutateWorkstream({
      op: "propose",
      actor,
      workstreamId: workstream.id,
      subject: "production-writes",
      title: "Manual production Kubernetes writes",
      text: "Ask before any production write.",
      facet: "operating rule",
      kind: "finding",
      sources: [{ ref: "manual:production-policy", authorType: "human", observedAt: "2026-01-01T00:00:00.000Z" }],
      applicability,
    }).entry as Knowledge;
    const approved = store.mutateWorkstream({
      op: "accept",
      actor,
      id: candidate.id,
      expectedRevision: candidate.revision,
      applicability,
      reason: "Reviewed",
    }).entry as Knowledge;
    const edited = store.mutateWorkstream({
      op: "edit",
      actor,
      id: approved.id,
      expectedRevision: approved.revision,
      facet: "orientation",
      reason: "Human moved entry to shared basics",
    }).entry as Knowledge;
    expect(edited.state).toBe("candidate");
    expect(() =>
      store.mutateWorkstream({
        op: "accept",
        actor,
        id: edited.id,
        expectedRevision: approved.revision,
        applicability,
        reason: "Stale",
      }),
    ).toThrow("revision conflict");
    const result = store.mutateWorkstream({
      op: "accept",
      actor,
      id: edited.id,
      expectedRevision: edited.revision,
      applicability,
      reason: "Human approved shared basics",
    }).entry as Knowledge;
    expect(result).toMatchObject({
      id: approved.id,
      text: approved.text,
      state: "approved",
      facet: "orientation",
      applicability,
    });
    expect(store.readWorkstream(workstream.id, {}).entries.map(entry => entry.id)).toContain(result.id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test, vi } from "vitest";
import { createWorkstreams } from "./workstreams";
import { createSections } from "./sections";
import { createProblems } from "./problem-service";
import { problemHandlers } from "./problem-rpc";
import { problemRpcMethods } from "./problem-contract";
import type { CortexRunner } from "./cli";
import type { DraftService } from "./draft-service";
import type { Knowledge } from "./workstream-contract";
const actor = { id: "human", type: "human" } as const;
const at = "2026-01-01T00:00:00.000Z";
const any = { mode: "not-applicable" } as const;
const applicability = { environment: any, host: any };
const ws = { id: "ws_one", revision: 1, name: "Envoy", description: "", archived: false, actor, createdAt: at, updatedAt: at };
const entry: Knowledge = { id: "kn_one", revision: 2, workstreamId: ws.id, subject: "production", title: "Manual production writes", text: "Ask first", kind: "finding", state: "approved", facet: "operating rule", applicability, sources: [], actor, createdAt: at, updatedAt: at, expiresAt: null, approval: { actor, at }, supersedes: [], supersededBy: null, conflicts: [] };
async function setup() {
  const host = createFakePluginHost({ pluginId: "cortex", sdk: { threadSections: { list: async () => [{ id: "sec_one", name: "Envoy", createdAt: 0, updatedAt: 0 }] }, threads: { list: async () => [] }, subscribe: () => () => {} } });
  const service = createWorkstreams(host.bb, { binary: "fake", run: vi.fn(), text: vi.fn() } as unknown as CortexRunner, { userAuthor: "human", widgetDefault: () => false });
  let current = { ...entry };
  vi.spyOn(service.cli, "knowledge").mockImplementation(async () => current);
  vi.spyOn(service.cli, "knowledgeList").mockImplementation(async () => ({ items: [{ entry: current, workstream: ws, hints: [] }], total: 1, limit: 100, offset: 0 }));
  vi.spyOn(service.cli, "read").mockResolvedValue({ workstream: ws, entries: [], notices: [], applicability, topic: null });
  vi.spyOn(service.cli, "show").mockResolvedValue({ workstream: ws, entries: [], total: 0, limit: 1, offset: 0 });
  service.store.setSection("sec_one", 0, { workstreamId: ws.id, topic: null, applicability, requiredKnowledgeIds: [], budgetTokens: 3000 });
  const read = createProblems(createSections(host.bb, service), service, { jobs: () => ({ jobs: [], total: 0 }) } as unknown as DraftService);
  host.bb.rpc.register(problemRpcMethods, problemHandlers(read, service));
  return { host, service, read, set: (value: Knowledge) => { current = value; } };
}
const input = { sectionId: "sec_one", id: entry.id, expectedRevision: entry.revision };
test("Ignore here removes the problem, revision changes re-raise it, and Undo only removes that dismissal", async () => {
  const { host, service, read, set } = await setup();
  try {
    expect((await read()).problems).toHaveLength(1);
    await expect(host.harness.behavior.callRpc("problemEntryDismiss", { ...input, expectedRevision: 1 })).rejects.toMatchObject({ code: "conflict" });
    await host.harness.behavior.callRpc("problemEntryDismiss", input);
    expect((await read()).problems).toEqual([]);
    expect(service.store.problemDismissed("sec_other", entry.id, entry.revision)).toBe(false);
    set({ ...entry, revision: 3 });
    expect((await read()).problems[0]?.entries?.[0]?.revision).toBe(3);
    set(entry);
    await host.harness.behavior.callRpc("problemEntryUndo", input);
    expect((await read()).problems).toHaveLength(1);
    await expect(host.harness.behavior.callRpc("problemEntryDismiss", { ...input, expectedRevision: -1 })).rejects.toBeTruthy();
    await expect(host.harness.behavior.callRpc("problemEntryUndo", { ...input, extra: true })).rejects.toBeTruthy();
  } finally { await host.harness.lifecycle.dispose(); }
});
test.each([false, true])("Move to shared basics uses human revision-checked edit and accept; refused=%s", async refused => {
  const { host, service, set } = await setup();
  const candidate = { ...entry, revision: 3, facet: "orientation", state: "candidate" as const, approval: null };
  const mutate = vi.spyOn(service.cli, "mutate").mockImplementation(async value => {
    const op = value as { op: string };
    if (op.op === "edit") { set(candidate); return { outcome: "updated", entry: candidate }; }
    if (refused) throw new Error("An approved entry already owns this subject/applicability; use explicit supersession of that entry");
    return { outcome: "updated", entry: { ...candidate, state: "approved", revision: 4, approval: { actor, at } } };
  });
  try {
    const result = await host.harness.behavior.callRpc("knowledgeMoveToBasics", input) as { waitingInReview: boolean; refusal: string | null };
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({ op: "edit", actor, id: entry.id, expectedRevision: 2, facet: "orientation" });
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({ op: "accept", actor, id: entry.id, expectedRevision: 3, applicability });
    expect(result.waitingInReview).toBe(refused);
    if (refused) { expect(result.refusal).toContain("An approved entry already owns"); expect((await service.cli.knowledge(entry.id)).state).toBe("candidate"); }
    await expect(host.harness.behavior.callRpc("knowledgeMoveToBasics", input)).rejects.toMatchObject({ code: "conflict" });
    expect(mutate).toHaveBeenCalledTimes(2);
  } finally { await host.harness.lifecycle.dispose(); }
});

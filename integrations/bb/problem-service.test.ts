import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test, vi } from "vitest";
import { createWorkstreams } from "./workstreams";
import { createSections } from "./sections";
import { createProblems } from "./problem-service";
import { problemHandlers } from "./problem-rpc";
import { problemRpcMethods } from "./problem-contract";
import { workstreamHandlers } from "./workstream-rpc";
import { workstreamRpcContract } from "./workstream-contract";
import type { CortexRunner } from "./cli";
import type { DraftService } from "./draft-service";
const at = "2026-01-01T00:00:00.000Z";
const actor = { id: "human", type: "human" } as const;
const applicability = { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } } as const;
const ws = { id: "ws_one", revision: 1, name: "Payments", description: "", archived: false, actor, createdAt: at, updatedAt: at };
test("problems read uses one canonical read per connected section; jobs stay local, and author is listable", async () => {
  const host = createFakePluginHost({ pluginId: "cortex", sdk: {
    threadSections: { list: async () => [{ id: "sec_one", name: "Payments", createdAt: 0, updatedAt: 0 }, { id: "sec_two", name: "Billing", createdAt: 0, updatedAt: 0 }] },
    threads: { list: async () => [] },
    subscribe: () => () => {},
  } });
  const run = vi.fn(async (args, schema) => {
    if (args[1] === "read") return schema.parse({ workstream: ws, entries: [], notices: [], applicability, topic: null });
    if (args[1] === "knowledge") return schema.parse({ items: [{ workstream: ws, hints: [], entry: { id: "kn_target", workstreamId: ws.id, subject: "deploy", title: "Deploy to staging", text: "Check the rollout", kind: "finding", state: "approved", facet: "orientation", applicability: { ...applicability, environment: { mode: "value", value: "staging" } }, sources: [], revision: 1, actor, createdAt: at, updatedAt: at, expiresAt: null, approval: { actor, at }, supersedes: [], conflicts: [], supersededBy: null } }], total: 1, limit: 100, offset: 0 });
    if (args[1] === "show") return schema.parse({ workstream: ws, entries: [], total: 0, limit: 1, offset: 0 });
    throw new Error("Unexpected CLI call");
  });
  const service = createWorkstreams(host.bb, { binary: "fake", run, text: async () => { throw new Error("No text reads"); } } as CortexRunner, { userAuthor: null, widgetDefault: () => false });
  const sections = createSections(host.bb, service);
  const jobs = vi.fn(() => ({ jobs: [], total: 0, limit: 50, offset: 0 }));
  const read = createProblems(sections, service, { jobs } as unknown as DraftService);
  try {
    service.store.setSection("sec_one", 0, { workstreamId: ws.id, topic: null, budgetTokens: 3000, requiredKnowledgeIds: ["kn_missing"], applicability });
    host.bb.rpc.register(problemRpcMethods, problemHandlers(read, service));
    const result = await host.harness.behavior.callRpc("problems", null) as Awaited<ReturnType<typeof read>>;
    // The staging-only entry reaches no thread in a section that targets any environment.
    expect(result.problems.map(row => row.kind)).toEqual(["human-author", "missing-required", "unreached"]);
    expect(run.mock.calls.filter(([args]) => args[1] === "read")).toHaveLength(1);
    expect(jobs).toHaveBeenCalledTimes(2);
    const unknown = { ...applicability, environment: { mode: "unknown" as const } };
    const binding = { workstreamId: ws.id, topic: null, budgetTokens: 3000, requiredKnowledgeIds: [], applicability: unknown };
    service.store.setSection("sec_one", 1, binding);
    service.store.setSection("sec_two", 0, binding);
    const targets = await host.harness.behavior.callRpc("problems", null) as Awaited<ReturnType<typeof read>>;
    expect(targets.problems.filter(row => row.kind === "target")).toHaveLength(2);
    expect(targets.problems.filter(row => row.kind === "unreached")).toHaveLength(0);
    // One shared knowledge read per problems read, reused by both sections and the unreached check.
    expect(run.mock.calls.filter(([args]) => args[1] === "knowledge")).toHaveLength(2);
  } finally { await host.harness.lifecycle.dispose(); }
});
test("Remove from required preserves other binding fields and rejects a stale revision", async () => {
  const host = createFakePluginHost({ pluginId: "cortex" });
  const runner = { binary: "fake", run: async (_args, schema) => schema.parse({ workstream: ws, entries: [], total: 0, limit: 1, offset: 0 }), text: async () => "" } as CortexRunner;
  const service = createWorkstreams(host.bb, runner, { userAuthor: "human", widgetDefault: () => false });
  try {
    const binding = { workstreamId: ws.id, topic: null, budgetTokens: 3000, requiredKnowledgeIds: ["kn_missing", "kn_keep"], applicability };
    const row = service.store.setSection("sec_one", 0, binding);
    host.bb.rpc.register(workstreamRpcContract, workstreamHandlers(service));
    const input = { sectionId: "sec_one", expectedRevision: row.revision, binding: { ...binding, requiredKnowledgeIds: ["kn_keep"] } };
    await host.harness.behavior.callRpc("setSectionBinding", input);
    expect(service.store.section("sec_one").binding).toEqual(input.binding);
    await expect(host.harness.behavior.callRpc("setSectionBinding", input)).rejects.toMatchObject({ code: "conflict" });
    expect(service.store.section("sec_one").binding?.requiredKnowledgeIds).toEqual(["kn_keep"]);
  } finally { await host.harness.lifecycle.dispose(); }
});

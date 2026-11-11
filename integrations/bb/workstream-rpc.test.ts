import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, test } from "vitest";
import type { CortexRunner } from "./cli";
import { workstreamRpcContract, workstreamRpcMethods, type Knowledge, type Workstream } from "./workstream-contract";
import { workstreamHandlers } from "./workstream-rpc";
import { createWorkstreams } from "./workstreams";

const at = "2026-01-01T00:00:00.000Z";
const actor = { id: "test-human", type: "human" as const };
const workstream: Workstream = {
  id: "ws_one",
  name: "Canonical workstream",
  description: "",
  revision: 3,
  archived: false,
  createdAt: at,
  updatedAt: at,
  actor,
};
const current: Knowledge = {
  id: "kn_one",
  workstreamId: workstream.id,
  subject: "one",
  title: "Current knowledge",
  text: "Approved revision two",
  kind: "finding",
  state: "approved",
  facet: "orientation",
  applicability: { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } },
  sources: [],
  revision: 2,
  actor,
  createdAt: at,
  updatedAt: at,
  expiresAt: null,
  approval: { actor, at },
  supersedes: [],
  supersededBy: null,
  conflicts: [],
};
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
function setup(malformed?: "entry" | "workstream") {
  const calls: string[][] = [];
  const runner: CortexRunner = {
    binary: "fake-canonical-cli",
    async run(args, schema) {
      calls.push([...args]);
      if (args[1] === "entry") {
        if (args[2] === "kn_missing") throw new Error("Saved knowledge kn_missing not found");
        return schema.parse(malformed === "entry" ? { ...current, unexpected: "untrusted" } : current);
      }
      if (args[1] === "show")
        return schema.parse({
          workstream: malformed === "workstream" ? { ...workstream, unexpected: "untrusted" } : workstream,
          entries: [{ ...current, state: "candidate", approval: null, revision: 1 }],
          total: 200,
          limit: 1,
          offset: 0,
        });
      throw new Error(`No history, search or mutation fallback allowed: ${args.join(" ")}`);
    },
    async text() {
      throw new Error("No legacy text fallback allowed");
    },
  };
  const host = createFakePluginHost({ pluginId: "cortex" });
  disposers.push(() => host.harness.lifecycle.dispose());
  const service = createWorkstreams(host.bb, runner, { userAuthor: actor.id, widgetDefault: () => true });
  host.bb.rpc.register(workstreamRpcContract, workstreamHandlers(service));
  return { ...host, calls, service };
}

describe("knowledgeShow canonical read", () => {
  test("returns current revision two and bounded canonical workstream metadata, not page revision one", async () => {
    const s = setup();
    expect(await s.harness.behavior.callRpc("knowledgeShow", { id: current.id })).toEqual({
      entry: current,
      workstream,
    });
    expect(s.calls).toEqual([
      ["workstream", "entry", current.id, "--json"],
      ["workstream", "show", workstream.id, "--json", "--limit=1", "--offset=0"],
    ]);
    expect(s.service.store.receipts("thr_aaaaaaaa", 1, 0).total).toBe(0);
  });
  test("unknown knowledge ID is a not_found refusal without fallback reads", async () => {
    const s = setup();
    await expect(s.harness.behavior.callRpc("knowledgeShow", { id: "kn_missing" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(s.calls).toEqual([["workstream", "entry", "kn_missing", "--json"]]);
  });
  test.each([
    { id: "ws_one" },
    { id: "kn_one", threadId: "thr_aaaaaaaa" },
    { id: "kn_one", actor },
    {},
  ])("rejects strict invalid input before CLI reads: %j", async input => {
    const s = setup();
    await expect(s.harness.behavior.callRpc("knowledgeShow", input)).rejects.toMatchObject({ code: "invalid_input" });
    expect(s.calls).toEqual([]);
  });
  test.each(["entry", "workstream"] as const)("rejects an unexpected field in canonical %s DTO", async malformed => {
    const s = setup(malformed);
    await expect(s.harness.behavior.callRpc("knowledgeShow", { id: current.id })).rejects.toMatchObject({
      code: "invalid",
    });
  });
  test("output contract is strict at the envelope and both DTO levels", () => {
    const output = workstreamRpcMethods.knowledgeShow.output;
    expect(output.safeParse({ entry: current, workstream }).success).toBe(true);
    expect(output.safeParse({ entry: current, workstream, extra: true }).success).toBe(false);
    expect(output.safeParse({ entry: { ...current, extra: true }, workstream }).success).toBe(false);
    expect(output.safeParse({ entry: current, workstream: { ...workstream, extra: true } }).success).toBe(false);
  });
});

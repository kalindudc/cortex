import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createCortexRunner, type CortexRunner } from "./cli";
import { createWorkstreamCli } from "./workstream-cli";

test("current knowledge uses the direct entry read, never oldest history revision", async () => {
  const at = "2026-01-01T00:00:00.000Z",
    actor = { id: "you", type: "human" };
  const entry = {
    id: "kn_one",
    workstreamId: "ws_one",
    subject: "one",
    title: "One",
    text: "current approved revision",
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
  const calls: string[][] = [];
  const runner: CortexRunner = {
    binary: "fake",
    async run(args, schema) {
      calls.push([...args]);
      if (args[1] === "history") throw new Error("History starts at candidate revision 1, not current revision 2");
      return schema.parse(entry);
    },
    async text() {
      throw new Error("unexpected text read");
    },
  };
  expect((await createWorkstreamCli(runner).knowledge("kn_one")).revision).toBe(2);
  expect(calls).toEqual([["workstream", "entry", "kn_one", "--json"]]);
});

test("mutation adapter uses --input=- and streams the exact JSON body", async () => {
  const input = { op: "create", name: "Sandbox", actor: { id: "you", type: "human" } },
    calls: Array<{ args: string[]; input: string | undefined }> = [];
  const runner: CortexRunner = {
    binary: "fake",
    async run(args, schema, options) {
      calls.push({ args: [...args], input: options?.input });
      return schema.parse({ outcome: "no-save", reason: "Test fixture" });
    },
    async text() {
      throw new Error("unexpected");
    },
  };
  await createWorkstreamCli(runner).mutate(input);
  expect(calls).toEqual([{ args: ["workstream", "mutate", "--input=-", "--json"], input: JSON.stringify(input) }]);
});

const binary = fileURLToPath(new URL("../../bin/cortex", import.meta.url));
test.skipIf(!fs.existsSync(binary))(
  "real CLI bridge reads approved canonical revision 2 in an isolated database",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-workstream-bridge-"));
    const runner = await createCortexRunner(binary, {
      HOME: root,
      PATH: process.env.PATH ?? "",
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_RUNTIME_DIR: path.join(root, "runtime"),
      CORTEX_DB: path.join(root, "test.db"),
      CORTEX_BB_CLI: "",
    });
    const cli = createWorkstreamCli(runner),
      actor = { id: "bridge-test", type: "human" };
    try {
      const w = await cli.mutate({ op: "create", name: "Bridge sandbox", actor });
      const candidate = await cli.mutate({
        op: "propose",
        workstreamId: w.workstream!.id,
        subject: "bridge",
        title: "Bridge",
        text: "canonical context",
        kind: "finding",
        facet: "orientation",
        applicability: { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } },
        sources: [],
        actor,
      });
      const approved = await cli.mutate({
        op: "transition",
        id: candidate.entry!.id,
        expectedRevision: 1,
        state: "approved",
        reason: "Explicit test approval",
        actor,
      });
      const current = await cli.knowledge(candidate.entry!.id);
      expect(current.revision).toBe(2);
      expect(current.state).toBe("approved");
      expect(current).toEqual(approved.entry);
      expect((await cli.knowledgeList({ reviewOnly: true, limit: 50, offset: 0 })).items).toEqual([]);
      const ctx = await cli.read(w.workstream!.id, null, {
        environment: { mode: "unknown" },
        host: { mode: "unknown" },
      });
      expect(ctx.entries[0]?.revision).toBe(2);
    } finally {
      await runner.text(["stop"]);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);

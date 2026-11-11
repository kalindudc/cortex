import { afterEach, expect, test } from "bun:test";
import { mkTmpEnv, runCli } from "../helpers.ts";
import { reap, startForeground } from "../fixtures/daemon.ts";
import type { Knowledge, Workstream, MutationResult, WorkstreamMutation } from "../../../src/workstreams.ts";
const cleanup: (() => void)[] = [];
afterEach(async () => {
  await reap();
  for (const fn of cleanup.splice(0)) fn();
});
const actor = { id: "reviewer", type: "human" as const };
for (const daemon of [false, true]) {
  test(`workstream compiled CLI ${daemon ? "daemon" : "offline"}: JSON mutations, CAS, context, history and review query`, async () => {
    const sandbox = mkTmpEnv("workstreams");
    cleanup.push(sandbox.cleanup);
    const call = (args: string[], stdin?: string) =>
      runCli({ args: ["workstream", ...args, "--json"], env: sandbox.env, stdin });
    const mutate = async (input: WorkstreamMutation): Promise<MutationResult> => {
      const r = await call(["mutate", "--input=-"], JSON.stringify(input));
      expect(r.code).toBe(0);
      return JSON.parse(r.stdout);
    };
    if (daemon) await startForeground(sandbox.env);
    const w = (await mutate({ op: "create", actor, name: "Envoy" })).workstream as Workstream;
    const proposed = (
      await mutate({
        op: "propose",
        actor: { id: "agent", type: "agent" },
        workstreamId: w.id,
        subject: "version",
        title: "Gateway version",
        text: "Production is version 5",
        kind: "finding",
        facet: "orientation",
        applicability: {
          environment: { mode: "value", value: "production" },
          host: { mode: "value", value: "cluster-a" },
        },
        sources: [{ ref: "command:1", authorType: "agent", observedAt: "2026-01-01T00:00:00.000Z" }],
      })
    ).entry as Knowledge;
    expect(
      JSON.parse((await call(["read", w.id, "--environment=production", "--host=cluster-a"])).stdout).entries,
    ).toEqual([]);
    const approved = (
      await mutate({
        op: "transition",
        actor,
        id: proposed.id,
        expectedRevision: 1,
        state: "approved",
        reason: "Checked evidence",
      })
    ).entry as Knowledge;
    expect(
      JSON.parse((await call(["read", w.id, "--environment=production", "--host=cluster-a"])).stdout).entries.map(
        (e: Knowledge) => e.id,
      ),
    ).toEqual([approved.id]);
    expect(
      JSON.parse((await call(["read", w.id, "--environment=sandbox", "--host=cluster-a"])).stdout).entries,
    ).toEqual([]);
    const stale = await call([
      "mutate",
      "--input",
      JSON.stringify({ op: "edit", actor, id: proposed.id, expectedRevision: 1, text: "Stale", reason: "Edit" }),
    ]);
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.stdout).error.code).toBe("conflict");
    expect(JSON.parse((await call(["entry", proposed.id])).stdout)).toMatchObject({
      id: proposed.id,
      revision: 2,
      state: "approved",
    });
    expect(JSON.parse((await call(["history", proposed.id])).stdout).revisions[0].snapshot).toMatchObject({
      revision: 1,
      state: "candidate",
    });
    expect(JSON.parse((await call(["history", proposed.id])).stdout).total).toBe(2);
    expect(JSON.parse((await call(["show", w.id])).stdout).entries[0].text).toBe(approved.text);
    expect(
      JSON.parse((await call(["knowledge", "--query=version", "--states=approved", "--limit=1"])).stdout).total,
    ).toBe(1);
    const pending = (
      await mutate({
        op: "propose",
        actor,
        workstreamId: w.id,
        subject: "pending",
        title: "Pending review",
        text: "Unapproved candidate",
        kind: "finding",
        facet: "orientation",
        applicability: { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } },
        sources: [],
      })
    ).entry as Knowledge;
    for (const flag of ["--review-only", "--reviewOnly"]) {
      const result = await call(["knowledge", flag]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).items.map((item: { entry: Knowledge }) => item.entry.id)).toEqual([pending.id]);
    }
    for (const patch of [
      { text: "Production is version 6, not version 5" },
      { subject: "migration-retry", facet: "Migration" },
    ]) {
      const result = await mutate({
        op: "propose",
        actor,
        workstreamId: w.id,
        subject: approved.subject,
        title: approved.title,
        text: approved.text,
        kind: approved.kind,
        facet: approved.facet,
        applicability: approved.applicability,
        sources: approved.sources,
        expiresAt: approved.expiresAt,
        ...patch,
      });
      expect(result.outcome).toBe("created");
      expect(result.entry?.state).toBe("candidate");
      expect(result.entry?.id).not.toBe(approved.id);
    }
    expect(
      JSON.parse((await call(["read", w.id, "--environment=production", "--host=cluster-a"])).stdout).entries.map(
        (e: Knowledge) => e.id,
      ),
    ).toEqual([approved.id]);
    expect(JSON.parse((await call(["list"])).stdout).total).toBe(1);
    expect((await call(["list", "--limit=0"])).code).toBe(1);
    expect((await call(["mutate", "--input=not-json"])).code).toBe(1);
  }, 20_000);
}

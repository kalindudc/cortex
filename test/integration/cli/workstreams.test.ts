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
  test(`workstream compiled CLI ${daemon ? "daemon" : "offline"}: stable IDs and atomic human acceptance`, async () => {
    const sandbox = mkTmpEnv("workstream-finalize");
    cleanup.push(sandbox.cleanup);
    if (daemon) await startForeground(sandbox.env);
    const schemaResult = await runCli({ args: ["schema", "--json"], env: sandbox.env });
    expect(schemaResult.code).toBe(0);
    const schema = JSON.parse(schemaResult.stdout).workstream;
    expect(schema.mutations.create.optional).toContain("id");
    expect(schema.mutations.propose.optional).toContain("id");
    expect(schema.mutations.accept.required).toEqual(["id", "expectedRevision", "reason", "applicability"]);
    expect(schema.mutations.accept.optional).toContain("supersede");
    expect(schema.mutations.edit.optional).toContain("kind");
    expect(schema.mutations.edit.optional).toContain("applicability");
    expect(schema.mutations["save-approved"].required).toContain("sources");
    expect(schema.stableIds).toContain("opaquely");
    const call = (args: string[], input?: unknown) =>
      runCli({
        args: ["workstream", ...args, "--json"],
        env: sandbox.env,
        stdin: input === undefined ? undefined : JSON.stringify(input),
      });
    const mutate = async (input: unknown): Promise<MutationResult> => {
      const result = await call(["mutate", "--input=-"], input);
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout);
    };
    const workstreamId = `ws_${crypto.randomUUID()}`;
    const creation = { op: "create", id: workstreamId, actor, name: "Retry-safe" };
    expect((await mutate(creation)).workstream?.id).toBe(workstreamId);
    const collision = await call(["mutate", "--input=-"], creation);
    expect(collision.code).toBe(1);
    expect(JSON.parse(collision.stdout).error.code).toBe("conflict");
    expect(collision.stdout).not.toContain("Retry-safe");
    const entryId = `kn_${crypto.randomUUID()}`;
    const stable = { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } };
    const input = {
      op: "propose",
      id: entryId,
      actor: { id: "agent", type: "agent" },
      workstreamId,
      subject: "gateway",
      title: "Draft",
      text: "Draft guidance",
      kind: "finding",
      facet: "orientation",
      applicability: { environment: { mode: "unknown" }, host: { mode: "unknown" } },
      sources: [
        { ref: "message:42", excerpt: "Original quote", authorType: "human", observedAt: "2026-01-01T00:00:00.000Z" },
      ],
    };
    const proposed = (await mutate(input)).entry as Knowledge;
    expect(proposed.id).toBe(entryId);
    const retry = await call(["mutate", "--input=-"], input);
    expect(retry.code).toBe(1);
    expect(JSON.parse(retry.stdout).error.code).toBe("conflict");
    expect(retry.stdout).not.toContain(input.text);
    expect(retry.stdout).not.toContain(input.sources[0]?.excerpt);
    const unused = `kn_${crypto.randomUUID()}`;
    const duplicate = await mutate({ ...input, id: unused });
    expect(duplicate.outcome).toBe("no-save");
    expect(duplicate.entry?.id).toBe(entryId);
    expect((await call(["entry", unused])).code).toBe(1);
    const acceptance = {
      op: "accept",
      actor,
      id: entryId,
      expectedRevision: 1,
      reason: "Reviewed",
      applicability: stable,
      kind: "directive",
      text: "Final human rule",
    };
    for (const patch of [{ applicability: input.applicability }, { actor: input.actor }]) {
      expect((await call(["mutate", "--input=-"], { ...acceptance, ...patch })).code).toBe(1);
    }
    const accepted = (await mutate(acceptance)).entry as Knowledge;
    expect(accepted).toMatchObject({ id: entryId, revision: 2, state: "approved", sources: proposed.sources });
    const stale = await call(["mutate", "--input=-"], acceptance);
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.stdout).error.code).toBe("conflict");
    const replacement = (await mutate({ ...input, id: `kn_${crypto.randomUUID()}`, text: "Correction" }))
      .entry as Knowledge;
    expect((await call(["mutate", "--input=-"], { ...acceptance, id: replacement.id })).code).toBe(1);
    expect(JSON.parse((await call(["entry", replacement.id])).stdout)).toMatchObject({
      state: "candidate",
      revision: 1,
      text: "Correction",
    });
    expect(
      (
        await call(["mutate", "--input=-"], {
          ...acceptance,
          id: replacement.id,
          supersede: { id: entryId, expectedRevision: 1 },
        })
      ).code,
    ).toBe(1);
    expect(JSON.parse((await call(["entry", replacement.id])).stdout)).toMatchObject({
      state: "candidate",
      revision: 1,
    });
    await mutate({ ...acceptance, id: replacement.id, supersede: { id: entryId, expectedRevision: 2 } });
    expect(JSON.parse((await call(["entry", entryId])).stdout)).toMatchObject({ state: "superseded", revision: 3 });
    const manualId = `kn_${crypto.randomUUID()}`;
    const manual = {
      ...input,
      op: "save-approved",
      id: manualId,
      actor,
      reason: "Written and reviewed",
      subject: "manual",
      applicability: stable,
    };
    expect((await mutate(manual)).entry).toMatchObject({ id: manualId, state: "approved", revision: 1 });
    expect((await call(["mutate", "--input=-"], manual)).code).toBe(1);
    expect(JSON.parse((await call(["show", workstreamId])).stdout).total).toBe(3);
    expect(JSON.parse((await call(["history", manualId])).stdout).total).toBe(1);
    const context = JSON.parse((await call(["read", workstreamId])).stdout);
    expect(context.entries.map((e: Knowledge) => e.id).sort()).toEqual([replacement.id, manualId].sort());
    const draft = (await mutate({ ...input, id: `kn_${crypto.randomUUID()}`, subject: "draft-edits" }))
      .entry as Knowledge;
    const edit = {
      op: "edit",
      actor,
      id: draft.id,
      expectedRevision: 1,
      reason: "Save draft",
      kind: "directive",
      applicability: stable,
      text: "Edited draft",
    };
    const saved = (await mutate(edit)).entry as Knowledge;
    expect(saved).toMatchObject({
      id: draft.id,
      revision: 2,
      state: "candidate",
      kind: "directive",
      applicability: stable,
      sources: draft.sources,
      approval: null,
    });
    expect(JSON.parse((await call(["entry", draft.id])).stdout)).toEqual(saved);
    expect(JSON.parse((await call(["history", draft.id])).stdout).revisions.at(-1).snapshot).toEqual(saved);
    const unchosen = (await mutate({ ...edit, expectedRevision: 2, applicability: input.applicability }))
      .entry as Knowledge;
    expect(unchosen.applicability).toEqual(draft.applicability);
    expect(
      (
        await call(["mutate", "--input=-"], {
          ...acceptance,
          id: draft.id,
          expectedRevision: 3,
          applicability: unchosen.applicability,
        })
      ).code,
    ).toBe(1);
    expect((await call(["mutate", "--input=-"], { ...edit, expectedRevision: 3, actor: input.actor })).code).toBe(1);
    const staleEdit = await call(["mutate", "--input=-"], edit);
    expect(JSON.parse(staleEdit.stdout).error.code).toBe("conflict");
    expect((await call(["mutate", "--input=-"], { ...edit, id: manualId })).code).toBe(1);
    expect(JSON.parse((await call(["entry", draft.id])).stdout)).toEqual(unchosen);
    expect(
      JSON.parse((await call(["read", workstreamId])).stdout)
        .entries.map((e: Knowledge) => e.id)
        .sort(),
    ).toEqual([replacement.id, manualId].sort());
  }, 20_000);
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

import { experimental_PluginRpcRefusal, type ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";
import { problemRpcMethods } from "./problem-contract";
import type { Workstreams } from "./workstreams";
import type { createProblems } from "./problem-service";
export function problemHandlers(read: ReturnType<typeof createProblems>, service: Workstreams): ExperimentalPluginRpcHandlersWithContext<typeof problemRpcMethods> {
  return {
    problems: (_input, ctx) => read(ctx.experimental_signal),
    knowledgeSetApplicability: async (input, ctx) => {
      if (ctx.experimental_caller.kind !== "client") throw new experimental_PluginRpcRefusal({ code: "forbidden", message: "Only a human can correct where an approved entry applies." });
      try {
        const actor = service.human();
        const old = await service.cli.knowledge(input.id, ctx.experimental_signal);
        if (old.revision !== input.expectedRevision) throw new Error("Entry revision conflict. Read the current entry before correcting it.");
        if (old.state !== "approved" || !Object.values(old.applicability).some(d => d.mode === "unknown")) throw new Error("This correction requires an approved entry with unknown applicability.");
        if (Object.values(input.applicability).some(d => d.mode === "unknown")) throw new Error("Choose both dimensions explicitly.");
        for (const name of ["environment", "host"] as const) if (old.applicability[name].mode !== "unknown" && JSON.stringify(old.applicability[name]) !== JSON.stringify(input.applicability[name])) throw new Error("Previously known applicability cannot be changed by this correction.");
        const proposed = await service.cli.mutate({ op: "propose", actor, workstreamId: old.workstreamId, subject: old.subject, title: old.title, text: old.text, kind: old.kind, facet: old.facet, sources: old.sources, expiresAt: old.expiresAt, applicability: input.applicability }, ctx.experimental_signal);
        if (proposed.outcome !== "created" || !proposed.entry) throw new Error("A corrected copy already exists. Review that entry; nothing was approved.");
        service.invalidateScope({ workstreamId: old.workstreamId });
        return await service.cli.mutate({ op: "accept", actor, id: proposed.entry.id, expectedRevision: proposed.entry.revision, applicability: input.applicability, reason: "Human corrected unknown applicability", supersede: { id: old.id, expectedRevision: old.revision } }, ctx.experimental_signal).finally(() => service.invalidateScope({ workstreamId: old.workstreamId }));
      } catch (cause) {
        throw new experimental_PluginRpcRefusal({ code: /revision|conflict/i.test(String(cause)) ? "conflict" : "invalid", message: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  };
}

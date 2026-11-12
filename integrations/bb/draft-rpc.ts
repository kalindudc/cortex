import { experimental_PluginRpcRefusal, type ExperimentalPluginRpcHandlerContext, type ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";
import { draftRpcContract } from "./draft-contract";
import type { DraftService } from "./draft-service";

export function draftHandlers(service: DraftService): ExperimentalPluginRpcHandlersWithContext<typeof draftRpcContract> {
  async function call<T>(ctx: ExperimentalPluginRpcHandlerContext, task: () => Promise<T> | T): Promise<T> {
    try {
      if (ctx.experimental_caller.kind !== "client") throw new experimental_PluginRpcRefusal({ code: "forbidden", message: "Use the Cortex UI for an explicit drafting/settings action. Caller kind is provenance, not authentication." });
      return await task();
    } catch (e) {
      if (e instanceof experimental_PluginRpcRefusal) throw e;
      const message = e instanceof Error ? e.message : String(e);
      throw new experimental_PluginRpcRefusal({ code: /revision|conflict|preview.*changed/i.test(message) ? "conflict" : /not found/i.test(message) ? "not_found" : /human|identify/i.test(message) ? "forbidden" : "invalid", message });
    }
  }
  return {
    draftConfigGet: (_input, ctx) => call(ctx, service.configGet),
    draftConfigSet: (input, ctx) => call(ctx, () => service.configSet(input)),
    draftCapabilities: (_input, ctx) => call(ctx, service.capabilities),
    draftSourcePreview: (input, ctx) => call(ctx, () => service.sourcePreview(input, ctx.experimental_signal)),
    draftStart: (input, ctx) => call(ctx, () => service.start(input, ctx.experimental_signal)),
    draftJob: (input, ctx) => call(ctx, () => service.job(input)),
    draftJobs: (input, ctx) => call(ctx, () => service.jobs(input)),
    draftCancel: (input, ctx) => call(ctx, () => service.cancel(input, ctx.experimental_signal)),
    draftResumeSave: (input, ctx) => call(ctx, () => service.resumeSave(input, ctx.experimental_signal)),
  };
}
export function unavailableDraftHandlers(reason: string): ExperimentalPluginRpcHandlersWithContext<typeof draftRpcContract> {
  return Object.fromEntries(Object.keys(draftRpcContract).map(name => [name, () => { throw new experimental_PluginRpcRefusal({ code: "invalid", message: reason }); }])) as unknown as ExperimentalPluginRpcHandlersWithContext<typeof draftRpcContract>;
}

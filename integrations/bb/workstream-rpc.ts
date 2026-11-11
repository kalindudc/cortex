import {
  experimental_PluginRpcRefusal,
  type ExperimentalPluginRpcHandlersWithContext,
  type ExperimentalPluginRpcHandlerContext,
} from "@get-bb/plugin-sdk";
import type { Workstreams } from "./workstreams";
import { workstreamRpcContract, knowledgeIdSchema, contextThreadIdSchema } from "./workstream-contract";

export function workstreamHandlers(
  service: Workstreams,
): ExperimentalPluginRpcHandlersWithContext<typeof workstreamRpcContract> {
  const { cli, store } = service;
  async function call<T>(operation: () => Promise<T> | T): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof experimental_PluginRpcRefusal) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const code = /revision|conflict/i.test(message)
        ? "conflict"
        : /not found|unavailable/i.test(message)
          ? "not_found"
          : /cannot identify|permission|human/i.test(message)
            ? "forbidden"
            : "invalid";
      throw new experimental_PluginRpcRefusal({ code, message });
    }
  }
  function user(ctx: ExperimentalPluginRpcHandlerContext) {
    if (ctx.experimental_caller.kind !== "client")
      throw new experimental_PluginRpcRefusal({
        code: "forbidden",
        message: "Use the Cortex user interface to approve or share context.",
      });
    return service.human();
  }
  async function mutation(op: string, input: object, ctx: ExperimentalPluginRpcHandlerContext) {
    return call(async () => {
      const result = await cli.mutate({ op, ...input, actor: user(ctx) }, ctx.experimental_signal);
      service.invalidate();
      return result;
    });
  }
  return {
    workstreamList: (input, ctx) => call(() => cli.list(input, ctx.experimental_signal)),
    workstreamShow: (input, ctx) => call(() => cli.show(input, ctx.experimental_signal)),
    knowledgeShow: ({ id }, ctx) =>
      call(async () => {
        const entry = await cli.knowledge(id, ctx.experimental_signal);
        const { workstream } = await cli.show({ id: entry.workstreamId, limit: 1, offset: 0 }, ctx.experimental_signal);
        return { entry, workstream };
      }),
    workstreamHistory: (input, ctx) => call(() => cli.history(input, ctx.experimental_signal)),
    knowledgeSearch: (input, ctx) => call(() => cli.knowledgeList(input, ctx.experimental_signal)),
    reviewQueue: (input, ctx) => call(() => cli.knowledgeList({ ...input, reviewOnly: true }, ctx.experimental_signal)),
    workstreamCreate: (input, ctx) => mutation("create", input, ctx),
    workstreamEdit: (input, ctx) => mutation("edit-workstream", input, ctx),
    knowledgePropose: (input, ctx) => mutation("propose", input, ctx),
    knowledgeEdit: (input, ctx) => mutation("edit", input, ctx),
    knowledgeEvidence: (input, ctx) => mutation("evidence", input, ctx),
    knowledgeTransition: (input, ctx) => mutation("transition", input, ctx),
    knowledgeConflict: (input, ctx) => mutation("conflict", input, ctx),
    knowledgeSupersede: (input, ctx) => mutation("supersede", input, ctx),
    sectionBindings: () => call(() => ({ bindings: store.sections() })),
    setSectionBinding: (input, ctx) =>
      call(async () => {
        user(ctx);
        if (input.binding)
          await cli.show({ id: input.binding.workstreamId, limit: 1, offset: 0 }, ctx.experimental_signal);
        const row = store.setSection(input.sectionId, input.expectedRevision, input.binding);
        service.invalidate();
        return row;
      }),
    threadContext: ({ threadId }, ctx) => call(() => service.context(threadId, ctx.experimental_signal)),
    setThreadBinding: (input, ctx) =>
      call(async () => {
        user(ctx);
        await service.context(input.threadId, ctx.experimental_signal);
        if (input.binding)
          await cli.show({ id: input.binding.workstreamId, limit: 1, offset: 0 }, ctx.experimental_signal);
        store.setThreadBinding(input.threadId, input.expectedRevision, input.binding);
        service.invalidate();
        return service.context(input.threadId, ctx.experimental_signal);
      }),
    setThreadOverride: (input, ctx) =>
      call(async () => {
        const actor = user(ctx),
          current = await service.context(input.threadId, ctx.experimental_signal);
        const canonical =
          current.entries.find(e => e.knowledge.id === input.knowledgeId)?.knowledge ??
          (await cli.knowledge(input.knowledgeId, ctx.experimental_signal));
        const grant = current.grants.some(g => g.kind === "knowledge" && g.id === canonical.id && g.revokedAt === null);
        if (canonical.workstreamId !== current.binding?.workstreamId && !grant)
          throw new Error("Saved knowledge is outside this thread's workstream; share it explicitly first.");
        if (canonical.revision !== input.canonicalRevision)
          throw new Error(
            `Canonical revision mismatch: current ${canonical.revision}. Your thread-only input was not applied.`,
          );
        store.setOverride(input.threadId, input.expectedRevision, {
          knowledgeId: input.knowledgeId,
          canonicalRevision: input.canonicalRevision,
          excluded: input.excluded,
          text: input.text,
          actor,
          updatedAt: new Date().toISOString(),
        });
        service.invalidate();
        return service.context(input.threadId, ctx.experimental_signal);
      }),
    setThreadGrant: (input, ctx) =>
      call(async () => {
        const actor = user(ctx);
        await service.context(input.threadId, ctx.experimental_signal);
        if (input.kind === "knowledge") {
          knowledgeIdSchema.parse(input.id);
          await cli.knowledge(input.id, ctx.experimental_signal);
        } else if (!/^[1-9]\d*$/.test(input.id))
          throw new Error("An unscoped task reference must be a positive task number.");
        store.setGrant(input.threadId, input.expectedRevision, input.kind, input.id, input.granted, actor);
        service.invalidate();
        return service.context(input.threadId, ctx.experimental_signal);
      }),
    contextVisibility: ({ threadIds }) =>
      call(() => ({
        threads: threadIds.map(threadId => {
          contextThreadIdSchema.parse(threadId);
          const dismissedPreference = store.thread(threadId).dismissed;
          return { threadId, dismissedPreference, dismissed: dismissedPreference ?? !service.widgetDefault() };
        }),
      })),
    setContextDismissed: (input, ctx) =>
      call(async () => {
        user(ctx);
        store.dismiss(input.threadId, input.dismissed);
        service.invalidate(input.threadId);
        return service.context(input.threadId, ctx.experimental_signal);
      }),
    prepareThreadContext: ({ threadId }, ctx) =>
      call(async () => {
        user(ctx);
        const value = await service.context(threadId, ctx.experimental_signal);
        return {
          threadId,
          text: value.status === "ready" ? value.exactText : "",
          estimatedTokens: value.estimatedTokens,
          status: value.status,
          error: value.error,
        };
      }),
    deliveryReceipts: ({ threadId, limit, offset }) => call(() => store.receipts(threadId, limit, offset)),
  };
}
export function unavailableWorkstreamHandlers(
  reason: string,
): ExperimentalPluginRpcHandlersWithContext<typeof workstreamRpcContract> {
  return Object.fromEntries(
    Object.keys(workstreamRpcContract).map(name => [
      name,
      () => {
        throw new Error(reason);
      },
    ]),
  ) as unknown as ExperimentalPluginRpcHandlersWithContext<typeof workstreamRpcContract>;
}

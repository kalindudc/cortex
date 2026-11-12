import type { BbPluginApi, PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { contextThreadIdSchema, knowledgeIdSchema, proposalInputSchema } from "./workstream-contract";
import type { Workstreams } from "./workstreams";
import { MISSING_CONTEXT } from "./workstreams";
import type { DraftService } from "./draft-service";
import type { PendingContext } from "./pending-context";

import { CONFIGURE_CONTEXT_MAX, WORKSTREAM_INSTRUCTIONS as boundedInstructions } from "./workstream-policy";
export { CONFIGURE_CONTEXT_MAX } from "./workstream-policy";

export const PROPOSAL_RUN_LIMIT = 10;
type ScopeChange = Parameters<
  Extract<
    Parameters<BbPluginApi["sdk"]["subscribe"]>[0],
    {
      event: "thread:changed" | "project:changed" | "environment:changed";
    }
  >["callback"]
>[0];
const proposalParameters = proposalInputSchema
  .omit({ workstreamId: true, kind: true })
  .extend({ sources: proposalInputSchema.shape.sources.element.omit({ authorType: true }).array().max(50) })
  .strict();
const correctionParameters = z
  .object({
    id: knowledgeIdSchema,
    expectedRevision: z.number().int().positive(),
    otherId: knowledgeIdSchema,
    otherExpectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(4096),
  })
  .strict();

export function workstreamConfiguration(
  service: Workstreams,
  ctx: PluginAgentConfigurationContext,
  mode: "write" | "read" | "off",
) {
  const cached = service.prepared(ctx);
  const observed = cached ?? service.peek(ctx.thread.id);
  const metadata = z
    .object({ workstreamId: z.string().optional(), binding: z.unknown().optional() })
    .passthrough()
    .safeParse(ctx.pluginMetadata);
  const untrustedScopeHint =
    !metadata.success || metadata.data.workstreamId !== undefined || metadata.data.binding !== undefined;
  if (!cached && !service.store.hasBindings() && !service.store.tracked(ctx.thread.id) && !untrustedScopeHint)
    return null;
  if (
    observed &&
    !observed.binding &&
    !observed.bindingChanged &&
    !service.store.tracked(ctx.thread.id) &&
    !untrustedScopeHint
  )
    return null;
  if (mode === "off")
    return {
      tools: ["cortex_update"],
      instructions: "Cortex automatic context and recall are off. Existing cortex_update access is unchanged.",
    };
  if (!cached || cached.status !== "ready" || cached.exactText.length > CONFIGURE_CONTEXT_MAX) {
    const error =
      cached?.exactText.length && cached.exactText.length > CONFIGURE_CONTEXT_MAX
        ? "Cortex context exceeds the host's 4,096-character instruction limit; nothing was silently truncated."
        : (cached?.error ?? MISSING_CONTEXT);
    return { tools: ["cortex_update", "cortex_recall"], instructions: error };
  }
  return {
    tools: ["cortex_update", "cortex_recall", "cortex_propose_knowledge", "cortex_report_correction"],
    instructions: `${boundedInstructions}\n\n${cached.exactText}`,
  };
}

export function registerWorkstreamAgents(
  bb: BbPluginApi,
  service: Workstreams,
  drafts?: DraftService,
  pending?: Pick<PendingContext, "admit">,
) {
  const proposalAttempts = new Map<string, number>();
  const resetProposals = ({ thread }: { thread: { id: string } }): void => {
    proposalAttempts.delete(thread.id);
  };
  bb.events.on("thread.idle", resetProposals);
  bb.events.on("thread.deleted", resetProposals);
  bb.experimental_hooks.on("message.dispatch", async ctx => {
    try {
      const worker = drafts?.guard(ctx);
      if (worker) return worker;
      // A New thread card's changes become this thread's overrides before its context is prepared.
      const refused = await pending?.admit(ctx);
      if (refused) return refused;
      const decision = await service.predispatch(ctx);
      const view = service.peek(ctx.thread.id);
      if (view?.binding && view.exactText.length > CONFIGURE_CONTEXT_MAX)
        return {
          action: "reject",
          message:
            "Cortex context exceeds the host instruction limit. Reduce the context or budget before sending; required constraints were not truncated.",
        };
      return decision;
    } catch (error) {
      return {
        action: "reject",
        message: `${MISSING_CONTEXT} ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
  bb.agents.registerTool({
    name: "cortex_propose_knowledge",
    description:
      "Propose a sourced finding in this thread's bound workstream. At most 10 attempts per active run, including failed or no-save attempts. Review existing suggestions at the limit. Candidates require human approval; this tool never grants sharing or approval.",
    parameters: proposalParameters,
    async execute(input, ctx) {
      contextThreadIdSchema.parse(ctx.threadId);
      const attempts = proposalAttempts.get(ctx.threadId) ?? 0;
      if (attempts >= PROPOSAL_RUN_LIMIT)
        throw new Error(
          "The 10-attempt suggestion limit for this active run is reached. Review existing suggestions before saving more; continue the task.",
        );
      proposalAttempts.set(ctx.threadId, attempts + 1);
      const scope = await service.resolveBinding(ctx.threadId);
      if (!scope.binding) throw new Error("No workstream is attached to this thread; ask the human to choose one.");
      const result = await service.cli.mutate(
        {
          op: "propose",
          ...input,
          workstreamId: scope.binding.workstreamId,
          kind: "finding",
          actor: { id: `bb-${ctx.threadId}`, type: "agent" },
          sources: input.sources.map(source => ({ ...source, authorType: "unknown" })),
        },
        ctx.signal,
      );
      if (result.outcome !== "no-save") service.invalidateScope({ workstreamId: scope.binding.workstreamId });
      return JSON.stringify(result);
    },
  });
  bb.agents.registerTool({
    name: "cortex_report_correction",
    description:
      "Report competing factual saved knowledge in the current workstream using both current revisions. This withholds disputed facts pending human review; it cannot approve, resolve or cancel a human prohibition.",
    parameters: correctionParameters,
    async execute(input, ctx) {
      contextThreadIdSchema.parse(ctx.threadId);
      const scope = await service.resolveBinding(ctx.threadId);
      if (!scope.binding) throw new Error("No workstream is attached to this thread.");
      const [entry, other] = await Promise.all([
        service.cli.knowledge(input.id, ctx.signal),
        service.cli.knowledge(input.otherId, ctx.signal),
      ]);
      if (entry.workstreamId !== scope.binding.workstreamId || other.workstreamId !== scope.binding.workstreamId)
        throw new Error("Both correction references must belong to this thread's workstream.");
      const result = await service.cli.mutate(
        { op: "conflict", ...input, actor: { id: `bb-${ctx.threadId}`, type: "agent" } },
        ctx.signal,
      );
      service.invalidateScope({ workstreamId: scope.binding.workstreamId });
      return JSON.stringify(result);
    },
  });
  const warm = async ({ thread }: { thread: { id: string } }): Promise<void> => {
    if (!service.store.hasBindings()) return;
    try {
      await service.context(thread.id);
    } catch (error) {
      bb.log.warn(`Cortex scope resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  bb.events.on("thread.created", warm);
  bb.events.on("experimental_thread.parentChanged", ({ thread }) => service.invalidateThreadTree(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => service.invalidateThreadTree(thread.id));
  for (const event of ["thread.idle", "thread.failed", "thread.archived"] as const)
    bb.events.on(event, ({ thread }) => service.invalidate(thread.id));
  const operationalThreadChanges = new Set([
    "thread-created",
    "status-changed",
    "queue-changed",
    "events-appended",
    "read-state-changed",
    "pin-state-changed",
    "tabs-changed",
    "terminals-changed",
    "storage-changed",
    "interactions-changed",
  ]);
  const operationalEnvironmentChanges = new Set([
    "environment-created",
    "status-changed",
    "work-status-changed",
    "git-refs-changed",
    "git-branches-changed",
    "diff-viewed-changed",
    "thread-storage-changed",
  ]);
  for (const event of ["thread:changed", "project:changed", "environment:changed"] as const) {
    try {
      const unsubscribe = bb.sdk.subscribe({
        event,
        callback: (change: ScopeChange) => {
          if (!service.store.hasBindings()) return;
          if (change.entity === "thread") {
            // BB also reports section moves as title-changed; these must revoke inherited scopes.
            if (change.changes.some(kind => kind !== "environment-changed" && !operationalThreadChanges.has(kind)))
              change.id ? service.invalidateThreadTree(change.id) : service.invalidate();
            else if (change.changes.includes("environment-changed")) service.environmentAttached(change.id);
            else if (["idle", "error", "stopping"].includes(change.metadata?.statusChange?.status ?? ""))
              service.invalidate(change.id);
          } else if (change.entity === "environment") {
            if (change.changes.some(kind => !operationalEnvironmentChanges.has(kind)))
              service.invalidateEnvironment(change.id);
          } else if (
            change.changes.some(
              kind => kind !== "threads-changed" && kind !== "project-order-changed" && kind !== "project-created",
            )
          )
            service.invalidate();
        },
      });
      bb.onDispose(unsubscribe);
    } catch (error) {
      bb.log.warn(
        `Cortex scope invalidation subscription ${event} unavailable: ${error instanceof Error ? error.message : String(error)}. Bound configurations require fresh resolution.`,
      );
    }
  }
  bb.onDispose(() => service.invalidate());
}

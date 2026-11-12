import { randomUUID } from "node:crypto";
import {
  type BbPluginApi,
  type ExperimentalPluginRpcHandlerContext,
  type ExperimentalPluginRpcHandlersWithContext,
  experimental_PluginRpcRefusal,
  type MessageDispatchHookContext,
} from "@get-bb/plugin-sdk";
import type { z } from "zod";
import {
  type NewThreadMemory,
  PENDING_MENTION_PROVIDER,
  PENDING_TTL_MS,
  PENDING_UNKNOWN,
  type PendingSelection,
  pendingContextRpcContract,
  pendingIdSchema,
} from "./pending-context-contract";
import type { Sections } from "./sections";
import { WORKSTREAM_INSTRUCTIONS } from "./workstream-policy";
import type { Workstreams } from "./workstreams";

export { PENDING_UNKNOWN } from "./pending-context-contract";

/** What the pill resolves to at send time: a reference only, never the context text and never a grant. */
export const PENDING_MENTION_CONTEXT =
  "Reference only: before sending, the person changed which saved Cortex knowledge this new thread starts with. Cortex applies those changes itself; this note carries no context and grants nothing.";
const FIRST_ONLY =
  "Cortex changes made on the New thread screen apply only to the first message of a thread you start there. Remove the Cortex pill and send again.";

type Input = z.infer<(typeof pendingContextRpcContract)["newThreadContext"]["input"]>;
type SetInput = z.infer<(typeof pendingContextRpcContract)["pendingContextSet"]["input"]>;
type Decision = { action: "reject"; message: string };
type MemoryPreview = (projectId: string | null, scopedInstructions: string | null) => NewThreadMemory;

/** The pending-selection ids this plugin's pills carry in a message's structured mentions; text is never read. */
export function pendingMentionIds(blocks: MessageDispatchHookContext["input"]["blocks"], pluginId: string): string[] {
  const prefix = `${PENDING_MENTION_PROVIDER}:`;
  const ids: string[] = [];
  for (const block of blocks) {
    if (block.type !== "text") continue;
    for (const mention of block.mentions ?? []) {
      const resource = mention.resource;
      if (resource.kind === "plugin" && resource.pluginId === pluginId && resource.itemId.startsWith(prefix))
        ids.push(resource.itemId.slice(prefix.length));
    }
  }
  return ids;
}

class Refusal extends Error {
  constructor(
    readonly code: "conflict" | "not_found" | "forbidden" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

export function createPendingContext(
  bb: BbPluginApi,
  workstreams: Workstreams,
  sections: Pick<Sections, "eligibility">,
  options: { memory: MemoryPreview },
) {
  const store = workstreams.store.pending;
  bb.ui.registerMentionProvider({
    id: PENDING_MENTION_PROVIDER,
    label: "Cortex",
    // Only the New thread card adds these pills; typing never offers one.
    search: () => [],
    resolve: () => ({ context: PENDING_MENTION_CONTEXT }),
  });

  bb.events.on("thread.deleted", ({ thread }) => store.release(thread.id));

  const overridesOf = (record: PendingSelection) =>
    record.changes.map(change => ({ ...change, actor: record.actor, updatedAt: record.updatedAt }));

  function problem(record: PendingSelection, projectId: string | null, sectionId: string | null): string | null {
    if (record.usedBy !== null)
      return "These Cortex changes were already used by another thread. Remove the Cortex pill; this thread starts with the brief as shared.";
    if (Date.parse(record.expiresAt) <= Date.now())
      return "These Cortex changes expired. Remove the Cortex pill and make them again.";
    if (projectId !== record.projectId)
      return "These Cortex changes were made for another project. Remove the Cortex pill, or switch back to that project.";
    if (sectionId !== record.sectionId)
      return "These Cortex changes were made for another section. Pick that section again, or remove the Cortex pill.";
    if (workstreams.store.section(record.sectionId).revision !== record.bindingRevision)
      return "Sharing in this section changed after you made these changes. Remove the Cortex pill and review the brief again.";
    return null;
  }

  async function preview(input: Input, signal?: AbortSignal) {
    const sectionPreviews = await Promise.all(workstreams.store.sections().filter(row => row.binding !== null).map(async row => ({
      sectionId: row.key, data: await sections.eligibility(row.key, signal),
    })));
    const sectionSummaries = sectionPreviews.map(({ sectionId, data }) => ({
      sectionId, entries: data.entries.length, estimatedTokens: data.estimatedTokens, budgetTokens: data.budgetTokens,
    }));
    const record = input.pendingId ? store.get(input.pendingId) : null;
    const pendingProblem =
      input.pendingId === null ? null : record === null ? PENDING_UNKNOWN : problem(record, input.projectId, input.sectionId);
    if (input.sectionId === null)
      return {
        section: null,
        sectionSummaries,
        base: null,
        applied: null,
        pending: record,
        pendingProblem,
        memory: options.memory(input.projectId, null),
      };
    const row = workstreams.store.section(input.sectionId);
    const usable = record !== null && pendingProblem === null;
    const [base, applied, shown] = await Promise.all([
      sectionPreviews.find(row => row.sectionId === input.sectionId)?.data ?? sections.eligibility(input.sectionId, signal),
      usable ? sections.eligibility(input.sectionId, signal, overridesOf(record)) : Promise.resolve(null),
      row.binding
        ? workstreams.cli.show({ id: row.binding.workstreamId, limit: 1, offset: 0 }, signal)
        : Promise.resolve(null),
    ]);
    const effective = applied ?? base;
    const scoped =
      row.binding && effective.status === "ready" ? `${WORKSTREAM_INSTRUCTIONS}\n\n${effective.exactText}` : null;
    return {
      section: {
        id: input.sectionId,
        bindingRevision: row.revision,
        requiredKnowledgeIds: row.binding?.requiredKnowledgeIds ?? [],
        binding:
          row.binding && shown
            ? { workstreamId: row.binding.workstreamId, workstreamName: shown.workstream.name, topic: row.binding.topic }
            : null,
      },
      sectionSummaries,
      base,
      applied,
      pending: record,
      pendingProblem,
      memory: options.memory(input.projectId, scoped),
    };
  }

  async function set(input: SetInput, ctx: ExperimentalPluginRpcHandlerContext) {
    if (ctx.experimental_caller.kind !== "client")
      throw new Refusal("forbidden", "Use the Cortex card on the New thread screen to change a new thread's brief.");
    const actor = workstreams.human();
    const existing = input.pendingId ? store.get(input.pendingId) : null;
    if (input.pendingId && !existing) throw new Refusal("not_found", PENDING_UNKNOWN);
    if (existing) {
      if (existing.usedBy !== null)
        throw new Refusal("conflict", "These Cortex changes were already used by a thread; start again from a new draft.");
      if (existing.draftKey !== input.draftKey || existing.projectId !== input.projectId)
        throw new Refusal("forbidden", "These Cortex changes belong to another draft; they cannot be changed here.");
    }
    if (input.changes.length === 0) {
      if (existing) store.remove(existing.id);
      return { pending: null };
    }
    const row = workstreams.store.section(input.sectionId);
    if (!row.binding)
      throw new Refusal("invalid", "Nothing is shared in this section; share context there before changing its brief.");
    if (row.revision !== input.expectedBindingRevision)
      throw new Refusal(
        "conflict",
        `Sharing in this section changed (revision ${row.revision}). Review the brief again; your change was not saved.`,
      );
    const ids = input.changes.map(change => change.knowledgeId);
    if (new Set(ids).size !== ids.length) throw new Refusal("invalid", "Each entry can have only one change.");
    const base = await sections.eligibility(input.sectionId, ctx.experimental_signal);
    for (const change of input.changes) {
      const entry = base.entries.find(e => e.knowledge.id === change.knowledgeId);
      if (!entry)
        throw new Refusal("invalid", `${change.knowledgeId} is not in the brief new threads in this section start with.`);
      if (entry.knowledge.revision !== change.canonicalRevision)
        throw new Refusal(
          "conflict",
          `"${entry.knowledge.title}" changed since you read it (revision ${entry.knowledge.revision}). Review it again; your change was not saved.`,
        );
    }
    const now = Date.now();
    store.prune(now);
    const at = new Date(now).toISOString();
    const record = store.put({
      id: existing?.id ?? randomUUID(),
      projectId: input.projectId,
      sectionId: input.sectionId,
      workstreamId: row.binding.workstreamId,
      bindingRevision: row.revision,
      draftKey: input.draftKey,
      actor,
      caller: "client",
      singleUse: true,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      expiresAt: new Date(now + PENDING_TTL_MS).toISOString(),
      changes: input.changes,
      usedBy: null,
      usedAt: null,
      refusedPlacement: null,
    });
    return { pending: record };
  }

  /**
   * Applies a pending selection that the message's own Cortex pill names, as the thread's overrides, before its
   * context is prepared. Null leaves the dispatch as it is today; a message without the pill always gets null.
   */
  async function admit(ctx: MessageDispatchHookContext): Promise<Decision | null> {
    const ids = pendingMentionIds(ctx.input.blocks, bb.pluginId);
    if (ids.length === 0) return null;
    const reject = (message: string): Decision => ({ action: "reject", message });
    if (new Set(ids).size > 1) return reject("This message has more than one Cortex pill. Keep one and send again.");
    const id = ids[0]!;
    const record = pendingIdSchema.safeParse(id).success ? store.get(id) : null;
    if (!record) return reject(PENDING_UNKNOWN);
    // A retry or queued re-attempt of the dispatch that already applied these changes.
    if (record.usedBy === ctx.thread.id) return null;
    if (record.usedBy !== null)
      return reject(
        "These Cortex changes were already used by another thread. Remove the Cortex pill and send again; this thread then starts with the brief as shared.",
      );
    const first =
      ctx.attempt === "start-turn" &&
      ctx.thread.status === "pending" &&
      ctx.origin === "app" &&
      ctx.initiator === "user" &&
      ctx.senderThreadId === null;
    if (!first) return reject(FIRST_ONLY);
    if (Date.parse(record.expiresAt) <= Date.now())
      return reject("These Cortex changes expired. Remove the Cortex pill, make the changes again and send.");
    if (ctx.project.id !== record.projectId)
      return reject("These Cortex changes were made for another project. Remove the Cortex pill and send again.");
    if (ctx.thread.sectionId !== record.sectionId) {
      store.put({ ...record, refusedPlacement: { sectionId: ctx.thread.sectionId, at: new Date().toISOString() } });
      bb.realtime.publish("sections", { sectionId: record.sectionId });
      return reject(
        "bb is filing this thread in a different section from the one these Cortex changes were made for. Remove the Cortex pill to start with that section's brief, or pick the section again on the New thread screen.",
      );
    }
    if (record.refusedPlacement) store.put({ ...record, refusedPlacement: null });
    const scope = await workstreams.resolveBinding(ctx.thread.id);
    const changed =
      "Sharing in this section changed after you made these Cortex changes. Remove the Cortex pill, review the brief on the New thread screen and send again.";
    if (
      scope.bindingSource !== "section" ||
      scope.binding?.workstreamId !== record.workstreamId ||
      scope.bindingRevision !== record.bindingRevision
    )
      return reject(changed);
    const base = await sections.eligibility(record.sectionId);
    const stale = record.changes.find(
      change =>
        !base.entries.some(e => e.knowledge.id === change.knowledgeId && e.knowledge.revision === change.canonicalRevision),
    );
    if (stale)
      return reject(
        "Saved knowledge you changed for this thread was edited or withdrawn since. Remove the Cortex pill, review the brief on the New thread screen and send again.",
      );
    try {
      store.apply(id, ctx.thread.id, current => {
        if (workstreams.store.section(current.sectionId).revision !== current.bindingRevision) throw new Error(changed);
      });
    } catch (error) {
      return reject(error instanceof Error ? error.message : String(error));
    }
    workstreams.invalidate(ctx.thread.id);
    return null;
  }

  return { preview, set, admit };
}
export type PendingContext = ReturnType<typeof createPendingContext>;

export function pendingHandlers(
  service: PendingContext,
): ExperimentalPluginRpcHandlersWithContext<typeof pendingContextRpcContract> {
  async function call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof experimental_PluginRpcRefusal) throw error;
      if (error instanceof Refusal) throw new experimental_PluginRpcRefusal({ code: error.code, message: error.message });
      const message = error instanceof Error ? error.message : String(error);
      throw new experimental_PluginRpcRefusal({
        code: /cannot identify/i.test(message) ? "forbidden" : /not found/i.test(message) ? "not_found" : "invalid",
        message,
      });
    }
  }
  return {
    newThreadContext: (input, ctx) => call(() => service.preview(input, ctx.experimental_signal)),
    pendingContextSet: (input, ctx) => call(() => service.set(input, ctx)),
  };
}

export function unavailablePendingHandlers(
  reason: string,
): ExperimentalPluginRpcHandlersWithContext<typeof pendingContextRpcContract> {
  const fail = (): never => {
    throw new Error(reason);
  };
  return { newThreadContext: fail, pendingContextSet: fail };
}

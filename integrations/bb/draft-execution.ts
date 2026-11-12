import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { draftExecutionSchema, draftSelectionSchema, type DraftConfig, type DraftExecution, type DraftSelection } from "./draft-contract";
import type { DraftStore } from "./draft-store";

export function createDraftExecutionResolver(bb: BbPluginApi, store: DraftStore) {
  async function resolve(sourceThreadId: string, signal?: AbortSignal, pinnedConfig?: DraftConfig, pinnedRoute?: { hostId: string; personalProjectId: string }, override?: DraftSelection): Promise<{ execution: DraftExecution; personalProjectId: string }> {
    const config = pinnedConfig ?? store.configGet();
    const hostId = pinnedRoute?.hostId ?? (await bb.sdk.system.config({ signal })).primaryHostId;
    if (!hostId) throw new Error("No primary host is available for drafting. Choose a primary host before previewing.");
    let personalProjectId = pinnedRoute?.personalProjectId;
    if (!personalProjectId) {
      const bootstrap = await bb.sdk.projects.sidebarBootstrap({ signal });
      if (bootstrap.personalProject.kind !== "personal") throw new Error("The public personal workspace route is unavailable.");
      personalProjectId = bootstrap.personalProject.id;
    }
    let chosen = override ?? config.selection;
    if (chosen === null) {
      const thread = await bb.sdk.threads.get({ threadId: sourceThreadId, signal });
      const options = await bb.sdk.threads.defaultExecutionOptions({ threadId: sourceThreadId, signal });
      if (!options || !thread.providerId || !options.model) throw new Error("The source thread has no concrete requested model. Choose the drafting model in Settings.");
      chosen = draftSelectionSchema.parse({ providerId: thread.providerId, model: options.model, reasoningLevel: options.reasoningLevel, serviceTier: options.serviceTier });
    }
    const requested = chosen;
    const catalog = await bb.sdk.providers.models({ hostId, projectId: personalProjectId, providerId: requested.providerId, signal });
    const provider = catalog.providers.find(p => p.id === requested.providerId);
    // The catalog is already this provider's; routeProviderId names an upstream route such as "openai", not the provider.
    // A workspace-scoped catalog read without a checkout is the one a fresh personal workspace sees.
    const model = [...catalog.models, ...(catalog.selectedOnlyModels ?? [])].find(m => m.model === requested.model);
    const where = override ? "Choose another model for this draft" : "Choose another model in Drafting settings";
    if (!provider?.available) throw new Error(`${requested.providerId} is not available on the primary host. ${where}; no fallback was used.`);
    if (!model) throw new Error(`${requested.model} is not offered by ${requested.providerId} on the primary host. ${where}; no fallback was used.`);
    const modes = provider.capabilities.permissionModes;
    if (!modes.includes("accept-edits") && !modes.includes("full")) throw new Error(`${requested.providerId} offers neither accept-edits nor full access for drafting. ${where}; no fallback was used.`);
    if (!model.supportedReasoningEfforts.some(level => level.reasoningEffort === requested.reasoningLevel) && !(requested.reasoningLevel === "" && model.supportedReasoningEfforts.length === 0)) throw new Error("The requested reasoning level is unavailable for this model. Refresh the native picker; no default was substituted.");
    const tiers = model.supportedServiceTiers ?? [];
    // bb's picker leaves the tier out until one is picked, which means bb's standard tier. Pin it so the worker
    // cannot inherit a project tier such as Fast.
    // A provider without tiers runs on bb's standard tier whatever was inherited, as bb does for its own threads.
    const { serviceTier: _tier, ...untiered } = requested;
    const selection: DraftSelection = !provider.capabilities.supportsServiceTier ? untiered : requested.serviceTier === undefined ? { ...requested, serviceTier: "default" } : requested;
    if (selection.serviceTier !== undefined && selection.serviceTier !== "default" && !tiers.some(t => t.id === selection.serviceTier)) throw new Error("The requested service tier is unavailable for this model. Refresh the native picker; no tier was substituted.");
    if (pinnedConfig === undefined && store.configGet().revision !== config.revision) throw new Error("Draft config changed during preview resolution. Refresh preview before Start.");
    return { personalProjectId, execution: draftExecutionSchema.parse({ ...selection, hostId, configRevision: config.revision, origin: override ? "override" : config.selection === null ? "source-thread" : "configured", ...(modes.includes("accept-edits") ? {} : { permissionMode: "full" as const }) }) };
  }
  function compare(actual: DraftExecution, expected: DraftExecution) {
    if (JSON.stringify(draftExecutionSchema.parse(actual)) !== JSON.stringify(draftExecutionSchema.parse(expected))) throw new Error("Draft preview execution changed (provider, model, reasoning, tier, host or config). Refresh preview before Start; no different execution was substituted.");
  }
  return { resolve, compare };
}

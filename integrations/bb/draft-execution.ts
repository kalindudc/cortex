import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { draftExecutionSchema, draftSelectionSchema, type DraftConfig, type DraftExecution } from "./draft-contract";
import type { DraftStore } from "./draft-store";

export function createDraftExecutionResolver(bb: BbPluginApi, store: DraftStore) {
  async function resolve(sourceThreadId: string, signal?: AbortSignal, pinnedConfig?: DraftConfig, pinnedRoute?: { hostId: string; personalProjectId: string }): Promise<{ execution: DraftExecution; personalProjectId: string }> {
    const config = pinnedConfig ?? store.configGet();
    const hostId = pinnedRoute?.hostId ?? (await bb.sdk.system.config({ signal })).primaryHostId;
    if (!hostId) throw new Error("No primary host is available for drafting. Choose a primary host before previewing.");
    let personalProjectId = pinnedRoute?.personalProjectId;
    if (!personalProjectId) {
      const bootstrap = await bb.sdk.projects.sidebarBootstrap({ signal });
      if (bootstrap.personalProject.kind !== "personal") throw new Error("The public personal workspace route is unavailable.");
      personalProjectId = bootstrap.personalProject.id;
    }
    let selection = config.selection;
    if (selection === null) {
      const thread = await bb.sdk.threads.get({ threadId: sourceThreadId, signal });
      const options = await bb.sdk.threads.defaultExecutionOptions({ threadId: sourceThreadId, signal });
      if (!options || !thread.providerId || !options.model) throw new Error("The source thread has no concrete requested model. Choose the drafting model in Settings.");
      selection = draftSelectionSchema.parse({ providerId: thread.providerId, model: options.model, reasoningLevel: options.reasoningLevel, serviceTier: options.serviceTier });
    }
    const catalog = await bb.sdk.providers.models({ hostId, projectId: personalProjectId, providerId: selection.providerId, signal });
    const provider = catalog.providers.find(p => p.id === selection.providerId);
    const model = catalog.models.find(m => m.model === selection.model && (m.routeProviderId === undefined || m.routeProviderId === selection.providerId));
    if (!provider?.available || !model) throw new Error("The requested drafting provider/model is unavailable on the selected primary host. Choose a model in Settings; no fallback was used.");
    if (provider.capabilities.modelCatalogScope !== "host") throw new Error("This model requires a workspace-scoped catalog that the personal-worker setup cannot verify before creation. Choose a host-catalog provider.");
    if (!provider.capabilities.permissionModes.includes("accept-edits")) throw new Error("The requested provider cannot use the approved accept-edits drafting permission mode.");
    if (!model.supportedReasoningEfforts.some(level => level.reasoningEffort === selection.reasoningLevel) && !(selection.reasoningLevel === "" && model.supportedReasoningEfforts.length === 0)) throw new Error("The requested reasoning level is unavailable for this model. Refresh the native picker; no default was substituted.");
    const tiers = model.supportedServiceTiers ?? [];
    if (provider.capabilities.supportsServiceTier && selection.serviceTier === undefined) throw new Error("Choose a concrete service tier for this drafting model.");
    if (selection.serviceTier !== undefined && selection.serviceTier !== "default" && !tiers.some(t => t.id === selection.serviceTier)) throw new Error("The requested service tier is unavailable for this model. Refresh the native picker; no tier was substituted.");
    if (pinnedConfig === undefined && store.configGet().revision !== config.revision) throw new Error("Draft config changed during preview resolution. Refresh preview before Start.");
    return { personalProjectId, execution: draftExecutionSchema.parse({ ...selection, hostId, configRevision: config.revision, origin: config.selection === null ? "source-thread" : "configured" }) };
  }
  function compare(actual: DraftExecution, expected: DraftExecution) {
    if (JSON.stringify(draftExecutionSchema.parse(actual)) !== JSON.stringify(draftExecutionSchema.parse(expected))) throw new Error("Draft preview execution changed (provider, model, reasoning, tier, host or config). Refresh preview before Start; no different execution was substituted.");
  }
  return { resolve, compare };
}

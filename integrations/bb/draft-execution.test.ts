import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, test } from "vitest";
import { createDraftStore, DRAFT_MIGRATIONS } from "./draft-store";
import { createDraftExecutionResolver } from "./draft-execution";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function setup() {
  const thread = makeThreadResponse({ id: "thr_aaaaaaaa", providerId: "provider-a" });
  const state = { host: "host_one", providerId: "provider-a", model: "model-a", reasoningLevel: "high", serviceTier: "priority", available: true, scope: "host", permissions: ["accept-edits"], personalKind: "personal" };
  const host = createFakePluginHost({ pluginId: "cortex", sdk: {
    system: { config: async () => ({ primaryHostId: state.host }) as any },
    projects: { sidebarBootstrap: async () => ({ personalProject: { id: "project_personal", kind: state.personalKind } }) as any },
    threads: { get: async () => ({ ...thread, providerId: state.providerId }), defaultExecutionOptions: async () => ({ model: state.model, reasoningLevel: state.reasoningLevel, serviceTier: state.serviceTier, permissionMode: "full", source: "client/thread/start" }) as any },
    providers: { models: async () => ({ providers: [{ id: state.providerId, available: state.available, capabilities: { modelCatalogScope: state.scope, permissionModes: state.permissions, supportsServiceTier: true } }], models: [{ model: state.model, routeProviderId: state.providerId, supportedReasoningEfforts: [{ reasoningEffort: state.reasoningLevel }], supportedServiceTiers: [{ id: state.serviceTier }] }] }) as any },
  } });
  disposers.push(() => host.harness.lifecycle.dispose());
  const db = host.bb.storage.database(); host.bb.storage.migrate(db, DRAFT_MIGRATIONS);
  const store = createDraftStore(db); const resolver = createDraftExecutionResolver(host.bb, store);
  return { ...host, state, store, resolver };
}
test("follow source uses concrete public facts and the same explicit primary personal host/catalog", async () => {
  const s = setup(); const result = await s.resolver.resolve("thr_aaaaaaaa");
  expect(result).toEqual({ personalProjectId: "project_personal", execution: { providerId: "provider-a", model: "model-a", reasoningLevel: "high", serviceTier: "priority", hostId: "host_one", configRevision: 0, origin: "source-thread" } });
  expect(s.harness.inspection.sdk.callsTo("providers.models")[0]?.[0]).toMatchObject({ hostId: "host_one", projectId: "project_personal", providerId: "provider-a" });
  expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});
test.each(["model", "reasoningLevel", "serviceTier", "providerId", "host"] as const)("fresh execution detects %s change without a config revision change", async field => {
  const s = setup(); const preview = await s.resolver.resolve("thr_aaaaaaaa");
  s.state[field] = "changed";
  const current = await s.resolver.resolve("thr_aaaaaaaa");
  expect(() => s.resolver.compare(current.execution, preview.execution)).toThrow(/preview execution changed/);
  expect(current.execution.configRevision).toBe(preview.execution.configRevision);
});
test("unchanged preview execution compares exactly and configured selection does not follow changed source defaults", async () => {
  const s = setup(); const preview = await s.resolver.resolve("thr_aaaaaaaa");
  expect(() => s.resolver.compare(preview.execution, preview.execution)).not.toThrow();
  s.store.configSet(0, { providerId: "provider-a", model: "model-a", reasoningLevel: "high", serviceTier: "priority" }, { id: "you", type: "human" });
  const configured = await s.resolver.resolve("thr_aaaaaaaa");
  expect(configured.execution).toMatchObject({ configRevision: 1, origin: "configured", model: "model-a" });
  expect(s.harness.inspection.sdk.callsTo("threads.defaultExecutionOptions")).toHaveLength(1);
});
test.each(["unavailable", "host", "personal", "scope", "permission"])("unresolved or unsupported route refuses without model fallback/native creation: %s", async failure => {
  const s = setup();
  if (failure === "unavailable") s.state.available = false;
  if (failure === "host") s.state.host = "";
  if (failure === "personal") s.state.personalKind = "repository";
  if (failure === "scope") s.state.scope = "workspace";
  if (failure === "permission") s.state.permissions = ["full"];
  await expect(s.resolver.resolve("thr_aaaaaaaa")).rejects.toThrow();
  expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});
test("config changes during catalog resolution refuse a stale preview instead of presenting an unpinned choice", async () => {
  const s = setup();
  s.harness.sdk.stub("providers.models", async () => {
    s.store.configSet(0, { providerId: "provider-a", model: "model-a", reasoningLevel: "high", serviceTier: "priority" }, { id: "you", type: "human" });
    return { providers: [{ id: "provider-a", available: true, capabilities: { modelCatalogScope: "host", permissionModes: ["accept-edits"], supportsServiceTier: true } }], models: [{ model: "model-a", routeProviderId: "provider-a", supportedReasoningEfforts: [{ reasoningEffort: "high" }], supportedServiceTiers: [{ id: "priority" }] }] } as any;
  });
  await expect(s.resolver.resolve("thr_aaaaaaaa")).rejects.toThrow(/config.*changed/i);
});

test.each([
  { tier: "default", configured: false, allowed: true },
  { tier: "default", configured: true, allowed: true },
  { tier: "fast", configured: true, allowed: true },
  { tier: "ultrafast", configured: true, allowed: false },
])("native optional-tier catalog preserves $tier with configured=$configured without fallback", async ({ tier, configured, allowed }) => {
  const s = setup(); s.state.serviceTier = tier;
  s.harness.sdk.stub("providers.models", async () => ({ providers: [{ id: "provider-a", available: true, capabilities: { modelCatalogScope: "host", permissionModes: ["accept-edits"], supportsServiceTier: true } }], models: [{ model: "model-a", routeProviderId: "provider-a", supportedReasoningEfforts: [{ reasoningEffort: "high" }], supportedServiceTiers: [{ id: "fast" }] }] }) as any);
  if (configured) s.store.configSet(0, { providerId: "provider-a", model: "model-a", reasoningLevel: "high", serviceTier: tier }, { id: "you", type: "human" });
  if (allowed) expect((await s.resolver.resolve("thr_aaaaaaaa")).execution.serviceTier).toBe(tier);
  else await expect(s.resolver.resolve("thr_aaaaaaaa")).rejects.toThrow(/service tier is unavailable/);
  expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

test.each([
  { supportsServiceTier: true, expected: "default" },
  { supportsServiceTier: false, expected: undefined },
])("a picker choice saved without a tier pins bb's standard tier only when the provider has tiers ($supportsServiceTier)", async ({ supportsServiceTier, expected }) => {
  // The saved Codex choice and catalog shape from a real install: the picker omits the tier until one is picked.
  const s = setup();
  s.harness.sdk.stub("providers.models", async () => ({ providers: [{ id: "codex", available: true, capabilities: { modelCatalogScope: "host", permissionModes: ["accept-edits"], supportsServiceTier } }], models: [{ model: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }], supportedServiceTiers: [{ id: "fast", label: "Fast" }] }] }) as any);
  s.store.configSet(0, { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh" }, { id: "you", type: "human" });
  const { execution } = await s.resolver.resolve("thr_aaaaaaaa");
  expect(execution.serviceTier).toBe(expected);
  expect(execution).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh", origin: "configured" });
  s.store.configSet(1, { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh", serviceTier: "fast" }, { id: "you", type: "human" });
  expect((await s.resolver.resolve("thr_aaaaaaaa")).execution.serviceTier).toBe("fast");
});

test("missing source concrete defaults asks for Settings choice instead of a list-first model", async () => {
  const s = setup(); s.harness.sdk.stub("threads.defaultExecutionOptions", async () => null);
  await expect(s.resolver.resolve("thr_aaaaaaaa")).rejects.toThrow(/Choose the drafting model/);
  expect(s.harness.inspection.sdk.callsTo("providers.models")).toHaveLength(0);
});

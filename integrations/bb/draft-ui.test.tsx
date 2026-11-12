// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { PluginProvidersState, PluginSidebarThread, ExperimentalServers } from "@get-bb/plugin-sdk/app";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { draftRpcContract, type DraftConfig, type DraftJob, type DraftPreview } from "./draft-contract";
import { sectionRpcContract, type Section } from "./section-contract";
import { workstreamRpcContract } from "./workstream-contract";
import { draftRecoveryScope, pendingDraft, savePendingDraft } from "./ui/draft-intent";
import { DraftJobs, DraftJobView } from "./ui/drafting";
import { failureOf, useDraftJob, useDraftWrites } from "./ui/data";

const contract = { ...draftRpcContract, sectionList: sectionRpcContract.sectionList, sectionDetail: sectionRpcContract.sectionDetail, sectionCaptureJobs: sectionRpcContract.sectionCaptureJobs, workstreamList: workstreamRpcContract.workstreamList };
const actor = { id: "kal", type: "human" } as const;
const now = new Date().toISOString();
const threadId = "thr_aaaaaaaa";
const requestId = "8fafd34a-df8f-4784-9113-723075bf026c";
const ws = { id: "ws_envoy", name: "Envoy cluster-service", description: "", revision: 7, archived: false, actor, createdAt: now, updatedAt: now };
const section: Section = { id: "sec_envoy", name: ws.name, canonicalName: ws.name, threadCount: 1, marker: { status: "unmarked", originalTitle: null, decoratedTitle: null, error: null }, connectionJob: null, binding: { key: "sec_envoy", revision: 1, binding: { workstreamId: ws.id, topic: null, budgetTokens: 400, requiredKnowledgeIds: [] } } };
const provider: PluginProvidersState["providers"][number] = { id: "sample-agent", pluginId: "sample-agent", displayName: "Sample agent", available: true, logoUrl: null, capabilities: { modelCatalogScope: "host", permissionModes: ["accept-edits"], supportsFork: false, supportsNativeUserQuestion: false, supportsServiceTier: true, supportsSessionRewind: false, supportsThreadArchive: true, supportsThreadRename: true }, completedTurnDisplay: "flat", composerActions: [], maintenance: { health: false, installation: false, usage: false } };
const selection = { providerId: provider.id, model: "sample-extraction-model", reasoningLevel: "high", serviceTier: "fast" };
const preview: DraftPreview = { snapshotId: "4b9b669e-4a38-4c87-b8f5-43b9bdb409fd", sectionId: section.id, sourceThreadId: threadId, bindingRevision: 1, workstreamId: ws.id, workstreamRevision: 7, capturedAt: now, expiresAt: new Date(Date.now() + 600_000).toISOString(), historySnapshot: "timeline-snapshot", label: "Recent completed-message excerpts, not the whole thread", omittedMessages: 5, messages: [{ messageId: "msg_staging", messageSeq: 31, threadId, turnId: "turn_staging", completedAt: now, sourceSeqStart: 30, sourceSeqEnd: 32, role: "assistant", authorType: "agent", observedAt: now, ref: `@thread:${threadId}#msg=31`, start: 0, end: "Staging uses the new bootstrap path.".length, totalChars: 12000, quote: "Staging uses the new bootstrap path.", messageHash: "a".repeat(64), quoteHash: "b".repeat(64) }], execution: { ...selection, hostId: "host_primary", configRevision: 0, origin: "source-thread" } };
const job = (overrides: Partial<DraftJob> = {}): DraftJob => ({ requestId, revision: 1, sectionId: section.id, sourceThreadId: threadId, sourceSnapshotId: preview.snapshotId, bindingRevision: 1, workstreamId: ws.id, workstreamRevision: 7, requestedAt: now, updatedAt: now, deadlineAt: new Date(Date.parse(now) + 300_000).toISOString(), status: "running", execution: preview.execution, worker: { threadId: "thr_workerxx", state: "known" }, cancellation: { state: "none", requestedAt: null, confirmedAt: null }, candidateResults: [0, 1, 2].map(index => ({ intendedId: `kn_suggestion${index}`, canonicalId: null, status: "pending", error: null })), progress: null, error: null, retry: "none", ...overrides });
let app: Awaited<ReturnType<typeof loadPluginApp>>;
beforeAll(async () => { app = await loadPluginApp(() => import("./app")); });
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const servers = (id = "server_primary", origin = "https://bb.example"): ExperimentalServers => ({ status: "ready", servers: [{ id, origin, name: "Private fake server", active: true, kind: "custom" }], switchTo: () => {} });

function sidebarThread(id: string, sectionId: string, displayTitle: string): PluginSidebarThread {
  return { id, sectionId, displayTitle, projectId: "proj_sample", title: displayTitle, titleFallback: null, parentThreadId: null, lifecycleOwnerThreadId: null, parentNotifications: "auto", sourceThreadId: null, originKind: null, originPluginId: null, providerId: provider.id, status: "idle", runtimeStatus: "idle", queuedWork: "none", hasPendingInteraction: false, activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 }, indicator: "none", indicatorLabel: null, isUnread: false, isPinned: false, pinnedAt: null, pinSortKey: null, isArchived: false, archivedAt: null, href: `/projects/proj_sample/threads/${id}`, isHidden: false, environment: null, host: null, createdAt: 0, updatedAt: 0, lastReadAt: null, latestAttentionAt: 0 };
}
function fixture() {
  let config: DraftConfig = { revision: 0, selection: null, updatedAt: null, updatedBy: null };
  let currentSection = structuredClone(section);
  let source = structuredClone(preview);
  let jobs: DraftJob[] = [];
  const rpc = {
    sectionList: () => ({ sections: [currentSection] }),
    sectionDetail: () => ({ section: currentSection, threads: [{ id: threadId, name: "Investigate the staging bootstrap" }], eligibility: { computedAt: now, status: "ready", error: null, entries: [], notices: [], exclusions: [], exactText: "", estimatedTokens: 0, budgetTokens: 400 }, review: { items: [], total: 0, limit: 50, offset: 0 } }),
    sectionCaptureJobs: ({ limit = 20, offset = 0 }) => ({ jobs: [], total: 0, limit, offset }),
    workstreamList: () => ({ workstreams: [ws], total: 1, limit: 100, offset: 0 }),
    draftConfigGet: () => config,
    draftConfigSet: input => { if (input.expectedRevision !== config.revision) throw { code: "conflict", message: "Drafting settings changed elsewhere" }; config = { revision: config.revision + 1, selection: input.selection, updatedAt: now, updatedBy: actor }; return config; },
    draftCapabilities: () => ({ available: true, reason: null, maxActivePerSection: 1, maxActiveGlobal: 3, maxFindings: 3, maxMessages: 12, maxSourceChars: 16384, maxQuoteChars: 8192, maxOutputBytes: 32768 }),
    draftSourcePreview: () => source,
    draftStart: input => { const out = job({ requestId: input.requestId, execution: source.execution }); jobs = [out]; return out; },
    draftJob: input => { const found = jobs.find(row => row.requestId === input.requestId); if (!found) throw { code: "not_found", message: "Drafting request not found; its outcome is not confirmed" }; return found; },
    draftJobs: ({ limit = 20, offset = 0 }) => ({ jobs: jobs.slice(offset, offset + limit), total: jobs.length, limit, offset }),
    draftCancel: input => { const old = jobs.find(row => row.requestId === input.requestId)!; const out = { ...old, revision: old.revision + 1, status: "cancel-requested" as const, cancellation: { state: "requested" as const, requestedAt: now, confirmedAt: null } }; jobs = [out]; return out; },
    draftResumeSave: input => { const old = jobs.find(row => row.requestId === input.requestId)!; const out = { ...old, revision: old.revision + 1, status: "completed" as const, retry: "none" as const }; jobs = [out]; return out; },
  } satisfies PluginRpcTestHandlers<typeof contract>;
  return { rpc, options: { pluginId: "cortex", servers: servers() as ExperimentalServers | null, rpc: rpc as PluginRpcTestHandlers<typeof contract>, experimental_rpcContract: contract, providers: { status: "ready" as PluginProvidersState["status"], providers: [provider] }, sidebarThreads: { sections: [{ id: section.id, name: section.name, createdAt: 0, updatedAt: 0 }], threads: [sidebarThread(threadId, section.id, "Investigate the staging bootstrap"), sidebarThread("thr_foreignx", "sec_other", "Foreign conversation")] } }, config: (next: DraftConfig) => { config = next; }, source: (next: DraftPreview) => { source = next; }, jobs: (next: DraftJob[]) => { jobs = next; }, section: (next: Section) => { currentSection = next; } };
}
function settings(backend = fixture()) {
  const registration = app.settingsSections.find(row => row.id === "drafting");
  expect(registration).toBeDefined();
  return { backend, slot: renderSlot(registration!, {}, backend.options) };
}
function sectionPage(backend = fixture()) { return { backend, slot: renderSlot(app.navPanels[0]!, { subPath: `sections/${section.id}` }, backend.options) }; }
const calls = (slot: ReturnType<typeof renderSlot>, method: string) => slot.inspection.rpcCalls.filter(call => call.method === method);
async function choose(slot: ReturnType<typeof renderSlot>, tier = "fast") {
  fireEvent.click(await slot.findByRole("button", { name: "Choose a model" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Model" }), { target: { value: selection.model } });
  fireEvent.change(slot.getByRole("textbox", { name: "Reasoning level" }), { target: { value: "high" } });
  fireEvent.change(slot.getByRole("combobox", { name: "Service tier" }), { target: { value: tier } });
  fireEvent.click(slot.getByRole("button", { name: "Apply execution selection" }));
}
async function openPreview(slot: ReturnType<typeof renderSlot>) {
  fireEvent.click(await slot.findByRole("button", { name: "Draft from a thread" }));
  const dialog = await slot.findByRole("dialog", { name: "Draft from a thread" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Investigate the staging bootstrap" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Preview completed excerpts" }));
  await within(dialog).findByText(preview.messages[0]!.quote);
  return dialog;
}

describe("approved drafting settings", () => {
  test("uses a custom settings slot and public picker; seed/empty selection never saves or starts", async () => {
    const { slot } = settings();
    await slot.findByText("Follow source thread model");
    expect(calls(slot, "draftConfigSet")).toHaveLength(0);
    fireEvent.click(slot.getByRole("button", { name: "Choose a model" }));
    expect(slot.getByTestId("bb-provider-model-picker").getAttribute("data-routing-kind")).toBe("primary");
    fireEvent.click(slot.getByRole("button", { name: "Apply execution selection" }));
    expect(slot.getByRole("button", { name: "Save drafting settings" }).matches(":disabled")).toBe(true);
    expect(calls(slot, "draftConfigSet")).toHaveLength(0);
    expect(calls(slot, "draftStart")).toHaveLength(0);
    expect(slot.inspection.sdkCalls).toHaveLength(0);
  });
  test("explicit save retains native selection and reset saves null with CAS", async () => {
    const { slot } = settings();
    await choose(slot);
    expect(calls(slot, "draftConfigSet")).toHaveLength(0);
    fireEvent.click(slot.getByRole("button", { name: "Save drafting settings" }));
    await waitFor(() => expect(calls(slot, "draftConfigSet")).toHaveLength(1));
    expect(calls(slot, "draftConfigSet")[0]!.input).toEqual({ expectedRevision: 0, selection });
    await slot.findByText("Drafting settings saved. Existing jobs keep their requested model.");
    fireEvent.click(slot.getByRole("button", { name: "Follow source thread model" }));
    fireEvent.click(slot.getByRole("button", { name: "Save drafting settings" }));
    await waitFor(() => expect(calls(slot, "draftConfigSet")).toHaveLength(2));
    expect(calls(slot, "draftConfigSet")[1]!.input).toEqual({ expectedRevision: 1, selection: null });
    expect(calls(slot, "draftStart")).toHaveLength(0);
  });
  test("unsupported service tier stays absent, not undefined in strict JSON", async () => {
    const { slot } = settings(); await choose(slot, "");
    fireEvent.click(slot.getByRole("button", { name: "Save drafting settings" }));
    await waitFor(() => expect(calls(slot, "draftConfigSet")).toHaveLength(1));
    expect(calls(slot, "draftConfigSet")[0]!.input).toEqual({ expectedRevision: 0, selection: { providerId: selection.providerId, model: selection.model, reasoningLevel: selection.reasoningLevel } });
  });
  test("CAS conflict preserves the choice and refuses silent rebasing", async () => {
    const { slot, backend } = settings(); await choose(slot);
    backend.config({ revision: 2, selection: { ...selection, model: "changed-in-another-window" }, updatedAt: now, updatedBy: actor });
    fireEvent.click(slot.getByRole("button", { name: "Save drafting settings" }));
    await slot.findByText(/Drafting settings changed elsewhere/);
    expect((slot.getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe(selection.model);
    expect(calls(slot, "draftConfigSet")[0]!.input).toMatchObject({ expectedRevision: 0 });
    await act(() => slot.behavior.emitRealtime("drafts", { configRevision: 2 }));
    await slot.findByText(/Newer drafting settings are available/);
    expect((slot.getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe(selection.model);
    expect(slot.getByRole("button", { name: "Save drafting settings" }).matches(":disabled")).toBe(true);
  });
  test("a refresh error retains model field DOM, focus and selection", async () => {
    const { slot, backend } = settings(); await choose(slot);
    const field = slot.getByRole("textbox", { name: "Model" }) as HTMLInputElement;
    field.focus(); field.setSelectionRange(2, 8);
    backend.rpc.draftConfigGet = () => { throw new Error("Drafting settings refresh unavailable"); };
    await act(() => slot.behavior.emitRealtime("drafts", { configRevision: 2 }));
    await slot.findByText("Drafting settings refresh unavailable");
    expect(slot.getByRole("textbox", { name: "Model" })).toBe(field);
    expect(document.activeElement).toBe(field); expect([field.selectionStart, field.selectionEnd]).toEqual([2, 8]);
    expect(field.value).toBe(selection.model); expect(calls(slot, "draftConfigSet")).toHaveLength(0);
  });
  test("draft configuration remains isolated between public test hosts", async () => {
    const first = fixture(); const second = fixture();
    second.config({ revision: 9, selection: { ...selection, model: "private-second-host-choice" }, updatedAt: now, updatedBy: actor });
    const one = settings(first).slot; const two = settings(second).slot;
    await within(one.container).findByText("Follow source thread model");
    const secondField = await within(two.container).findByRole("textbox", { name: "Model" }) as HTMLInputElement;
    expect(secondField.value).toBe("private-second-host-choice"); expect(within(one.container).queryByRole("textbox", { name: "Model" })).toBeNull();
    expect(calls(one, "draftConfigGet")).toHaveLength(1); expect(calls(two, "draftConfigGet")).toHaveLength(1);
  });
  test.each(["error", "loading"] as const)("unavailable roster %s retains configured values without fallback", async status => {
    const backend = fixture(); backend.config({ revision: 3, selection, updatedAt: now, updatedBy: actor });
    backend.options.providers = { status, providers: [] };
    const { slot } = settings(backend);
    await slot.findByTestId("bb-provider-model-picker");
    expect((slot.getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe(selection.model);
    expect(slot.getByRole("button", { name: "Save drafting settings" }).matches(":disabled")).toBe(true);
    expect(calls(slot, "draftConfigSet")).toHaveLength(0);
    expect(calls(slot, "draftStart")).toHaveLength(0);
  });
});

describe("explicit section drafting", () => {
  test("chooses only an actual section thread, previews bounded source/model, then explicitly starts", async () => {
    const { slot } = sectionPage();
    await slot.findByRole("button", { name: "Draft from a thread" });
    expect(calls(slot, "draftSourcePreview")).toHaveLength(0); expect(calls(slot, "draftStart")).toHaveLength(0);
    const dialog = await openPreview(slot);
    expect(within(dialog).queryByText("Foreign conversation")).toBeNull();
    expect(calls(slot, "draftSourcePreview")[0]!.input).toEqual({ sectionId: section.id, expectedBindingRevision: 1, sourceThreadId: threadId });
    expect(within(dialog).getByText(/Requested model/)).toBeTruthy();
    expect(dialog.textContent).toContain(selection.model); expect(dialog.textContent).toContain("5 messages omitted"); expect(dialog.textContent).toContain("12,000");
    expect(calls(slot, "draftStart")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start drafting" }));
    await waitFor(() => expect(calls(slot, "draftStart")).toHaveLength(1));
    expect(calls(slot, "draftStart")[0]!.input).toEqual({ requestId: expect.any(String), sectionId: section.id, expectedBindingRevision: 1, sourceThreadId: threadId, sourceSnapshotId: preview.snapshotId, expectedConfigRevision: 0 });
    expect(slot.inspection.sdkCalls).toHaveLength(0);
    expect(calls(slot, "knowledgePropose")).toHaveLength(0);
  });
  test("a newer authoritative preview can start even when the older config read is cached", async () => {
    const backend = fixture(); backend.source({ ...preview, execution: { ...preview.execution, configRevision: 2 } });
    const { slot } = sectionPage(backend); const dialog = await openPreview(slot);
    expect(within(dialog).getByRole("button", { name: "Start drafting" }).matches(":disabled")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start drafting" }));
    await waitFor(() => expect(calls(slot, "draftStart")).toHaveLength(1));
    expect(calls(slot, "draftStart")[0]!.input).toMatchObject({ expectedConfigRevision: 2 });
  });
  test("known job progress updates in the open dialog without another Start", async () => {
    const { slot, backend } = sectionPage(); const dialog = await openPreview(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start drafting" }));
    await within(dialog).findByText("Drafting suggestions");
    const input = calls(slot, "draftStart")[0]!.input as { requestId: string };
    backend.jobs([job({ requestId: input.requestId, revision: 2, status: "nothing-to-save" })]);
    await act(() => slot.behavior.emitRealtime("drafts", { sectionId: section.id, requestId: input.requestId, revision: 2 }));
    await within(dialog).findByText("Nothing to save");
    expect(calls(slot, "draftStart")).toHaveLength(1);
  });
  test("changing settings never reroutes an existing job's requested execution", async () => {
    const { slot, backend } = sectionPage(); const dialog = await openPreview(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start drafting" }));
    await within(dialog).findByText("Drafting suggestions");
    backend.config({ revision: 3, selection: { ...selection, model: "future-jobs-model" }, updatedAt: now, updatedBy: actor });
    await act(() => slot.behavior.emitRealtime("drafts", { configRevision: 3 }));
    await waitFor(() => expect(calls(slot, "draftConfigGet").length).toBeGreaterThan(1));
    expect(dialog.textContent).toContain(selection.model); expect(dialog.textContent).not.toContain("future-jobs-model");
    expect(calls(slot, "draftStart")).toHaveLength(1);
  });
  test("draft preview closes back to the actual section action", async () => {
    const { slot } = sectionPage(); const opener = await slot.findByRole("button", { name: "Draft from a thread" });
    opener.focus(); fireEvent.click(opener); const dialog = await slot.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close draft preview" }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
  test("a foreign preview is refused without replacing the chosen source", async () => {
    const backend = fixture(); backend.source({ ...preview, sectionId: "sec_other", sourceThreadId: "thr_foreignx", messages: preview.messages.map(message => ({ ...message, threadId: "thr_foreignx", ref: `@thread:thr_foreignx#msg=${message.messageSeq}` })) });
    const { slot } = sectionPage(backend);
    fireEvent.click(await slot.findByRole("button", { name: "Draft from a thread" }));
    const dialog = await slot.findByRole("dialog"); fireEvent.click(within(dialog).getByRole("button", { name: "Investigate the staging bootstrap" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview completed excerpts" }));
    await within(dialog).findByText("The preview does not match the chosen section and source. No draft was started.");
    expect(dialog.querySelector("blockquote")).toBeNull(); expect(calls(slot, "draftStart")).toHaveLength(0);
  });
  test("unbound section cannot start drafting", async () => {
    const backend = fixture(); backend.section({ ...section, binding: { ...section.binding, revision: 2, binding: null } });
    const { slot } = sectionPage(backend); await slot.findByRole("button", { name: "Share context in this section" });
    expect(slot.queryByRole("button", { name: "Draft from a thread" })).toBeNull();
    expect(calls(slot, "draftStart")).toHaveLength(0);
  });
  test("source refusal keeps selection, has no fallback and starts nothing", async () => {
    const backend = fixture(); backend.rpc.draftSourcePreview = () => { throw { code: "invalid", message: "Source thread moved or has no completed messages" }; };
    const { slot } = sectionPage(backend);
    fireEvent.click(await slot.findByRole("button", { name: "Draft from a thread" }));
    const dialog = await slot.findByRole("dialog", { name: "Draft from a thread" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Investigate the staging bootstrap" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview completed excerpts" }));
    await within(dialog).findByText("Source thread moved or has no completed messages");
    expect(within(dialog).getByRole("button", { name: "Investigate the staging bootstrap" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByRole("button", { name: "Start drafting" }).matches(":disabled")).toBe(true);
    expect(calls(slot, "draftStart")).toHaveLength(0);
  });
  test("settings or binding changes retain the pinned preview and block stale Start", async () => {
    const { slot, backend } = sectionPage(); const dialog = await openPreview(slot); const quote = dialog.querySelector("blockquote");
    backend.config({ revision: 2, selection, updatedAt: now, updatedBy: actor });
    await act(() => slot.behavior.emitRealtime("drafts", { configRevision: 2 }));
    await within(dialog).findByText(/Drafting settings changed since this preview/);
    expect(dialog.querySelector("blockquote")).toBe(quote);
    expect(within(dialog).getByRole("button", { name: "Start drafting" }).matches(":disabled")).toBe(true);
    backend.section({ ...section, binding: { ...section.binding, revision: 2 } });
    await act(() => slot.behavior.emitRealtime("sections", { sectionId: section.id }));
    await within(dialog).findByText(/Section connection changed since this preview/);
    expect(calls(slot, "draftSourcePreview")).toHaveLength(1); expect(calls(slot, "draftStart")).toHaveLength(0);
  });
  test("uncertain Start freezes intent across close/reopen and recovers by lookup, not another model call", async () => {
    const backend = fixture(); backend.rpc.draftStart = input => { backend.jobs([job({ requestId: input.requestId })]); throw { code: "transport_error", message: "Start outcome uncertain" }; };
    const { slot } = sectionPage(backend); const dialog = await openPreview(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start drafting" }));
    await within(dialog).findByText("Start outcome uncertain");
    expect(within(dialog).queryByRole("button", { name: "Start drafting" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.click(slot.getByRole("button", { name: "Draft from a thread" }));
    const reopened = await slot.findByRole("dialog", { name: "Draft from a thread" });
    fireEvent.click(within(reopened).getByRole("button", { name: "Check drafting request" }));
    await waitFor(() => expect(calls(slot, "draftJob")).toHaveLength(1));
    expect(calls(slot, "draftJob")[0]!.input).toEqual({ sectionId: section.id, requestId: (calls(slot, "draftStart")[0]!.input as { requestId: string }).requestId });
    expect(calls(slot, "draftStart")).toHaveLength(1);
  });
  test("durable stop is CAS guarded and requested is not stopped; partial results link original workstream", async () => {
    const backend = fixture(); const partial = job({ workstreamId: "ws_original", revision: 4, candidateResults: [{ intendedId: "kn_suggestion0", canonicalId: "kn_suggestion0", status: "saved", error: null }, { intendedId: "kn_suggestion1", canonicalId: null, status: "pending", error: null }, { intendedId: "kn_suggestion2", canonicalId: null, status: "pending", error: null }] }); backend.jobs([partial]);
    const { slot } = sectionPage(backend); const region = await slot.findByRole("region", { name: "Drafting jobs" });
    fireEvent.click(within(region).getByRole("button", { name: "Stop drafting" }));
    await waitFor(() => expect(calls(slot, "draftCancel")).toHaveLength(1));
    expect(calls(slot, "draftCancel")[0]!.input).toEqual({ sectionId: section.id, requestId, expectedRevision: 4 });
    await within(region).findByText("Stop requested — not yet confirmed");
    expect(within(region).queryByText("Stopped")).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "Review saved suggestion 1" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "cortex", options: { subPath: "workstreams/ws_original/kn_suggestion0" } });
    backend.jobs([{ ...partial, revision: 6, status: "stopped", cancellation: { state: "confirmed", requestedAt: now, confirmedAt: now }, worker: { threadId: "thr_workerxx", state: "stopped" } }]);
    await act(() => slot.behavior.emitRealtime("drafts", { sectionId: section.id, requestId, revision: 6 }));
    await within(region).findByText("Stopped");
    expect(calls(slot, "draftStart")).toHaveLength(0);
  });
  test("save recovery uses pinned job/revision with no fresh inference; empty result is valid", async () => {
    const backend = fixture(); backend.jobs([job({ status: "needs-recovery", retry: "lookup-save", revision: 8, error: "Suggestion save needs recovery" })]);
    const { slot } = sectionPage(backend); const region = await slot.findByRole("region", { name: "Drafting jobs" });
    fireEvent.click(within(region).getByRole("button", { name: "Recover suggestion saves" }));
    await waitFor(() => expect(calls(slot, "draftResumeSave")).toHaveLength(1));
    expect(calls(slot, "draftResumeSave")[0]!.input).toEqual({ sectionId: section.id, requestId, expectedRevision: 8 });
    expect(calls(slot, "draftStart")).toHaveLength(0);
    backend.jobs([job({ revision: 10, status: "nothing-to-save", candidateResults: [] })]); await act(() => slot.behavior.emitRealtime("drafts", { sectionId: section.id, requestId, revision: 10 }));
    await within(region).findByText("Nothing to save"); expect(within(region).queryByRole("button", { name: /Accept all|Adopt rule/ })).toBeNull();
  });
  test("a newest active job remains discoverable beyond the first history page", async () => {
    const backend = fixture();
    const rows = Array.from({ length: 25 }, (_, index) => job({ requestId: `8fafd34a-df8f-4784-9113-${String(index).padStart(12, "0")}`, status: index === 24 ? "running" : "nothing-to-save" }));
    backend.jobs(rows); const { slot } = sectionPage(backend);
    const region = await slot.findByRole("region", { name: "Drafting jobs" });
    await within(region).findByText("Drafting suggestions");
    expect(calls(slot, "draftJobs").some(call => (call.input as { offset: number }).offset === 20)).toBe(true);
    expect(within(region).getByRole("button", { name: "Stop drafting" })).toBeTruthy();
  });
  test("a mismatched Start response remains uncertain and never changes the source/request", async () => {
    const backend = fixture(); backend.rpc.draftStart = input => job({ requestId: input.requestId, sourceThreadId: "thr_foreignx" });
    const { slot } = sectionPage(backend); const dialog = await openPreview(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start drafting" }));
    await within(dialog).findByText("The drafting response changed the pinned source or settings. Check the original request before continuing.");
    expect(within(dialog).getByRole("button", { name: "Check drafting request" })).toBeTruthy();
    expect(dialog.querySelector("blockquote")!.textContent).toBe(preview.messages[0]!.quote);
    expect(calls(slot, "draftStart")).toHaveLength(1);
  });
  test("an expired source snapshot remains readable but cannot start", async () => {
    const backend = fixture(); backend.source({ ...preview, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const { slot } = sectionPage(backend); const dialog = await openPreview(slot);
    await within(dialog).findByText("This preview expired. Prepare a new preview before starting.");
    expect(within(dialog).getByRole("button", { name: "Start drafting" }).matches(":disabled")).toBe(true);
    expect(calls(slot, "draftStart")).toHaveLength(0);
  });
  test("drafts channel refreshes only its section, not unrelated section/context/task reads", async () => {
    const { slot } = sectionPage(); await slot.findByRole("button", { name: "Draft from a thread" });
    await waitFor(() => expect(calls(slot, "draftJobs")).toHaveLength(1));
    const sectionReads = calls(slot, "sectionDetail").length;
    await act(() => slot.behavior.emitRealtime("drafts", { sectionId: "sec_other", requestId, revision: 2 }));
    await act(() => slot.behavior.emitRealtime("thread", { threadId }));
    await act(() => slot.behavior.emitRealtime("all", {}));
    expect(calls(slot, "draftJobs")).toHaveLength(1); expect(calls(slot, "sectionDetail")).toHaveLength(sectionReads);
    await act(() => slot.behavior.emitRealtime("drafts", { sectionId: section.id, requestId, revision: 2 }));
    await waitFor(() => expect(calls(slot, "draftJobs")).toHaveLength(2));
    expect(calls(slot, "sectionDetail")).toHaveLength(sectionReads);
  });
});

describe("bounded drafting client corrections", () => {
  async function uncertain() {
    const backend = fixture();
    const accepted: string[] = [];
    backend.rpc.draftStart = input => { accepted.push(input.requestId); backend.jobs([job({ requestId: input.requestId, status: "nothing-to-save", candidateResults: [] })]); throw { code: "transport_error", message: "Original Start response lost" }; };
    const slot = sectionPage(backend).slot;
    const dialog = await openPreview(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start drafting" }));
    await within(dialog).findByText("Original Start response lost");
    return { backend, slot, accepted, original: calls(slot, "draftStart")[0]!.input as { requestId: string } };
  }
  test("restores only the original request after a full SDK/client remount, until explicit Prepare another", async () => {
    const { backend, slot, accepted, original } = await uncertain();
    expect(localStorage.length).toBe(1);
    const stored = localStorage.getItem(localStorage.key(0)!)!;
    expect(stored).toContain(original.requestId);
    for (const secret of [preview.messages[0]!.quote, "messages", "quote", "candidateResults", "workerNonce", "historySnapshot"]) expect(stored).not.toContain(secret);
    slot.unmount();
    const second = sectionPage(backend).slot;
    await second.findByText("Nothing to save");
    fireEvent.click(second.getByRole("button", { name: "Draft from a thread" }));
    const dialog = await second.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Start drafting" })).toBeNull();
    expect(calls(second, "draftJob")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Check drafting request" }));
    await within(dialog).findByText("Nothing to save");
    expect(calls(second, "draftJob")[0]!.input).toEqual({ sectionId: section.id, requestId: original.requestId });
    expect(accepted).toHaveLength(1); expect(calls(second, "draftStart")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Prepare another draft" }));
    expect(localStorage.length).toBe(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Investigate the staging bootstrap" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview completed excerpts" }));
    await within(dialog).findByText(preview.messages[0]!.quote);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start drafting" }));
    await waitFor(() => expect(accepted).toHaveLength(2)); expect(accepted[1]).not.toBe(original.requestId);
  });
  test.each(["server", "origin", "plugin", "section"])("recovery never reads or clears another %s scope", async kind => {
    const { backend, slot } = await uncertain(); slot.unmount();
    const key = localStorage.key(0)!; const value = localStorage.getItem(key);
    if (kind === "server") backend.options.servers = servers("server_other");
    if (kind === "origin") backend.options.servers = servers("server_primary", "https://another.example");
    if (kind === "plugin") backend.options.pluginId = "cortex-other";
    if (kind === "section") { backend.section({ ...section, id: "sec_other" }); backend.rpc.sectionDetail = () => ({ section: { ...section, id: "sec_other" }, threads: [], eligibility: { computedAt: now, status: "ready", error: null, entries: [], notices: [], exclusions: [], exactText: "", estimatedTokens: 0, budgetTokens: 400 }, review: { items: [], total: 0, limit: 50, offset: 0 } }); }
    backend.jobs([]);
    const second = sectionPage(backend).slot;
    fireEvent.click(await second.findByRole("button", { name: "Draft from a thread" }));
    const dialog = await second.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Check drafting request" })).toBeNull();
    expect(localStorage.getItem(key)).toBe(value); expect(calls(second, "draftJob")).toHaveLength(0);
  });
  test.each(["loading", "ambiguous", "opaque", "unavailable", "read", "write", "corrupt"])("%s recovery storage fails closed without a Start", async kind => {
    const backend = fixture();
    if (kind === "loading") backend.options.servers = { ...servers(), status: "loading" };
    if (kind === "ambiguous") backend.options.servers = { ...servers(), servers: [...servers().servers, ...servers("server_other").servers] };
    if (kind === "opaque") backend.options.servers = servers("opaque", "null");
    if (kind === "unavailable") vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("Storage denied"); });
    if (kind === "read") vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage read denied"); });
    if (kind === "write") vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
    if (kind === "corrupt") {
      const original = await uncertain(); original.slot.unmount();
      localStorage.setItem(localStorage.key(0)!, '{"version":1,"input":{}}');
    }
    const { slot } = sectionPage(backend); const dialog = await openPreview(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start drafting" }));
    await within(dialog).findByText(/Drafting recovery is blocked/);
    expect(calls(slot, "draftStart")).toHaveLength(0);
  });
  test("corrupt recovery requires explicit consequence-confirmed discard and preserves other keys", async () => {
    const { backend, slot } = await uncertain(); slot.unmount();
    const key = localStorage.key(0)!; localStorage.setItem(key, "invalid"); localStorage.setItem("unrelated", "keep");
    const second = sectionPage(backend).slot;
    fireEvent.click(await second.findByRole("button", { name: "Draft from a thread" })); const dialog = await second.findByRole("dialog");
    await within(dialog).findByText(/Drafting recovery is blocked/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard recovery record…" }));
    expect(dialog.textContent).toContain("may still be running"); expect(localStorage.getItem(key)).toBe("invalid");
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard recovery record" }));
    expect(localStorage.getItem(key)).toBeNull(); expect(localStorage.getItem("unrelated")).toBe("keep");
    expect(calls(second, "draftStart")).toHaveLength(0);
  });
  test("browser scope uses its real origin and never an opaque or guessed server", () => {
    const browser = draftRecoveryScope(null, "cortex", section.id, "https://browser.example:444");
    expect(browser.error).toBeNull(); expect(browser.key).toContain("https://browser.example:444");
    expect(draftRecoveryScope(null, "cortex", section.id, "null").key).toBeNull();
    const sanitized = draftRecoveryScope(servers("stable", "https://user:secret@bb.example/private/path"), "cortex", section.id, "https://other.example");
    expect(sanitized.key).toContain("https://bb.example"); expect(sanitized.key).not.toMatch(/user|secret|private|other/);
  });
  test("ordinary browser recovery survives a new public SDK host", async () => {
    const backend = fixture(); backend.options.servers = null;
    backend.rpc.draftStart = input => { backend.jobs([job({ requestId: input.requestId })]); throw new Error("Browser response lost"); };
    const slot = sectionPage(backend).slot; const dialog = await openPreview(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start drafting" })); await within(dialog).findByText("Browser response lost");
    expect(localStorage.key(0)).toContain(window.location.origin); slot.unmount();
    const second = sectionPage(backend).slot; fireEvent.click(await second.findByRole("button", { name: "Draft from a thread" }));
    const restored = await second.findByRole("dialog"); expect(within(restored).getByRole("button", { name: "Check drafting request" })).toBeTruthy();
    expect(calls(second, "draftStart")).toHaveLength(0);
  });
  test("failed durable removal keeps the terminal request and blocks a fresh Start", async () => {
    const { backend, slot } = await uncertain();
    const dialog = slot.getByRole("dialog"); fireEvent.click(within(dialog).getByRole("button", { name: "Check drafting request" }));
    await within(dialog).findByText("Nothing to save");
    const key = localStorage.key(0)!;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("Storage removal denied"); });
    fireEvent.click(within(dialog).getByRole("button", { name: "Prepare another draft" }));
    await within(dialog).findByText(/Drafting recovery is blocked/); expect(localStorage.getItem(key)).not.toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Start drafting" })).toBeNull(); expect(calls(slot, "draftStart")).toHaveLength(1);
    backend.jobs([]);
  });
  test("Start validates the preview's exact workstream and requested execution before caching", async () => {
    const backend = fixture(); backend.rpc.draftStart = input => job({ requestId: input.requestId, workstreamId: "ws_other", execution: { ...preview.execution, model: "foreign-model" } });
    const { slot } = sectionPage(backend); const dialog = await openPreview(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start drafting" }));
    await within(dialog).findByText(/The drafting response changed the pinned source or settings/);
    expect(within(dialog).getByRole("button", { name: "Check drafting request" })).toBeTruthy(); expect(dialog.textContent).not.toContain("foreign-model");
  });
  test("restored lookup rejects same-ID changed preview execution before showing the job", async () => {
    const { backend, slot, original } = await uncertain(); slot.unmount();
    backend.jobs([job({ requestId: original.requestId, execution: { ...preview.execution, model: "foreign-model" } })]);
    const second = sectionPage(backend).slot;
    fireEvent.click(await second.findByRole("button", { name: "Draft from a thread" })); const dialog = await second.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Check drafting request" }));
    await within(dialog).findByText(/The drafting response changed the pinned source or settings/);
    expect(dialog.textContent).not.toContain("foreign-model"); expect(calls(second, "draftStart")).toHaveLength(0);
    expect(within(dialog).getByRole("button", { name: "Check drafting request" })).toBeTruthy();
  });
  test.each(["foreign", "source", "snapshot", "binding", "execution", "model", "provider", "reasoning", "tier", "origin", "config", "workstream", "workstream-revision", "requested-at", "deadline", "worker"])("a %s live response retains the original view and Stop target; later valid progress works", async kind => {
    const { backend, slot } = sectionPage(); const dialog = await openPreview(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start drafting" })); await within(dialog).findByText("Drafting suggestions");
    const original = calls(slot, "draftStart")[0]!.input as { requestId: string };
    const originalJob = job({ requestId: original.requestId });
    const variants: Record<string, Partial<DraftJob>> = {
      foreign: { sectionId: "sec_other", requestId }, source: { sourceThreadId: "thr_foreignx" }, snapshot: { sourceSnapshotId: requestId }, binding: { bindingRevision: 2 },
      execution: { execution: { ...preview.execution, hostId: "host_other" } }, model: { execution: { ...preview.execution, model: "foreign-model" } }, provider: { execution: { ...preview.execution, providerId: "foreign-provider" } }, reasoning: { execution: { ...preview.execution, reasoningLevel: "low" } }, tier: { execution: { ...preview.execution, serviceTier: "slow" } }, origin: { execution: { ...preview.execution, origin: "configured" } }, config: { execution: { ...preview.execution, configRevision: 9 } },
      workstream: { workstreamId: "ws_other" }, "workstream-revision": { workstreamRevision: 9 }, "requested-at": { requestedAt: new Date(Date.parse(now) + 1000).toISOString() }, deadline: { deadlineAt: now }, worker: { worker: { threadId: "thr_foreignx", state: "known" } },
    };
    const changes = variants[kind]!;
    backend.rpc.draftJob = () => ({ ...originalJob, ...changes, revision: 2, progress: "Foreign progress must not appear" });
    await act(() => slot.behavior.emitRealtime("drafts", { sectionId: section.id, requestId: original.requestId, revision: 2 }));
    await within(dialog).findByText(/The drafting response/);
    expect(dialog.textContent).not.toContain("Foreign progress must not appear");
    expect(within(dialog).getByText("Drafting suggestions")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop drafting" }));
    await waitFor(() => expect(calls(slot, "draftCancel")).toHaveLength(1));
    expect(calls(slot, "draftCancel")[0]!.input).toEqual({ sectionId: section.id, requestId: original.requestId, expectedRevision: 1 });
    backend.rpc.draftJob = () => ({ ...originalJob, revision: 3, progress: "Correct later progress" });
    await act(() => slot.behavior.emitRealtime("drafts", { sectionId: section.id, requestId: original.requestId, revision: 3 }));
    await within(dialog).findByText("Correct later progress"); expect(calls(slot, "draftStart")).toHaveLength(1);
  });
  test("initial worker assignment and later revisions are accepted without accepting older dynamic data", async () => {
    const backend = fixture(); backend.rpc.draftStart = input => { const next = job({ requestId: input.requestId, worker: { threadId: null, state: "requesting" } }); backend.jobs([next]); return next; };
    const { slot } = sectionPage(backend); const dialog = await openPreview(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start drafting" })); await within(dialog).findByText("Drafting suggestions");
    const input = calls(slot, "draftStart")[0]!.input as { requestId: string };
    backend.jobs([job({ requestId: input.requestId, revision: 3, progress: "Worker assigned" })]);
    await act(() => slot.behavior.emitRealtime("drafts", { sectionId: section.id, requestId: input.requestId, revision: 3 }));
    await within(dialog).findByText("Worker assigned"); expect(within(dialog).getByRole("button", { name: "Open drafting session" })).toBeTruthy();
    backend.jobs([job({ requestId: input.requestId, revision: 2, progress: "Old progress" })]);
    const before = calls(slot, "draftJob").length;
    await act(() => slot.behavior.emitRealtime("drafts", { sectionId: section.id, requestId: input.requestId, revision: 2 }));
    await waitFor(() => expect(calls(slot, "draftJob").length).toBeGreaterThan(before));
    expect(within(dialog).getByText("Worker assigned")).toBeTruthy(); expect(dialog.textContent).not.toContain("Old progress");
  });
  test("a foreign list row cannot replace known history or retarget actions", async () => {
    const backend = fixture(); backend.jobs([job()]); const { slot } = sectionPage(backend);
    const region = await slot.findByRole("region", { name: "Drafting jobs" }); await within(region).findByText("Drafting suggestions");
    backend.jobs([job({ sectionId: "sec_other", revision: 2, progress: "Foreign list row" })]);
    await act(() => slot.behavior.emitRealtime("drafts", { sectionId: section.id, requestId, revision: 2 }));
    await within(region).findByText(/The drafting response/); expect(region.textContent).not.toContain("Foreign list row");
    fireEvent.click(within(region).getByRole("button", { name: "Stop drafting" }));
    await waitFor(() => expect(calls(slot, "draftCancel")).toHaveLength(1));
    expect(calls(slot, "draftCancel")[0]!.input).toMatchObject({ sectionId: section.id, requestId });
  });
  test.each(["source", "execution"])("same-ID changed %s list rows keep the known history", async kind => {
    const backend = fixture(); backend.jobs([job()]); const { slot } = sectionPage(backend);
    const region = await slot.findByRole("region", { name: "Drafting jobs" }); await within(region).findByText("Drafting suggestions");
    backend.jobs([job({ revision: 2, progress: "Wrong history", ...(kind === "source" ? { sourceSnapshotId: requestId } : { execution: { ...preview.execution, model: "wrong-model" } }) })]);
    await act(() => slot.behavior.emitRealtime("drafts", { sectionId: section.id, requestId, revision: 2 }));
    await within(region).findByText(/The drafting response changed the pinned source or settings/); expect(region.textContent).not.toContain("Wrong history");
  });
  test("pending, empty and no-save slots without canonical IDs never invent result links", async () => {
    const backend = fixture(); backend.jobs([job({ status: "completed", candidateResults: [{ intendedId: "kn_unused", canonicalId: null, status: "no-save", error: null }, { intendedId: "kn_pending", canonicalId: null, status: "pending", error: null }] })]);
    const { slot } = sectionPage(backend); const region = await slot.findByRole("region", { name: "Drafting jobs" });
    await within(region).findByText("No new takeaway was saved"); expect(within(region).queryByRole("button", { name: /Open existing takeaway|Review saved suggestion/ })).toBeNull();
    expect(region.textContent).not.toMatch(/kn_unused|kn_pending/);
    backend.jobs([job({ status: "nothing-to-save", revision: 2, candidateResults: [] })]);
    await act(() => slot.behavior.emitRealtime("drafts", { sectionId: section.id, requestId, revision: 2 }));
    await within(region).findByText("Nothing to save"); expect(region.querySelector("ul")).toBeNull(); expect(calls(slot, "draftStart")).toHaveLength(0);
  });
  test.each(["source", "execution"])("history-first remount rejects conflicting %s pins while closed, then the same client recovers the authentic job", async kind => {
    const { backend, slot, original, accepted } = await uncertain();
    const key = localStorage.key(0)!; const raw = localStorage.getItem(key);
    slot.unmount();
    backend.jobs([job({ requestId: original.requestId, revision: 2, status: "nothing-to-save", candidateResults: [], progress: "Uncorrelated history after remount", ...(kind === "source" ? { sourceThreadId: "thr_foreignx" } : { execution: { ...preview.execution, model: "foreign-model" } }) })]);
    const second = sectionPage(backend).slot;
    const history = await second.findByRole("region", { name: "Drafting jobs" });
    await within(history).findByText(/The drafting response changed the pinned source or settings/);
    expect(history.textContent).not.toContain("Uncorrelated history after remount");
    expect(within(history).queryByRole("button", { name: /Open source thread|Stop drafting|Open drafting session/ })).toBeNull();
    expect(second.queryByRole("dialog")).toBeNull(); expect(calls(second, "draftJob")).toHaveLength(0); expect(calls(second, "draftStart")).toHaveLength(0);
    fireEvent.click(second.getByRole("button", { name: "Draft from a thread" })); const restored = await second.findByRole("dialog");
    backend.jobs([job({ requestId: original.requestId, revision: 3, status: "nothing-to-save", candidateResults: [], progress: "Authentic original terminal job" })]);
    fireEvent.click(within(restored).getByRole("button", { name: "Check drafting request" }));
    await within(restored).findByText("Authentic original terminal job");
    fireEvent.click(within(restored).getByRole("button", { name: "Open source thread" }));
    expect(second.inspection.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId });
    expect(calls(second, "draftJob")[0]!.input).toEqual({ sectionId: section.id, requestId: original.requestId });
    expect(restored.textContent).toContain(selection.model); expect(localStorage.getItem(key)).toBe(raw); expect(accepted).toHaveLength(1); expect(calls(second, "draftStart")).toHaveLength(0);
  });
  function LiveRead({ sectionId = section.id, id = requestId }: { sectionId?: string; id?: string }) {
    const read = useDraftJob({ sectionId, requestId: id });
    return <section aria-label="Live read">{read.error ? <p role="alert">{read.error.message}</p> : null}{read.data ? <DraftJobView job={read.data} /> : null}<button onClick={read.refetch}>Refresh live read</button></section>;
  }
  test.each(["live-first", "history-first"])("restored pins guard %s without any dialog mounting", async order => {
    const { backend, slot, original } = await uncertain(); slot.unmount();
    const wrong = job({ requestId: original.requestId, revision: 2, sourceThreadId: "thr_foreignx", progress: "Foreign first read" });
    backend.jobs([wrong]);
    const View = () => order === "live-first" ? <><LiveRead id={original.requestId} /><DraftJobs section={section} /></> : <><DraftJobs section={section} /><LiveRead id={original.requestId} /></>;
    const second = renderSlot({ component: View }, {}, backend.options);
    const live = second.getByRole("region", { name: "Live read" });
    await within(live).findByText(/The drafting response changed the pinned source or settings/);
    const history = second.getByRole("region", { name: "Drafting jobs" }); await within(history).findByText(/The drafting response changed the pinned source or settings/);
    expect(second.container.textContent).not.toContain("Foreign first read"); expect(second.queryByRole("button", { name: "Open source thread" })).toBeNull();
    backend.jobs([job({ requestId: original.requestId, revision: 3, progress: "Authentic progress" })]);
    fireEvent.click(within(live).getByRole("button", { name: "Refresh live read" })); await within(live).findByText("Authentic progress");
    backend.jobs([job({ requestId: original.requestId, revision: 4, execution: { ...preview.execution, model: "later-foreign" } })]);
    await act(() => second.behavior.emitRealtime("drafts", { sectionId: section.id, requestId: original.requestId, revision: 4 }));
    await within(live).findByText(/The drafting response changed the pinned source or settings/); expect(within(live).getByText("Authentic progress")).toBeTruthy();
    expect(calls(second, "draftStart")).toHaveLength(0);
  });
  test.each(["loading", "ambiguous", "opaque"])("server scope %s then ready hydrates pins before the first same-client history result", async kind => {
    const { backend, slot, original } = await uncertain(); slot.unmount();
    if (kind === "loading") backend.options.servers!.status = "loading";
    if (kind === "ambiguous") backend.options.servers!.servers = [...servers().servers, ...servers("another-server").servers];
    if (kind === "opaque") backend.options.servers!.servers[0]!.origin = "null";
    backend.jobs([job({ requestId: original.requestId, sourceThreadId: "thr_foreignx", progress: "Foreign during server loading" })]);
    const View = () => <DraftJobs section={section} />;
    const second = renderSlot({ component: View }, {}, backend.options);
    await second.findByText(/Drafting recovery is blocked/); expect(second.container.textContent).not.toContain("Foreign during server loading");
    expect(calls(second, "draftJobs")).toHaveLength(0);
    backend.options.servers!.status = "ready"; backend.options.servers!.servers = servers().servers; second.rerender(<View />);
    await second.findByText(/The drafting response changed the pinned source or settings/); expect(calls(second, "draftJobs")).toHaveLength(1);
    backend.jobs([job({ requestId: original.requestId, revision: 3, progress: "Ready server authentic history" })]);
    await act(() => second.behavior.emitRealtime("drafts", { sectionId: section.id, requestId: original.requestId, revision: 3 }));
    await second.findByText("Ready server authentic history"); expect(calls(second, "draftJob")).toHaveLength(0); expect(calls(second, "draftStart")).toHaveLength(0);
  });
  test.each(["corrupt", "unavailable"])("%s recovery blocks closed-dialog history until storage is recovered", async kind => {
    const { backend, slot, original } = await uncertain(); slot.unmount();
    const key = localStorage.key(0)!; const raw = localStorage.getItem(key)!;
    if (kind === "corrupt") localStorage.setItem(key, "invalid");
    const denied = kind === "unavailable" ? vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage denied"); }) : null;
    backend.jobs([job({ requestId: original.requestId, sourceThreadId: "thr_foreignx", progress: "Untrusted history" })]);
    const second = renderSlot({ component: () => <DraftJobs section={section} /> }, {}, backend.options);
    await second.findByText(/Drafting recovery is blocked/); expect(second.container.textContent).not.toContain("Untrusted history"); expect(second.queryByRole("button", { name: "Open source thread" })).toBeNull();
    denied?.mockRestore(); localStorage.setItem(key, raw);
    backend.jobs([job({ requestId: original.requestId, revision: 3, progress: "Storage recovered authentic history" })]);
    fireEvent.click(second.getByRole("button", { name: "Retry" })); await second.findByText("Storage recovered authentic history");
    expect(localStorage.getItem(key)).toBe(raw); expect(calls(second, "draftJob")).toHaveLength(0); expect(calls(second, "draftStart")).toHaveLength(0);
  });
  test.each(["server", "plugin", "section"])("history pins do not cross a different %s scope", async kind => {
    const { backend, slot, original } = await uncertain(); slot.unmount();
    const key = localStorage.key(0)!; const raw = localStorage.getItem(key);
    if (kind === "server") backend.options.servers = servers("other-server");
    if (kind === "plugin") backend.options.pluginId = "other-plugin";
    const otherSection = kind === "section" ? { ...section, id: "sec_other" } : section;
    backend.jobs([job({ sectionId: otherSection.id, requestId: original.requestId, sourceThreadId: "thr_foreignx", progress: "Independent scoped history" })]);
    const second = renderSlot({ component: () => <DraftJobs section={otherSection} /> }, {}, backend.options);
    await second.findByText("Independent scoped history"); expect(localStorage.getItem(key)).toBe(raw); expect(second.queryByRole("alert")).toBeNull();
    expect(calls(second, "draftStart")).toHaveLength(0);
  });
  test("a bad history page does not retain earlier valid rows before the whole page is checked", async () => {
    const { backend, slot, original } = await uncertain(); slot.unmount();
    backend.jobs([job({ requestId, progress: "Unretained sibling" }), job({ requestId: original.requestId, sourceThreadId: "thr_foreignx", progress: "Rejected pinned row" })]);
    const second = renderSlot({ component: () => <DraftJobs section={section} /> }, {}, backend.options);
    await second.findByText(/The drafting response changed the pinned source or settings/);
    expect(second.container.textContent).not.toContain("Unretained sibling");
    backend.jobs([job({ requestId, revision: 2, sourceThreadId: "thr_foreignx", progress: "Sibling first trusted row" }), job({ requestId: original.requestId, revision: 2, progress: "Authentic pinned row" })]);
    fireEvent.click(second.getByRole("button", { name: "Retry" })); await second.findByText("Sibling first trusted row"); await second.findByText("Authentic pinned row");
  });
  test("newly available trusted pins quarantine a conflicting unpinned cached baseline, not authentic recovery", async () => {
    const backend = fixture(); backend.jobs([job({ sourceThreadId: "thr_foreignx", progress: "Previously unpinned row" })]);
    const second = renderSlot({ component: () => <DraftJobs section={section} /> }, {}, backend.options);
    await second.findByText("Previously unpinned row");
    const scope = draftRecoveryScope(backend.options.servers, backend.options.pluginId, section.id, window.location.origin);
    const stored = pendingDraft({ requestId, sectionId: section.id, expectedBindingRevision: 1, sourceThreadId: threadId, sourceSnapshotId: preview.snapshotId, expectedConfigRevision: 0 }, preview);
    savePendingDraft(scope.key!, stored);
    await act(() => second.behavior.emitRealtime("drafts", { sectionId: section.id, requestId, revision: 2 }));
    await second.findByText(/The drafting response changed the pinned source or settings/);
    expect(second.container.textContent).not.toContain("Previously unpinned row"); expect(second.queryByRole("button", { name: "Open source thread" })).toBeNull();
    backend.jobs([job({ revision: 3, progress: "Authentic after quarantine" })]);
    fireEvent.click(second.getByRole("button", { name: "Retry" })); await second.findByText("Authentic after quarantine");
    expect(localStorage.getItem(scope.key!)).toBe(JSON.stringify(stored)); expect(calls(second, "draftStart")).toHaveLength(0);
  });
  test("pins written while a history read is in flight apply before its response is published", async () => {
    const backend = fixture();
    let respond!: (page: { jobs: DraftJob[]; total: number; limit: number; offset: number }) => void;
    backend.options.rpc.draftJobs = () => new Promise(resolve => { respond = resolve; });
    const second = renderSlot({ component: () => <DraftJobs section={section} /> }, {}, backend.options);
    await waitFor(() => expect(calls(second, "draftJobs")).toHaveLength(1));
    const scope = draftRecoveryScope(backend.options.servers, backend.options.pluginId, section.id, window.location.origin);
    savePendingDraft(scope.key!, pendingDraft({ requestId, sectionId: section.id, expectedBindingRevision: 1, sourceThreadId: threadId, sourceSnapshotId: preview.snapshotId, expectedConfigRevision: 0 }, preview));
    await act(async () => { respond({ jobs: [job({ sourceThreadId: "thr_foreignx", progress: "Foreign in-flight response" })], total: 1, limit: 20, offset: 0 }); });
    await second.findByText(/The drafting response changed the pinned source or settings/); expect(second.container.textContent).not.toContain("Foreign in-flight response");
    expect(second.queryByRole("button", { name: "Open source thread" })).toBeNull();
    backend.options.rpc.draftJobs = () => ({ jobs: [job({ revision: 3, progress: "Authentic in-flight recovery" })], total: 1, limit: 20, offset: 0 });
    fireEvent.click(second.getByRole("button", { name: "Retry" })); await second.findByText("Authentic in-flight recovery"); expect(calls(second, "draftStart")).toHaveLength(0);
  });
  test("switching public server scope on one SDK client never reuses another server's known job", async () => {
    const { backend, slot, original } = await uncertain(); slot.unmount();
    backend.jobs([job({ requestId: original.requestId, progress: "Original server history" })]);
    const View = () => <DraftJobs section={section} />;
    const second = renderSlot({ component: View }, {}, backend.options); await second.findByText("Original server history");
    backend.options.servers!.servers[0]!.id = "another-server";
    backend.jobs([job({ requestId: original.requestId, sourceThreadId: "thr_foreignx", progress: "Other server history" })]);
    second.rerender(<View />); await second.findByText("Other server history");
    backend.options.servers!.servers[0]!.id = "server_primary"; second.rerender(<View />);
    await second.findByText(/The drafting response changed the pinned source or settings/);
    expect(second.container.textContent).not.toContain("Other server history"); expect(second.getByText("Original server history")).toBeTruthy();
    fireEvent.click(second.getByRole("button", { name: "Open source thread" })); expect(second.inspection.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId });
    expect(calls(second, "draftStart")).toHaveLength(0);
  });
  test("canonical no-save result opens existing original-workstream knowledge without new-review claims", async () => {
    const backend = fixture(); backend.jobs([job({ status: "completed", workstreamId: "ws_original", candidateResults: [{ intendedId: "kn_unused", canonicalId: "kn_existing", status: "no-save", error: null }] })]);
    const { slot } = sectionPage(backend); const region = await slot.findByRole("region", { name: "Drafting jobs" });
    await within(region).findByText("No new takeaway was saved");
    fireEvent.click(within(region).getByRole("button", { name: "Open existing takeaway" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "cortex", options: { subPath: "workstreams/ws_original/kn_existing" } });
    expect(region.textContent).not.toContain("Saved findings require individual review"); expect(region.textContent).not.toContain("kn_unused");
    expect(calls(slot, "draftStart")).toHaveLength(0);
  });
});

describe("known Stop without recovery storage", () => {
  const target = { sectionId: section.id, requestId, expectedRevision: 3 };
  const intent = () => pendingDraft({ requestId, sectionId: section.id, expectedBindingRevision: 1, sourceThreadId: threadId, sourceSnapshotId: preview.snapshotId, expectedConfigRevision: 0 }, preview);
  function WriteProbe({ input = target, seedKnown = true, kind = "cancel" }: { input?: typeof target; seedKnown?: boolean; kind?: "cancel" | "start" | "lookup" | "resume" }) {
    const read = useDraftJob(seedKnown ? { sectionId: section.id, requestId } : null);
    const writes = useDraftWrites();
    const [error, setError] = useState(""); const [ack, setAck] = useState<DraftJob | null>(null);
    const run = async () => {
      setError(""); setAck(null);
      try {
        const out = kind === "cancel" ? await writes.cancel(input) : kind === "start" ? await writes.start(intent().input, intent()) : kind === "lookup" ? await writes.lookup(input.sectionId, input.requestId) : await writes.resume(input);
        setAck(out);
      } catch (cause) { const failure = failureOf(cause); setError(`${failure.code}: ${failure.message}`); }
    };
    return <section aria-label="Write probe">{read.error ? <p>{read.error.message}</p> : null}{read.data ? <p>{read.data.progress} · {read.data.execution.model}</p> : null}<button onClick={() => void run()}>Explicit {kind}</button>{error ? <p role="alert">{error}</p> : null}{ack ? <p>Accepted response: {ack.status}</p> : null}</section>;
  }
  async function knownProbe(input = target, kind: "cancel" | "start" | "lookup" | "resume" = "cancel") {
    const backend = fixture(); backend.jobs([job({ revision: 3, progress: "Trusted known job" })]);
    const slot = renderSlot({ component: () => <WriteProbe input={input} kind={kind} /> }, {}, backend.options);
    await slot.findByText(/Trusted known job/); await act(async () => {});
    return { backend, slot };
  }
  test("actual-component Start then Stop sends the original cancellation during storage outage and accepts its response", async () => {
    const { backend, slot } = sectionPage(); const dialog = await openPreview(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start drafting" })); await within(dialog).findByText("Drafting suggestions");
    await waitFor(() => expect(calls(slot, "draftJob")).toHaveLength(1)); await act(async () => {});
    const original = calls(slot, "draftStart")[0]!.input as { requestId: string };
    const key = localStorage.key(0)!; const raw = localStorage.getItem(key)!; const scope = JSON.stringify(backend.options.servers);
    const denied = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Recovery storage became unavailable after successful Start"); });
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop drafting" }));
    await waitFor(() => expect(calls(slot, "draftCancel")).toHaveLength(1));
    await within(dialog).findByText("Stop requested — not yet confirmed");
    expect(calls(slot, "draftCancel")[0]!.input).toEqual({ sectionId: section.id, requestId: original.requestId, expectedRevision: 1 });
    expect(within(dialog).queryByText("Stopped")).toBeNull(); expect(within(dialog).queryByText(/Drafting recovery is blocked/)).toBeNull();
    expect(calls(slot, "draftStart")).toHaveLength(1); expect(calls(slot, "draftJob")).toHaveLength(1); expect(JSON.stringify(backend.options.servers)).toBe(scope);
    denied.mockRestore(); expect(localStorage.getItem(key)).toBe(raw);
  });
  test("storage becoming unreadable only after cancel was sent cannot turn a valid acknowledgement into a storage error", async () => {
    const { backend, slot } = await knownProbe();
    let finish!: (out: DraftJob) => void;
    backend.options.rpc.draftCancel = () => new Promise(resolve => { finish = resolve; });
    fireEvent.click(slot.getByRole("button", { name: "Explicit cancel" })); await waitFor(() => expect(calls(slot, "draftCancel")).toHaveLength(1));
    const denied = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage failed after request"); });
    await act(async () => { finish(job({ revision: 4, status: "cancel-requested", cancellation: { state: "requested", requestedAt: now, confirmedAt: null } })); });
    await slot.findByText("Accepted response: cancel-requested"); expect(slot.queryByRole("alert")).toBeNull(); denied.mockRestore();
  });
  test.each(["section", "request", "revision"])("wrong %s is refused before any cancel RPC, even with readable storage", async kind => {
    const input = { ...target, ...(kind === "section" ? { sectionId: "sec_other" } : kind === "request" ? { requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } : { expectedRevision: 2 }) };
    const { slot } = await knownProbe(input);
    fireEvent.click(slot.getByRole("button", { name: "Explicit cancel" })); await slot.findByRole("alert"); expect(calls(slot, "draftCancel")).toHaveLength(0);
  });
  test.each(["loading", "ambiguous", "server", "origin"])("%s public scope cannot reuse the known-cancel path", async kind => {
    const { backend, slot } = await knownProbe();
    if (kind === "loading") backend.options.servers!.status = "loading";
    if (kind === "ambiguous") backend.options.servers!.servers = [...servers().servers, ...servers("another-server").servers];
    if (kind === "server") backend.options.servers!.servers[0]!.id = "another-server";
    if (kind === "origin") backend.options.servers!.servers[0]!.origin = "https://another.example";
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    fireEvent.click(slot.getByRole("button", { name: "Explicit cancel" })); await slot.findByRole("alert");
    expect(calls(slot, "draftCancel")).toHaveLength(0); expect(calls(slot, "draftStart")).toHaveLength(0); expect(calls(slot, "draftJob")).toHaveLength(1);
  });
  test.each(["unknown", "other-plugin", "contradictory-pins"])("%s cannot manufacture a trusted cancel identity", async kind => {
    const backend = fixture(); backend.jobs([job({ revision: 3 })]);
    const scope = draftRecoveryScope(backend.options.servers, backend.options.pluginId, section.id, window.location.origin); savePendingDraft(scope.key!, intent());
    if (kind === "other-plugin") {
      const first = renderSlot({ component: () => <WriteProbe /> }, {}, backend.options); await waitFor(() => expect(calls(first, "draftJob")).toHaveLength(1)); await act(async () => {}); first.unmount();
      backend.options.pluginId = "another-plugin";
    }
    if (kind === "contradictory-pins") backend.jobs([job({ revision: 3, sourceThreadId: "thr_foreignx" })]);
    const slot = renderSlot({ component: () => <WriteProbe seedKnown={kind === "contradictory-pins"} /> }, {}, backend.options);
    if (kind === "contradictory-pins") await slot.findByText(/The drafting response changed the pinned source or settings/);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    fireEvent.click(slot.getByRole("button", { name: "Explicit cancel" })); await slot.findByRole("alert"); expect(calls(slot, "draftCancel")).toHaveLength(0);
  });
  test.each(["start", "lookup", "resume"] as const)("known %s still requires recovery storage and sends no new RPC during outage", async kind => {
    const { slot } = await knownProbe(target, kind); const before = slot.inspection.rpcCalls.length;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Recovery storage unavailable"); });
    fireEvent.click(slot.getByRole("button", { name: `Explicit ${kind}` }));
    await slot.findByText(/recovery_blocked: Drafting recovery is blocked/); expect(slot.inspection.rpcCalls).toHaveLength(before);
  });
  test.each(["section", "request", "source", "execution", "worker", "revision"])("a %s-mismatched cancel response remains rejected during storage outage", async kind => {
    const { backend, slot } = await knownProbe();
    const changes: Partial<DraftJob> = kind === "section" ? { sectionId: "sec_other" } : kind === "request" ? { requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } : kind === "source" ? { sourceThreadId: "thr_foreignx" } : kind === "execution" ? { execution: { ...preview.execution, model: "foreign-model" } } : kind === "worker" ? { worker: { threadId: "thr_foreignx", state: "known" } } : { revision: 2 };
    backend.options.rpc.draftCancel = () => job({ revision: 4, status: "cancel-requested", cancellation: { state: "requested", requestedAt: now, confirmedAt: null }, ...changes });
    const denied = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    fireEvent.click(slot.getByRole("button", { name: "Explicit cancel" }));
    await waitFor(() => expect(calls(slot, "draftCancel")).toHaveLength(1));
    expect((await slot.findByRole("alert")).textContent).toContain("invalid_output:"); expect(slot.queryByText(/Accepted response/)).toBeNull(); expect(slot.getByText(/Trusted known job/)).toBeTruthy();
    denied.mockRestore(); backend.jobs([job({ revision: 5, progress: "Proper original known progress" })]);
    await act(() => slot.behavior.emitRealtime("drafts", { sectionId: section.id, requestId, revision: 5 })); await slot.findByText(/Proper original known progress/);
  });
  test("a server scope change during cancel prevents its response becoming an acknowledgement in the new scope", async () => {
    const { backend, slot } = await knownProbe(); let finish!: (out: DraftJob) => void;
    backend.options.rpc.draftCancel = () => new Promise(resolve => { finish = resolve; });
    fireEvent.click(slot.getByRole("button", { name: "Explicit cancel" })); await waitFor(() => expect(calls(slot, "draftCancel")).toHaveLength(1));
    backend.options.servers!.status = "loading";
    await act(async () => { finish(job({ revision: 4, status: "cancel-requested", cancellation: { state: "requested", requestedAt: now, confirmedAt: null } })); });
    await slot.findByRole("alert"); expect(slot.queryByText(/Accepted response/)).toBeNull(); expect(calls(slot, "draftStart")).toHaveLength(0);
  });
});

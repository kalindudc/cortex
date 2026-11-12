// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, type PluginRpcTestHandlers, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ComposerMention } from "@get-bb/plugin-sdk/app";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
  type NewThreadMemory,
  PENDING_MENTION_PROVIDER,
  PENDING_UNKNOWN,
  type PendingChange,
  type PendingSelection,
  pendingContextRpcContract,
  pendingSelectionSchema,
} from "./pending-context-contract";
import { type SectionEligibility, sectionRpcContract } from "./section-contract";
import { NewThreadContextBanner, newThreadRowKey, withoutMention } from "./ui/new-thread";
import { readComposeSection, REMEMBER_MS, rememberComposeSection } from "./ui/new-thread-section";
import type { Knowledge, Workstream } from "./ui/types";
import { workstreamRpcContract } from "./workstream-contract";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
const contract = { ...workstreamRpcContract, ...sectionRpcContract, ...pendingContextRpcContract };
const now = "2026-11-11T12:00:00.000Z";
const actor = { id: "kal", type: "human" } as const;
const PLUGIN = "cortex";
const applicability = { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } } as const;
const ws: Workstream = { id: "ws_envoy", name: "Envoy cluster-service", description: "", revision: 1, archived: false, actor, createdAt: now, updatedAt: now };
const knowledge = (id: string, title: string, extra: Partial<Knowledge> = {}): Knowledge => ({ id, workstreamId: ws.id, subject: id, title, text: `${title}, as saved.`, kind: "directive", state: "approved", facet: "orientation", applicability, sources: [], revision: 1, actor, createdAt: now, updatedAt: now, expiresAt: null, approval: { actor, at: now }, supersedes: [], supersededBy: null, conflicts: [], ...extra });
const ports = knowledge("kn_ports", "Admin port is 9901");
const deploy = knowledge("kn_deploy", "Deploy through the pipeline");
const disputed = knowledge("kn_disputed", "Staging uses the new bootstrap", { kind: "finding", state: "disputed" });
const row = (k: Knowledge, text = k.text, origin: "canonical" | "thread-only" = "canonical") => ({ knowledge: k, text, origin, overrideActor: null, estimatedTokens: 90 });
const memory: NewThreadMemory = { mode: "write", summary: { cached: true, ids: [1043, 980], chars: 800, shortened: false }, lookup: { maxTasks: 5, providers: ["pi", "claude-code", "codex"] } };

let app: Awaited<ReturnType<typeof loadPluginApp>>;
beforeAll(async () => {
  app = await loadPluginApp(() => import("./app"));
});
// Most tests read the opened row; the folded chip, the default, has its own tests below.
const ROW_KEY = newThreadRowKey(PLUGIN);
beforeEach(() => { localStorage.setItem(ROW_KEY, "open"); });
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
});

type Fixture = { failPreview?: boolean; empty?: boolean; status?: SectionEligibility["status"]; memory?: NewThreadMemory; pendingDraftKey?: string; problem?: string | null };
function backend(options: Fixture = {}) {
  let pending: PendingSelection | null = null;
  const base = (sectionId: string): SectionEligibility => sectionId === "sec_envoy"
    ? { computedAt: now, status: options.status ?? "ready", error: options.status === "over-budget" ? "Thread context needs approximately 520 tokens; budget is 400." : null, entries: options.empty ? [] : [row(deploy), row(ports)], notices: [{ id: disputed.id, revision: 1, reason: "disputed", sources: [], estimatedTokens: 30 }], exclusions: [{ id: disputed.id, reason: "disputed" }], exactText: "brief", estimatedTokens: options.status === "over-budget" ? 460 : 380, budgetTokens: 400 }
    : { computedAt: now, status: "unbound", error: null, entries: [], notices: [], exclusions: [], exactText: "", estimatedTokens: 0, budgetTokens: 1000 };
  const applied = (b: SectionEligibility, changes: PendingChange[]): SectionEligibility => ({
    ...b,
    status: b.status === "over-budget" && b.estimatedTokens - 90 * changes.filter(c => c.excluded).length <= b.budgetTokens ? "ready" : b.status,
    entries: b.entries.flatMap(e => {
      const c = changes.find(x => x.knowledgeId === e.knowledge.id);
      return c?.excluded ? [] : c ? [row(e.knowledge, c.text!, "thread-only")] : [e];
    }),
    exclusions: [...b.exclusions, ...changes.filter(c => c.excluded).map(c => ({ id: c.knowledgeId, reason: "left out of this thread" }))],
    estimatedTokens: b.estimatedTokens - 90 * changes.filter(c => c.excluded).length,
  });
  const rpc: Partial<PluginRpcTestHandlers<typeof contract>> = {
    sectionBindings: () => ({ bindings: [
      { key: "sec_envoy", revision: 3, binding: { workstreamId: ws.id, topic: null, budgetTokens: 400, requiredKnowledgeIds: [] } },
      { key: "sec_otlp", revision: 0, binding: null },
    ] }),
    knowledgeShow: ({ id }) => ({ entry: [ports, deploy, disputed].find(k => k.id === id)!, workstream: ws }),
    newThreadContext: ({ sectionId, pendingId }) => {
      if (options.failPreview) throw new Error("Preview temporarily unavailable");
      const record = pendingId && pending?.id === pendingId ? pending : null;
      const problem = options.problem !== undefined ? options.problem : pendingId && !record ? PENDING_UNKNOWN : record && record.sectionId !== sectionId ? "These Cortex changes were made for another section. Pick that section again, or remove the Cortex pill." : null;
      if (sectionId === null) return { section: null, sectionSummaries: [], base: null, applied: null, pending: record ? pendingSelectionSchema.parse(record) : null, pendingProblem: problem, memory: options.memory ?? memory };
      const b = base(sectionId);
      return {
        section: { id: sectionId, requiredKnowledgeIds: ["kn_ports"], bindingRevision: sectionId === "sec_envoy" ? 3 : 0, binding: sectionId === "sec_envoy" ? { workstreamId: ws.id, workstreamName: ws.name, topic: null } : null },
        base: b,
        applied: record && problem === null ? applied(b, record.changes) : null,
        pending: record ? pendingSelectionSchema.parse(record) : null,
        sectionSummaries: [{ sectionId: "sec_envoy", entries: 2, estimatedTokens: 380, budgetTokens: 400 }],
        pendingProblem: problem,
        memory: options.memory ?? memory,
      };
    },
    pendingContextSet: input => {
      if (input.changes.length === 0) {
        pending = null;
        return { pending: null };
      }
      pending = { id: pending?.id ?? "6f1d2a9e-1111-4c3b-9d2e-000000000001", projectId: input.projectId, sectionId: input.sectionId, workstreamId: ws.id, bindingRevision: input.expectedBindingRevision, draftKey: options.pendingDraftKey ?? input.draftKey, actor, caller: "client", singleUse: true, createdAt: now, updatedAt: now, expiresAt: now, changes: input.changes, usedBy: null, usedAt: null };
      return { pending: pendingSelectionSchema.parse(pending) };
    },
  };
  return {
    rpc: rpc as PluginRpcTestHandlers<typeof contract>,
    experimental_rpcContract: contract,
    pluginId: PLUGIN,
    composer: { scope: { kind: "new-thread" as const, projectId: "project-1" }, text: "Look at the admin port ", mentions: [] as ComposerMention[] },
    sidebarThreads: { sections: [
      { id: "sec_otlp", name: "OTLP routing", createdAt: 0, updatedAt: 0 },
      { id: "sec_envoy", name: "Envoy cluster-service", createdAt: 0, updatedAt: 0 },
    ], threads: [] },
    seed: (record: PendingSelection) => { pending = record; },
  };
}

const render = (options = backend()) => renderSlot({ component: NewThreadContextBanner }, {}, options);
const calls = (slot: ReturnType<typeof render>, method: string) => slot.inspection.rpcCalls.filter(c => c.method === method);
const summary = (slot: ReturnType<typeof render>) => slot.container.querySelector("[data-part=Summary]")?.textContent ?? "";
async function pick(slot: ReturnType<typeof render>, name: string) {
  const trigger = slot.getByRole("button", { name: /^File this thread in:/ });
  await act(async () => { fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" }); fireEvent.keyDown(trigger, { key: "Enter" }); });
  fireEvent.click(await slot.findByRole("menuitem", { name: new RegExp(name) }));
}
async function expand(slot: ReturnType<typeof render>) {
  fireEvent.click(slot.getByRole("button", { name: "What this thread starts with" }));
  return slot.findByRole("list", { name: "Goes in automatically when you send" });
}
const rememberEnvoy = () => rememberComposeSection("sec_envoy");

test("registered only on new-thread, with a keyboard plus-menu path", async () => {
  expect(app.composerCustomizations[0]?.scopes).toEqual(["new-thread"]);
  const slot = renderSlot({ component: NewThreadContextBanner }, {}, { ...backend(), composer: { scope: { kind: "thread", threadId: "thr_aaaaaaaa" } } });
  expect(slot.container.querySelector("[data-part=NewThreadContext]")).toBeNull();
  cleanup(); rememberEnvoy(); localStorage.removeItem(ROW_KEY);
  const live = render(); expect(await live.findByRole("button", { name: "Show Cortex context" })).toBeTruthy();
  const item = app.composerCustomizations[0]?.plusMenu?.[0];
  expect(item?.label).toBe("What this thread starts with");
  await act(async () => { await item?.run({ composer: live.inspection.composer as never }); });
  expect(await live.findByRole("list", { name: "Goes in automatically when you send" })).toBeTruthy();
  expect(summary(live)).toBe("2 entries · ~380/400 tokens");
  expect(localStorage.getItem(ROW_KEY)).toBe("open");
});

test("folds to a Cortex chip on the left by default and remembers the choice", async () => {
  localStorage.removeItem(ROW_KEY); rememberEnvoy();
  const slot = render();
  const chip = await slot.findByRole("button", { name: "Show Cortex context" });
  expect(slot.container.querySelector("[data-part=NewThreadContext]")?.classList.contains("nt-folded")).toBe(true);
  expect(slot.queryByRole("button", { name: "What this thread starts with" })).toBeNull();
  fireEvent.click(chip);
  await waitFor(() => expect(summary(slot)).toBe("2 entries · ~380/400 tokens"));
  expect(localStorage.getItem(ROW_KEY)).toBe("open");
  fireEvent.click(slot.getByRole("button", { name: "Hide Cortex context" }));
  expect(await slot.findByRole("button", { name: "Show Cortex context" })).toBeTruthy();
  expect(localStorage.getItem(ROW_KEY)).toBe("folded");
  cleanup(); rememberEnvoy();
  expect(await render().findByRole("button", { name: "Show Cortex context" })).toBeTruthy();
});

test("the folded chip counts this thread's changes", async () => {
  const options = seededDraft(); localStorage.setItem(ROW_KEY, "folded");
  const slot = render(options);
  expect(await slot.findByRole("button", { name: "Show Cortex context · 1 change for this thread" })).toBeTruthy();
});

test("a refused send opens a folded row and it cannot fold until resolved", async () => {
  const options = seededDraft({ refusedPlacement: { sectionId: "sec_otlp" } }); localStorage.setItem(ROW_KEY, "folded");
  const slot = render(options);
  expect(await slot.findByText("Not sent · bb filed it in OTLP routing")).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Hide Cortex context" })).toBeNull();
  expect(localStorage.getItem(ROW_KEY)).toBe("folded");
});

test("unknown section shows memory, quick picks and after-send matching tasks", async () => {
  const slot = render();
  await waitFor(() => expect(summary(slot)).toBe("Cortex memory · brief unknown"));
  fireEvent.click(slot.getByRole("button", { name: "What this thread starts with" }));
  expect(await slot.findByText("File this thread in · sections that share a brief")).toBeTruthy();
  expect(slot.getByText("Memory summary · 2 streams · ~200")).toBeTruthy();
  expect(slot.getByText("@1043")).toBeTruthy();
  expect(slot.getByText("after send")).toBeTruthy();
  await pick(slot, "Envoy cluster-service");
  await waitFor(() => expect(summary(slot)).toBe("2 entries · ~380/400 tokens"));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toCompose", options: { projectId: "project-1", placement: { sectionId: "sec_envoy", pinned: false }, focusPrompt: true } });
  expect(slot.inspection.composer.draft.text).toBe("Look at the admin port ");
});

test("loading and failed preview stay visible, and Retry recovers", async () => {
  rememberEnvoy(); const fixture = { failPreview: true }; const slot = render(backend(fixture));
  expect(summary(slot)).toBe("Reading the brief…");
  expect(await slot.findByRole("button", { name: "Retry" })).toBeTruthy();
  expect(summary(slot)).toBe("Cortex couldn't read the brief");
  fixture.failPreview = false;
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(summary(slot)).toBe("2 entries · ~380/400 tokens"));
});

test("section menu shows sizes and puts sharing sections first", async () => {
  rememberEnvoy(); const slot = render();
  await waitFor(() => expect(summary(slot)).toBe("2 entries · ~380/400 tokens"));
  const trigger = slot.getByRole("button", { name: /^File this thread in:/ });
  await act(async () => { fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" }); fireEvent.keyDown(trigger, { key: "Enter" }); });
  expect((await slot.findAllByRole("menuitem")).map(x => x.textContent)).toEqual(["Envoy cluster-service2 · ~380", "OTLP routingNothing shared", "Clear sectionoutside any section"]);
});

test("Clear section files the thread outside sections and offers to put changes back", async () => {
  rememberEnvoy(); const slot = render(); const list = await expand(slot);
  fireEvent.click(within(list).getByRole("button", { name: "Leave out: Deploy through the pipeline" }));
  await waitFor(() => expect(slot.inspection.composer.draft.mentions).toHaveLength(1));
  await pick(slot, "Clear section.*drops 1 change");
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toCompose", options: { projectId: "project-1", placement: { sectionId: null, pinned: false }, focusPrompt: true } });
  await waitFor(() => expect(summary(slot)).toBe("Cortex memory only"));
  expect(slot.getByRole("button", { name: "File this thread in: No section" })).toBeTruthy();
  expect(slot.queryByText("picked in Cortex")).toBeNull();
  expect(readComposeSection()).toBeNull();
  expect(slot.inspection.composer.draft.mentions).toHaveLength(0);
  fireEvent.click(await slot.findByRole("button", { name: "Put 1 change back" }));
  await waitFor(() => expect(slot.inspection.composer.draft.mentions).toHaveLength(1));
  await waitFor(() => expect(summary(slot)).toBe("1 entry · ~290/400 tokens"));
});

test("an unknown section has nothing to clear", async () => {
  const slot = render();
  await waitFor(() => expect(summary(slot)).toBe("Cortex memory · brief unknown"));
  const trigger = slot.getByRole("button", { name: /^File this thread in:/ });
  await act(async () => { fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" }); fireEvent.keyDown(trigger, { key: "Enter" }); });
  await slot.findAllByRole("menuitem");
  expect(slot.queryByRole("menuitem", { name: /Clear section/ })).toBeNull();
});

test("remembered placement is labelled visibly and cleared on leaving", async () => {
  rememberEnvoy(); const slot = render();
  expect(await slot.findByText("picked in Cortex")).toBeTruthy();
  expect(await slot.findByText("2 entries · ~380/400 tokens")).toBeTruthy();
  slot.unmount(); expect(readComposeSection()).toBeNull();
});

test("remembered placement expires after thirty minutes", () => {
  rememberComposeSection("sec_envoy", Date.now() - REMEMBER_MS - 1);
  expect(readComposeSection()).toBeNull();
});

test("expanded entries, held notices, fix links and caveat stay reachable", async () => {
  rememberEnvoy(); const slot = render(); const list = await expand(slot);
  expect(within(list).getAllByRole("listitem").map(li => li.getAttribute("data-knowledge-id"))).toEqual(["kn_deploy", "kn_ports"]);
  const held = await slot.findByRole("list", { name: "Held back" });
  const fix = await within(held).findByRole("button", { name: "Fix in Cortex: Staging uses the new bootstrap" });
  fireEvent.click(fix);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "cortex", options: { subPath: "sections/sec_envoy/brief/kn_disputed" } });
  expect(slot.getByText("Changes apply to this thread only")).toBeTruthy();
  expect(slot.getByRole("button", { name: "Copy exact text" })).toBeTruthy();
  fireEvent.keyDown(list, { key: "Escape" });
  expect(slot.queryByRole("list", { name: "Goes in automatically when you send" })).toBeNull();
  expect(document.activeElement).toBe(slot.getByRole("button", { name: "What this thread starts with" }));
});

test("unshared section keeps a memory-only row and sharing fix", async () => {
  const slot = render(); await pick(slot, "OTLP routing");
  await waitFor(() => expect(summary(slot)).toBe("Cortex memory · nothing shared here"));
  fireEvent.click(slot.getByRole("button", { name: "Share context" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "cortex", options: { subPath: "sections/sec_otlp" } });
});

test("over-budget row exposes Make it fit without another click to find it", async () => {
  rememberEnvoy(); const slot = render(backend({ status: "over-budget" }));
  fireEvent.click(await slot.findByRole("button", { name: "Make it fit" }));
  expect(await slot.findByRole("list", { name: "Goes in automatically when you send" })).toBeTruthy();
  expect(slot.getByRole("alert").textContent).toMatch(/no brief goes in/);
});

test("over-budget entries are hypothetical until leaving one out makes the brief fit", async () => {
  rememberEnvoy(); const slot = render(backend({ status: "over-budget" })); const list = await expand(slot);
  expect(slot.getByText("Would go in · 2")).toBeTruthy();
  expect(slot.getAllByRole("img").every(img => !img.getAttribute("aria-label")?.includes("entries go in"))).toBe(true);
  fireEvent.click(within(list).getByRole("button", { name: "Leave out: Deploy through the pipeline" }));
  expect(await slot.findByText("Fits: ~370 / 400")).toBeTruthy();
  expect(slot.getByText("Goes in · 1")).toBeTruthy();
});

test("an empty brief stays visible and read-only memory has no summary", async () => {
  rememberEnvoy(); const slot = render(backend({ empty: true, memory: { ...memory, mode: "read" } }));
  await waitFor(() => expect(summary(slot)).toBe("brief empty · + memory"));
  await expand(slot);
  expect(slot.getByText("No approved knowledge in this brief yet.")).toBeTruthy();
  expect(slot.queryByText(/Memory summary/)).toBeNull();
  expect(slot.getByText("after send")).toBeTruthy();
});

test("memory off previews what would go in but offers no edits", async () => {
  rememberEnvoy(); const slot = render(backend({ memory: { ...memory, mode: "off", lookup: null } }));
  await waitFor(() => expect(summary(slot)).toBe("nothing from Cortex · memory off"));
  expect(slot.getByRole("button", { name: "Memory settings" })).toBeTruthy();
  await expand(slot); expect(slot.getByText("Would go in · 2")).toBeTruthy();
  expect(slot.queryByRole("button", { name: /^Edit for this thread:/ })).toBeNull();
});

test("required entry cannot be left out", async () => {
  rememberEnvoy(); const slot = render(); const list = await expand(slot);
  const lock = within(list).getByRole("button", { name: "Leave out: Admin port is 9901" });
  expect(lock.getAttribute("aria-disabled")).toBe("true"); fireEvent.click(lock);
  expect(calls(slot, "pendingContextSet")).toHaveLength(0);
  expect(within(list).getByLabelText("Required").getAttribute("title")).toMatch(/would send no brief/);
});

test("leave out and Put back change only this draft and keep today's pill label", async () => {
  rememberEnvoy(); const slot = render(); const list = await expand(slot);
  fireEvent.click(within(list).getByRole("button", { name: "Leave out: Deploy through the pipeline" }));
  await waitFor(() => expect(slot.inspection.composer.draft.mentions).toHaveLength(1));
  expect(slot.inspection.composer.draft.mentions[0]).toMatchObject({ label: "Cortex: 1 change to the Envoy cluster-service brief" });
  await waitFor(() => expect(summary(slot)).toBe("1 entry · ~290/400 tokens"));
  fireEvent.click(within(list).getByRole("button", { name: "Put back: Deploy through the pipeline" }));
  await waitFor(() => expect(slot.inspection.composer.draft.mentions).toHaveLength(0));
  expect(slot.inspection.composer.draft.text).toBe("Look at the admin port ");
});

test("Enter and Cmd+Enter save; Escape cancels; both return focus to Edit", async () => {
  rememberEnvoy(); const slot = render(); const list = await expand(slot);
  const edit = () => within(list).getByRole("button", { name: "Edit for this thread: Admin port is 9901" });
  fireEvent.click(edit()); const editor = within(list).getByRole("textbox");
  await waitFor(() => expect(document.activeElement).toBe(editor));
  fireEvent.change(editor, { target: { value: "discard me" } }); fireEvent.keyDown(editor, { key: "Escape" });
  expect(calls(slot, "pendingContextSet")).toHaveLength(0);
  await waitFor(() => expect(document.activeElement).toBe(edit()));
  for (const metaKey of [false, true]) {
    fireEvent.click(edit()); const field = within(list).getByRole("textbox");
    fireEvent.change(field, { target: { value: metaKey ? "port 9903" : "port 9902" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(field, { key: "Enter", metaKey });
    await waitFor(() => expect(document.activeElement).toBe(edit()));
    await waitFor(() => expect(within(list).getByText(metaKey ? "port 9903" : "port 9902")).toBeTruthy());
  }
  expect(calls(slot, "pendingContextSet")).toHaveLength(2);
  fireEvent.click(slot.getByRole("button", { name: "Reset all" }));
  await waitFor(() => expect(slot.inspection.composer.draft.mentions).toHaveLength(0));
  expect(calls(slot, "pendingContextSet").at(-1)!.input).toMatchObject({ changes: [] });
});

test("removing a pill offers to put its changes back; section switch warns inline", async () => {
  rememberEnvoy(); const slot = render(); const list = await expand(slot);
  fireEvent.click(within(list).getByRole("button", { name: "Leave out: Deploy through the pipeline" }));
  await waitFor(() => expect(slot.inspection.composer.draft.mentions).toHaveLength(1));
  await pick(slot, "OTLP routing.*drops 1 change");
  expect(await slot.findByRole("button", { name: "Put 1 change back" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Put 1 change back" }));
  await waitFor(() => expect(slot.inspection.composer.draft.mentions).toHaveLength(1));
  await waitFor(() => expect(summary(slot)).toBe("1 entry · ~290/400 tokens"));
});

function seededDraft(extra: Partial<PendingSelection> = {}) {
  const options = backend();
  const draftKey = render(options).inspection.composer.key;
  cleanup(); rememberEnvoy();
  const record: PendingSelection = {
    id: "6f1d2a9e-1111-4c3b-9d2e-000000000009", projectId: "project-1",
    sectionId: "sec_envoy", workstreamId: ws.id, bindingRevision: 3, draftKey, actor,
    caller: "client", singleUse: true, createdAt: now, updatedAt: now, expiresAt: now,
    changes: [{ knowledgeId: "kn_deploy", canonicalRevision: 1, excluded: true, text: null }],
    usedBy: null, usedAt: null, ...extra,
  };
  options.seed(record);
  const label = "Cortex: 1 change";
  return { ...options, composer: { ...options.composer, text: label + " hello", mentions: [{ kind: "plugin" as const, pluginId: PLUGIN, provider: PENDING_MENTION_PROVIDER, id: record.id, label, from: 0, to: label.length }] } };
}

test("refused row names actual placement and File in restores it without losing pill", async () => {
  const slot = render(seededDraft({ refusedPlacement: { sectionId: "sec_otlp" } }));
  expect(await slot.findByText("Not sent · bb filed it in OTLP routing")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "File in Envoy cluster-service" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toCompose", options: { projectId: "project-1", placement: { sectionId: "sec_envoy", pinned: false }, focusPrompt: true } });
  expect(slot.inspection.composer.draft.mentions).toHaveLength(1);
  await waitFor(() => expect(slot.queryByText(/Not sent/)).toBeNull());
});

test("refused Remove pill follows actual section; Put back restores section and changes together", async () => {
  const slot = render(seededDraft({ refusedPlacement: { sectionId: "sec_otlp" } }));
  fireEvent.click(await slot.findByRole("button", { name: "Remove pill" }));
  await waitFor(() => expect(summary(slot)).toBe("Cortex memory · nothing shared here"));
  expect(slot.inspection.composer.draft.text).toBe(" hello");
  fireEvent.click(slot.getByRole("button", { name: "Put 1 change back" }));
  await waitFor(() => expect(slot.inspection.composer.draft.mentions).toHaveLength(1));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toCompose", options: { projectId: "project-1", placement: { sectionId: "sec_envoy", pinned: false }, focusPrompt: true } });
});

test("refusal with unknown actual section uses the honest fallback", async () => {
  const slot = render(seededDraft({ refusedPlacement: { sectionId: null } }));
  expect(await slot.findByText("Not sent · bb filed it in another section")).toBeTruthy();
});

test("copied pill is removed, not made restorable on this draft", async () => {
  const slot = render(seededDraft({ draftKey: "another-draft" }));
  expect((await slot.findByRole("status")).textContent).toMatch(/copied from another draft/);
  await waitFor(() => expect(slot.inspection.composer.draft.mentions).toHaveLength(0));
  expect(slot.queryByRole("button", { name: "Put 1 change back" })).toBeNull();
});

test("restored draft follows its pill section and keeps its recorded changes", async () => {
  const options = seededDraft(); sessionStorage.clear();
  const slot = render(options);
  await waitFor(() => expect(summary(slot)).toBe("1 entry · ~290/400 tokens"));
  expect(slot.inspection.composer.draft.mentions).toHaveLength(1);
});

test("unknown pill is removable and cannot supply context", async () => {
  const options = backend();
  const pill = { kind: "plugin" as const, pluginId: PLUGIN, provider: PENDING_MENTION_PROVIDER, id: "not-a-real-id", label: "Cortex: 9 changes", from: 0, to: 17 };
  const slot = render({ ...options, composer: { ...options.composer, text: "Cortex: 9 changes hello", mentions: [pill] } });
  expect((await slot.findByRole("alert")).textContent).toContain(PENDING_UNKNOWN);
  fireEvent.click(slot.getByRole("button", { name: "Remove pill" }));
  await waitFor(() => expect(slot.inspection.composer.draft.text).toBe(" hello"));
});

test("withoutMention shifts later pills back by the removed length", () => {
  const pill = { kind: "section" as const, sectionId: "s", label: "AB", from: 2, to: 4 };
  const later = { kind: "section" as const, sectionId: "t", label: "CD", from: 6, to: 8 };
  expect(withoutMention({ text: "x AB y CD", mentions: [pill, later], attachments: [] }, pill)).toEqual({ text: "x  y CD", mentions: [{ ...later, from: 4, to: 6 }] });
});

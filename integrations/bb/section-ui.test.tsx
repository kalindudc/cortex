// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { experimental_makePanelController } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { sectionRpcContract, type Section, type SectionEligibility } from "./section-contract";
import { workstreamRpcContract } from "./workstream-contract";
import type { Knowledge, Workstream } from "./ui/types";
import { toast } from "sonner";
import { CaptureDialog, TakeawayPanel } from "./ui/takeaway";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
const contract = { ...workstreamRpcContract, ...sectionRpcContract };
const threadId = "thr_aaaaaaaa";
const now = "2026-11-11T12:00:00.000Z";
const actor = { id: "kal", type: "human" } as const;
const ws: Workstream = { id: "ws_envoy", name: "Envoy cluster-service", description: "", revision: 7, archived: false, actor, createdAt: now, updatedAt: now };
const entry: Knowledge = { id: "kn_bootstrap", workstreamId: ws.id, subject: "bootstrap", title: "Staging uses the new bootstrap", text: "Staging uses the new bootstrap, not production.", kind: "finding", state: "candidate", facet: "orientation", applicability: { environment: { mode: "unknown" }, host: { mode: "unknown" } }, sources: [{ ref: `${threadId}#31`, excerpt: "staging is on the new bootstrap", authorType: "agent", observedAt: now }], revision: 1, actor: { id: `bb-${threadId}`, type: "agent" }, createdAt: now, updatedAt: now, expiresAt: null, approval: null, supersedes: [], conflicts: [], supersededBy: null };
const mark = { status: "unmarked", originalTitle: null, decoratedTitle: null, error: null } as const;
const section = (id = "sec_envoy", bound = true): Section => ({ id, name: id === "sec_envoy" ? "Envoy cluster-service" : "OTLP routing", canonicalName: id === "sec_envoy" ? "Envoy cluster-service" : "OTLP routing", threadCount: 1, marker: mark, connectionJob: null, binding: { key: id, revision: bound ? 1 : 0, binding: bound ? { workstreamId: ws.id, topic: null, budgetTokens: 400, requiredKnowledgeIds: [] } : null } });
let app: Awaited<ReturnType<typeof loadPluginApp>>;
beforeAll(async () => { app = await loadPluginApp(() => import("./app")); });
afterEach(cleanup);

function fixture(bound = true) {
  let current = entry;
  let fail = false;
  const sections = [section("sec_envoy", bound), section("sec_otlp", false)];
  const eligibility: SectionEligibility = { computedAt: now, status: bound ? "ready" : "unbound", error: null, entries: [], notices: [], exclusions: [], exactText: "", estimatedTokens: 0, budgetTokens: 400 };
  const rpc: Partial<PluginRpcTestHandlers<typeof contract>> = {
    sectionList: () => ({ sections }),
    sectionCaptureJobs: ({ limit = 20, offset = 0 }) => ({ jobs: [], total: 0, limit, offset }),
    sectionDetail: ({ sectionId }: { sectionId: string }) => {
      if (fail) throw new Error("Refresh unavailable");
      return { section: sections.find(s => s.id === sectionId)!, threads: [{ id: threadId, name: "Investigate the staging bootstrap" }], eligibility, review: { items: bound ? [{ entry: current, workstream: ws, hints: [] }] : [], total: bound ? 1 : 0, limit: 50, offset: 0 } };
    },
    workstreamList: () => ({ workstreams: [ws], total: 1, limit: 100, offset: 0 }),
    reviewQueue: () => ({ items: [], total: 0, limit: 100, offset: 0 }),
    sectionBindings: () => ({ bindings: sections.map(s => s.binding) }),
    knowledgeShow: () => ({ entry: current, workstream: ws }),
    sectionConnect: (input: { requestId: string; sectionId: string }) => ({ requestId: input.requestId, sectionId: input.sectionId, workstreamId: ws.id, status: "connected", expectedRevision: 0, bindingRevision: 1, error: null, marker: mark }),
    sectionCandidateAccept: () => ({ outcome: "updated", entry: { ...current, revision: 2, state: "approved", approval: { actor, at: now } } }),
    sectionCandidateEdit: () => ({ outcome: "updated", entry: current }),
    sectionCapture: (input: { requestId: string; sectionId: string }) => ({ requestId: input.requestId, sectionId: input.sectionId, intendedKnowledgeId: entry.id, knowledgeId: entry.id, status: "saved", entry: current, error: null }),
  };
  const options = { rpc: rpc as PluginRpcTestHandlers<typeof contract>, experimental_rpcContract: contract, sidebarThreads: { sections: sections.map(s => ({ id: s.id, name: s.name, createdAt: Date.parse(now), updatedAt: Date.parse(now) })), threads: [] } };
  return { sections, options, change: (next: Knowledge) => { current = next; }, fail: () => { fail = true; } };
}
function renderSection(bound = true) {
  const backend = fixture(bound);
  const slot = renderSlot(app.navPanels[0]!, { subPath: "sections/sec_envoy" }, backend.options);
  return { backend, slot };
}
const calls = (slot: ReturnType<typeof renderSlot>, method: string) => slot.inspection.rpcCalls.filter(call => call.method === method);

describe("approved section-first flow", () => {
  test("message selection opens a sourced capture with exact sequence and quote, not client-supplied attribution", () => {
    const openTab = vi.fn(() => true);
    const action = app.messageActions.find(action => action.id === "cortex-save-takeaway")!;
    action.run({ threadId, message: { id: "msg_staging", threadId, role: "assistant", text: "Production is unchanged; staging is on the new bootstrap.", experimental_messageSeq: 31, sourceSeqEnd: 32 }, selectedText: "staging is on the new bootstrap", experimental_panel: experimental_makePanelController({ openTab }), composer: null });
    expect(openTab).toHaveBeenCalledWith({ tab: { id: "cortex-takeaway", context: { kind: "thread" }, availability: "action" }, params: { source: { kind: "message", threadId, messageId: "msg_staging", messageSeq: 31, quote: "staging is on the new bootstrap" }, text: "staging is on the new bootstrap" } });
  });

  test("oversized selected text is refused without opening or clipping a sourced capture", () => {
    const openTab = vi.fn(() => true);
    const action = app.messageActions.find(action => action.id === "cortex-save-takeaway")!;
    action.run({ threadId, message: { id: "msg_long", threadId, role: "assistant", text: "x".repeat(9000), experimental_messageSeq: 31, sourceSeqEnd: 32 }, selectedText: "x".repeat(8193), experimental_panel: experimental_makePanelController({ openTab }), composer: null });
    expect(openTab).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Select between 1 and 8,192 characters, or write a manual takeaway without a message source.");
  });

  test("a long whole-message source refusal keeps the edited takeaway and original source", async () => {
    const backend = fixture();
    const original = "Verified original source. ".repeat(400);
    const refusal = "Message source exceeds 8192 characters. Select a shorter quote or write a manual takeaway.";
    backend.options.rpc.sectionCapture = () => { throw new Error(refusal); };
    const source = { kind: "message" as const, threadId, messageId: "msg_long", messageSeq: 31 };
    const slot = renderSlot({ component: CaptureDialog }, { section: section(), seed: { source, text: original }, onClose: vi.fn() }, backend.options);
    const dialog = await slot.findByRole("dialog");
    const field = within(dialog).getByRole("textbox", { name: "Text" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "My shorter takeaway draft." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save for review" }));
    expect(await within(dialog).findByText(refusal)).toBeTruthy();
    expect(slot.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByRole("textbox", { name: "Text" })).toBe(field);
    expect(field.value).toBe("My shorter takeaway draft.");
    expect(dialog.querySelector("blockquote")!.textContent).toBe(original);
    expect(calls(slot, "sectionCapture")[0]!.input).toMatchObject({ source, text: "My shorter takeaway draft." });
    expect(calls(slot, "knowledgePropose")).toHaveLength(0);
    expect(calls(slot, "sectionCaptureRetry")).toHaveLength(0);
  });

  test("sourced capture keeps unknown applicability for review, with no separate propose/approval calls", async () => {
    const backend = fixture();
    const slot = renderSlot({ component: CaptureDialog }, { section: section(), seed: { source: { kind: "message" as const, threadId, messageId: "msg_staging", messageSeq: 31, quote: "staging is on the new bootstrap" }, text: "staging is on the new bootstrap" }, onClose: vi.fn() }, backend.options);
    const dialog = await slot.findByRole("dialog", { name: "Save as takeaway" });
    expect((within(dialog).getByRole("textbox", { name: "Text" }) as HTMLTextAreaElement).value).toBe("staging is on the new bootstrap");
    expect(within(dialog).getByRole("button", { name: "Save and accept" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save for review" }));
    await waitFor(() => expect(calls(slot, "sectionCapture")).toHaveLength(1));
    expect(calls(slot, "sectionCapture")[0]!.input).toMatchObject({ sectionId: "sec_envoy", expectedBindingRevision: 1, source: { kind: "message", threadId, messageId: "msg_staging", messageSeq: 31, quote: "staging is on the new bootstrap" }, mode: "review", applicability: { environment: { mode: "unknown" }, host: { mode: "unknown" } } });
    expect(calls(slot, "knowledgePropose")).toHaveLength(0);
    expect(calls(slot, "knowledgeTransition")).toHaveLength(0);
  });

  test("an uncertain capture keeps its original intent frozen and retries the same request", async () => {
    const backend = fixture();
    let first = true;
    backend.options.rpc.sectionCapture = input => {
      if (first) { first = false; throw new Error("Write outcome unknown"); }
      return { requestId: input.requestId, sectionId: input.sectionId, intendedKnowledgeId: entry.id, knowledgeId: entry.id, status: "saved", entry, error: null };
    };
    const slot = renderSlot({ component: CaptureDialog }, { section: section(), seed: { source: { kind: "manual" as const, threadId }, text: "My source-free takeaway." }, onClose: vi.fn() }, backend.options);
    const dialog = await slot.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save for review" }));
    await within(dialog).findByText("Write outcome unknown");
    expect((within(dialog).getByRole("textbox", { name: "Text" }) as HTMLTextAreaElement).matches(":disabled")).toBe(true);
    expect(within(dialog).getByRole("radio", { name: "Everywhere" }).matches(":disabled")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(calls(slot, "sectionCapture")).toHaveLength(2));
    expect(calls(slot, "sectionCapture")[1]!.input).toEqual(calls(slot, "sectionCapture")[0]!.input);
  });

  test("persisted malformed quotes are rejected, while explicit manual sources remain manual", async () => {
    const backend = fixture();
    const bad = renderSlot({ component: TakeawayPanel }, { threadId, environment: null, params: { source: { kind: "message", threadId, messageId: "msg_staging", messageSeq: 31, quote: 5 }, text: "unverified quote" } }, backend.options);
    expect(await bad.findByRole("alert")).toHaveProperty("textContent", "The saved message source is invalid or belongs to another thread. Save from the original message again.");
    bad.unmount();
    const good = renderSlot({ component: TakeawayPanel }, { threadId, environment: null, params: { source: { kind: "manual", threadId }, text: "Written by me" } }, backend.options);
    expect(await good.findByText("This thread is not in a section. Choose a section in bb before saving shared context.")).toBeTruthy();
    expect(good.queryByRole("alert")).toBeNull();
  });

  test("a durable failed save offers retry by original request, dismiss without deleting, and a canonical result link", async () => {
    const backend = fixture();
    const requestId = "9f331ab4-048b-47e5-9309-a33547db2e0d";
    const job = { requestId, sectionId: "sec_envoy", intendedKnowledgeId: entry.id, knowledgeId: entry.id, status: "failed" as const, entry, error: "Write outcome needs recovery", workstreamId: ws.id, expectedBindingRevision: 1, intent: { title: entry.title, kind: entry.kind, applicability: entry.applicability, mode: "review" as const }, sources: entry.sources };
    backend.options.rpc.sectionCaptureJobs = ({ limit = 20, offset = 0 }) => ({ jobs: [job], total: 1, limit, offset });
    backend.options.rpc.sectionCaptureRetry = () => ({ requestId, sectionId: job.sectionId, intendedKnowledgeId: entry.id, knowledgeId: entry.id, status: "saved", entry, error: null });
    backend.options.rpc.sectionCaptureDismiss = ({ requestId }) => ({ requestId, dismissed: true });
    const slot = renderSlot(app.navPanels[0]!, { subPath: "sections/sec_envoy" }, backend.options);
    const recovery = await slot.findByRole("region", { name: "Unfinished takeaway saves" });
    fireEvent.click(within(recovery).getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(calls(slot, "sectionCaptureRetry")).toHaveLength(1));
    expect(calls(slot, "sectionCaptureRetry")[0]!.input).toEqual({ requestId });
    expect(await within(recovery).findByRole("button", { name: /Save confirmed/ })).toBeTruthy();
    fireEvent.click(within(recovery).getByRole("button", { name: "Dismiss retry" }));
    await waitFor(() => expect(calls(slot, "sectionCaptureDismiss")).toHaveLength(1));
    expect(calls(slot, "knowledgeTransition")).toHaveLength(0);
  });
  test.each([["sec_envoy", true], ["sec_otlp", false]] as const)("New thread uses section %s without replacing a native draft", async (sectionId, bound) => {
    const backend = fixture(bound);
    const slot = renderSlot(app.navPanels[0]!, { subPath: `sections/${sectionId}` }, backend.options);
    const name = backend.sections.find(row => row.id === sectionId)!.canonicalName;
    fireEvent.click(await slot.findByRole("button", { name: `New thread in ${name}` }));
    expect(slot.inspection.navigateCalls.filter(call => call.method === "toCompose")).toEqual([{ method: "toCompose", options: { placement: { sectionId, pinned: false }, focusPrompt: true } }]);
  });

  test("sidebar mirrors actual bb sections and keeps advanced library/connections reachable", async () => {
    const backend = fixture();
    const slot = renderSlot({ component: app.navPanels[0]!.experimental_sidebar! }, { subPath: "sections/sec_envoy" }, backend.options);
    expect(await slot.findByRole("button", { name: "OTLP routing" })).toBeTruthy();
    expect(slot.getAllByRole("button", { name: "Envoy cluster-service", hidden: true }).find(button => button.getAttribute("aria-current") === "page")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Library" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Connections" })).toBeTruthy();
  });

  test("connect creates and shares in one confirmed job, with no required topic/token setup", async () => {
    const { slot } = renderSection(false);
    fireEvent.click(await slot.findByRole("button", { name: "Share context in this section" }));
    const dialog = await slot.findByRole("dialog", { name: "Share context in Envoy cluster-service" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "New workstream" }));
    expect(within(dialog).queryByRole("textbox", { name: "Topic" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Share context" }));
    await waitFor(() => expect(calls(slot, "sectionConnect")).toHaveLength(1));
    expect(calls(slot, "sectionConnect")[0]!.input).toMatchObject({ sectionId: "sec_envoy", expectedRevision: 0, expectedTitle: "Envoy cluster-service", choice: { kind: "create", name: "Envoy cluster-service" }, markTitle: false });
    expect(calls(slot, "workstreamCreate")).toHaveLength(0);
    expect(calls(slot, "setSectionBinding")).toHaveLength(0);
  });

  test("connecting an existing workstream leaves the native title unchanged", async () => {
    const { slot } = renderSection(false);
    fireEvent.click(await slot.findByRole("button", { name: "Share context in this section" }));
    const dialog = await slot.findByRole("dialog");
    expect(dialog.textContent).not.toContain("🧠");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Use existing" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Envoy cluster-service.*Not connected/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Share context" }));
    await waitFor(() => expect(calls(slot, "sectionConnect")).toHaveLength(1));
    expect(calls(slot, "sectionConnect")[0]!.input).toMatchObject({ choice: { kind: "reuse", workstreamId: ws.id, expectedWorkstreamRevision: ws.revision }, expectedTitle: "Envoy cluster-service", markTitle: false });
  });

  test("a refused legacy title application remains an authoritative warning, not a cleanup claim", async () => {
    const { backend, slot } = renderSection(false);
    const message = "Native title decoration is disabled. The SVG is shown in Cortex only.";
    backend.options.rpc.sectionConnect = input => ({ requestId: input.requestId, sectionId: input.sectionId, workstreamId: ws.id, status: "connected", expectedRevision: 0, bindingRevision: 1, error: null, marker: { ...mark, status: "failed", error: message } });
    fireEvent.click(await slot.findByRole("button", { name: "Share context in this section" }));
    const dialog = await slot.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: "New workstream" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Share context" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(`Connected. ${message}`));
    expect(calls(slot, "sectionTitleMark")).toHaveLength(0);
  });

  test("connected unmarked sections offer no native title application", async () => {
    const { slot } = renderSection();
    const opener = await slot.findByRole("button", { name: "Advanced section actions" });
    fireEvent.keyDown(opener, { key: "Enter" });
    await slot.findByRole("menuitem", { name: "Stop sharing…" });
    expect(slot.queryByRole("menuitem", { name: "Apply title mark" })).toBeNull();
    expect(slot.queryByRole("menuitem", { name: "Remove title mark" })).toBeNull();
    expect(calls(slot, "sectionTitleMark")).toHaveLength(0);
  });

  test("unknown applicability cannot be accepted; an explicit Everywhere choice accepts one candidate", async () => {
    const { slot } = renderSection();
    const card = await slot.findByRole("region", { name: entry.title });
    const accept = within(card).getByRole("button", { name: "Accept" });
    expect(accept.hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(card).getByRole("radio", { name: "Everywhere" }));
    fireEvent.click(accept);
    await waitFor(() => expect(calls(slot, "sectionCandidateAccept")).toHaveLength(1));
    expect(calls(slot, "sectionCandidateAccept")[0]!.input).toMatchObject({ id: entry.id, expectedRevision: 1, expectedBindingRevision: 1, applicability: { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } } });
  });

  test("a candidate leaving review preserves the editor and blocks candidate-only saves", async () => {
    const { slot, backend } = renderSection();
    const card = await slot.findByRole("region", { name: entry.title });
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    const dialog = await slot.findByRole("dialog");
    const field = within(dialog).getByRole("textbox", { name: "Text" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "My unsaved copy" } }); field.focus(); field.setSelectionRange(2, 7);
    backend.change({ ...entry, revision: 2, state: "approved", approval: { actor, at: now } });
    await slot.behavior.emitRealtime("workstreams", { workstreamId: ws.id });
    expect(await within(dialog).findByText("This takeaway is no longer waiting for review. Your draft is kept; use its saved page for further changes.")).toBeTruthy();
    expect(slot.getByRole("dialog")).toBe(dialog);
    expect(field.value).toBe("My unsaved copy");
    expect([field.selectionStart, field.selectionEnd]).toEqual([2, 7]);
    expect(document.activeElement).toBe(field);
    expect(within(dialog).getByRole("button", { name: "Save for review" }).hasAttribute("disabled")).toBe(true);
    expect(calls(slot, "sectionCandidateEdit")).toHaveLength(0);
  });

  test("same-item updates and refresh errors preserve editor DOM, draft, caret and focus; save requires explicit replacement", async () => {
    const { slot, backend } = renderSection();
    const card = await slot.findByRole("region", { name: entry.title });
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    const dialog = await slot.findByRole("dialog", { name: "Edit takeaway" });
    const field = within(dialog).getByRole("textbox", { name: "Text" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "My careful draft copy." } });
    field.focus(); field.setSelectionRange(4, 9);
    await slot.behavior.emitRealtime("thread", { threadId: "thr_bbbbbbbb" });
    expect(calls(slot, "sectionDetail")).toHaveLength(1);
    backend.change({ ...entry, revision: 2, text: "A newer canonical version." });
    await slot.behavior.emitRealtime("workstreams", { workstreamId: ws.id });
    expect(await within(dialog).findByText("A newer canonical version.")).toBeTruthy();
    expect(slot.getByRole("dialog", { name: "Edit takeaway" })).toBe(dialog);
    expect(within(dialog).getByRole("textbox", { name: "Text" })).toBe(field);
    expect(field.value).toBe("My careful draft copy.");
    expect([field.selectionStart, field.selectionEnd]).toEqual([4, 9]);
    expect(document.activeElement).toBe(field);
    expect(within(dialog).getByRole("button", { name: "Save for review" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep my draft copy" }));
    expect(calls(slot, "sectionCandidateEdit")).toHaveLength(0);
    backend.fail();
    field.focus(); field.setSelectionRange(4, 9);
    await slot.behavior.emitRealtime("sections", { sectionId: "sec_envoy" });
    await act(async () => {});
    expect(slot.getByRole("dialog", { name: "Edit takeaway" })).toBe(dialog);
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([4, 9]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save for review" }));
    await waitFor(() => expect(calls(slot, "sectionCandidateEdit")).toHaveLength(1));
    expect(calls(slot, "sectionCandidateEdit")[0]!.input).toMatchObject({ id: entry.id, expectedRevision: 2, text: "My careful draft copy." });
  });
});

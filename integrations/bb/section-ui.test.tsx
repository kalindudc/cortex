// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { experimental_makePanelController } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { sectionRpcContract, type Section, type SectionEligibility } from "./section-contract";
import { workstreamRpcContract } from "./workstream-contract";
import type { Knowledge, Workstream } from "./ui/types";
import { type Action, toast } from "sonner";
import { CaptureDialog, TakeawayPanel } from "./ui/takeaway";
import { ConnectSectionDialog, SectionPage } from "./ui/sections";

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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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

test.each(["over-budget", "missing-required", "unavailable", "unbound"] as const)("section brief labels selected entries without claiming delivery for %s", async status => {
  const backend = fixture();
  const original = backend.options.rpc.sectionDetail!;
  backend.options.rpc.sectionDetail = input => ({ ...original(input), eligibility: { computedAt: now, status, error: null, entries: [{ knowledge: { ...entry, state: "approved", approval: { actor, at: now } }, text: entry.text, estimatedTokens: 50, origin: "canonical", overrideActor: null }], notices: [], exclusions: [], exactText: entry.text, estimatedTokens: 50, budgetTokens: 400 } });
  const page = renderSlot({ component: SectionPage }, { id: "sec_envoy" }, backend.options);
  await page.findByRole("heading", { name: /Sends nothing:/ });
  expect(page.queryByRole("list", { name: "Goes to new threads" })).toBeNull();
});

test("connect choices show connections without reading every workstream", async () => {
  const backend = fixture(false);
  const page = renderSlot({ component: () => <ConnectSectionDialog section={backend.sections[0]!} workstreams={Array.from({ length: 30 }, (_, i) => ({ ...ws, id: `ws_choice${i}`, name: `Choice ${i}` }))} connections={[]} onClose={() => {}} /> }, {}, backend.options);
  await page.findByRole("radio", { name: "Use Choice 29" });
  expect(calls(page, "workstreamShow")).toHaveLength(0);
});

test("connect intent is consumed with replace after opening", async () => {
  const backend = fixture(false);
  const page = renderSlot({ component: SectionPage }, { id: "sec_envoy", connect: true }, backend.options);
  await page.findByRole("dialog", { name: "Share context in Envoy cluster-service" });
  expect(page.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "cortex", options: { subPath: "sections/sec_envoy/brief", replace: true } });
});

test("held observations offer Open rather than promising to record an observation", async () => {
  const backend = fixture();
  const original = backend.options.rpc.sectionDetail!;
  backend.options.rpc.sectionDetail = async input => { const data = await original(input); return { ...data, eligibility: { ...data.eligibility, exclusions: [{ id: entry.id, reason: "expired; needs recheck" }] } }; };
  const page = renderSlot({ component: SectionPage }, { id: "sec_envoy" }, backend.options);
  const held = await page.findByRole("region", { name: "Held back" });
  expect(within(held).queryByRole("button", { name: "Record what you see now…" })).toBeNull();
  fireEvent.click(within(held).getByRole("button", { name: "Open" }));
  expect(page.inspection.navigateCalls.at(-1)).toMatchObject({ options: { subPath: `sections/sec_envoy/brief/${entry.id}` } });
});

test.each([
  ["its own scope is unknown", { environment: { mode: "unknown" }, host: { mode: "unknown" } }, false],
  ["the section has no target", { environment: { mode: "value", value: "staging" }, host: { mode: "not-applicable" } }, true],
] as const)("an empty brief offers Set targets only when targets would help: %s", async (_, applicability, offersTargets) => {
  const backend = fixture();
  const original = backend.options.rpc.sectionDetail!;
  const held = { ...entry, state: "approved" as const, approval: { actor, at: now }, applicability };
  backend.options.rpc.knowledgeShow = () => ({ entry: held, workstream: ws });
  backend.options.rpc.sectionDetail = async input => { const data = await original(input); return { ...data, review: { items: [{ entry: held, workstream: ws, hints: [] }], total: 1, limit: 50, offset: 0 }, eligibility: { ...data.eligibility, exclusions: [{ id: entry.id, reason: "environment or host unknown/mismatched" }] } }; };
  const page = renderSlot({ component: SectionPage }, { id: "sec_envoy" }, backend.options);
  const status = await page.findByText(/No entry reaches new threads yet\./);
  await waitFor(() => expect(status.textContent).toContain("1 approved entry is held back."));
  expect(within(status.parentElement!).queryByRole("button", { name: "Set targets" }) !== null).toBe(offersTargets);
  if (!offersTargets) expect(status.textContent).toContain("Open each one to say where it applies.");
});

test("suggestion token estimate is explicitly approximate and text-only", async () => {
  const { slot } = renderSection();
  const card = await slot.findByRole("region", { name: entry.title });
  expect(within(card).getByText(/^Suggested · text ~/)).toBeTruthy();
});

test("Accept explains missing targets in visible text and compact Everywhere is a button", async () => {
  const { slot } = renderSection();
  const card = await slot.findByRole("region", { name: entry.title });
  expect(within(card).getByText("Choose environment and host first").closest('[role="tooltip"]')).toBeNull();
  expect(within(card).queryByRole("radiogroup", { name: "Where it applies" })).toBeNull();
  fireEvent.click(within(card).getByRole("button", { name: "Everywhere" }));
  expect(within(card).queryByText("Choose environment and host first")).toBeNull();
});

test.each(["Close entry", "Back to brief"])("section entry focuses the sheet and restores its opener on %s", async close => {
  const backend = fixture();
  const original = backend.options.rpc.sectionDetail!;
  backend.options.rpc.sectionDetail = async input => { const data = await original(input); return { ...data, eligibility: { ...data.eligibility, entries: [{ knowledge: { ...entry, state: "approved", approval: { actor, at: now } }, text: entry.text, estimatedTokens: 50, origin: "canonical", overrideActor: null }] } }; };
  const page = renderSlot({ component: SectionPage }, { id: "sec_envoy" }, backend.options);
  const opener = await page.findByRole("button", { name: `Open ${entry.title}` });
  opener.focus(); fireEvent.click(opener);
  page.rerender(<SectionPage id="sec_envoy" entryId={entry.id} />);
  const closeButton = await page.findByRole("button", { name: "Close entry" });
  await waitFor(() => expect(document.activeElement).toBe(closeButton));
  fireEvent.click(page.getByRole("button", { name: close }));
  page.rerender(<SectionPage id="sec_envoy" />);
  await waitFor(() => expect(document.activeElement).toBe(page.getByRole("button", { name: `Open ${entry.title}` })));
});

test.each([true, false])("target chip tooltip reflects unknown targets only (unknown: %s)", async unknown => {
  const backend = fixture();
  backend.sections[0]!.binding.binding!.applicability = { environment: unknown ? { mode: "unknown" } : { mode: "value", value: "staging" }, host: { mode: "not-applicable" } };
  const page = renderSlot({ component: SectionPage }, { id: "sec_envoy" }, backend.options);
  const chip = await page.findByRole("button", { name: unknown ? "Environment ?" : "Environment staging" });
  fireEvent.keyDown(document, { key: "Tab" });
  act(() => chip.focus());
  const tooltip = await page.findByRole("tooltip");
  expect(tooltip.textContent).toBe(unknown ? "Unknown never counts as any environment, so entries that need one stay out." : "Change targets");
});

describe("section ledger", () => {
  test("over-budget refusal comes from eligibility status, including scope overhead", async () => {
    const backend = fixture();
    const original = backend.options.rpc.sectionDetail!;
    backend.options.rpc.sectionDetail = input => ({ ...original(input), eligibility: { computedAt: now, status: "over-budget", error: "Nothing was silently truncated.", entries: [], notices: [], exclusions: [], exactText: "Scope overhead", estimatedTokens: 500, budgetTokens: 400 } });
    const page = renderSlot({ component: SectionPage }, { id: "sec_envoy" }, backend.options);
    expect(await page.findByText(/New threads get no brief until it fits/)).toBeTruthy();
    fireEvent.click(page.getByRole("button", { name: "Raise budget" }));
    expect(await page.findByRole("dialog", { name: "Connect section Envoy cluster-service" })).toBeTruthy();
    expect(page.container.querySelector('[data-part="BriefList"]')?.textContent).not.toContain("cut");
  });
  test("binding dialog Disconnect Undo restores the original binding at the returned revision", async () => {
    const backend = fixture();
    const saved = backend.sections[0]!.binding.binding;
    backend.options.rpc.setSectionBinding = input => {
      backend.sections[0]!.binding = { key: input.sectionId, revision: input.expectedRevision + 1, binding: input.binding };
      return backend.sections[0]!.binding;
    };
    const page = renderSlot({ component: SectionPage }, { id: "sec_envoy" }, backend.options);
    fireEvent.click(await page.findByRole("button", { name: "Environment ?" }));
    const dialog = await page.findByRole("dialog", { name: "Connect section Envoy cluster-service" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(page.queryByRole("dialog")).toBeNull());
    const action = vi.mocked(toast).mock.calls.filter(call => call[0] === "Disconnected for future sessions.").at(-1)![1]!.action as Action;
    await act(async () => { await action.onClick({} as never); });
    expect(calls(page, "setSectionBinding").map(call => call.input)).toEqual([
      { sectionId: "sec_envoy", expectedRevision: 1, binding: null },
      { sectionId: "sec_envoy", expectedRevision: 2, binding: saved },
    ]);
  });

  test("a failed Disconnect Undo reports the conflict without bypassing the revision", async () => {
    const backend = fixture();
    backend.options.rpc.setSectionBinding = input => {
      if (input.binding) throw new Error("Binding changed before Undo");
      return { key: input.sectionId, revision: 2, binding: null };
    };
    const page = renderSlot({ component: SectionPage }, { id: "sec_envoy" }, backend.options);
    fireEvent.click(await page.findByRole("button", { name: "Environment ?" }));
    const dialog = await page.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(page.queryByRole("dialog")).toBeNull());
    const action = vi.mocked(toast).mock.calls.filter(call => call[0] === "Disconnected for future sessions.").at(-1)![1]!.action as Action;
    await act(async () => { await action.onClick({} as never); });
    expect(toast.error).toHaveBeenCalledWith("Binding changed before Undo");
    expect(calls(page, "setSectionBinding")[1]!.input).toMatchObject({ expectedRevision: 2 });
    expect(calls(page, "setSectionBinding")).toHaveLength(2);
  });

  test("acceptance does not invent eligibility when a saved entry stays held", async () => {
    const backend = fixture();
    backend.options.rpc.sectionCandidateAccept = () => {
      const approved = { ...entry, state: "approved" as const, revision: 2, approval: { actor, at: now } };
      backend.change(approved);
      return { outcome: "updated", entry: approved };
    };
    const page = renderSlot({ component: SectionPage }, { id: "sec_envoy" }, backend.options);
    const card = await page.findByRole("region", { name: entry.title });
    fireEvent.click(within(card).getByRole("button", { name: "Everywhere" }));
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(calls(page, "sectionCandidateAccept")).toHaveLength(1));
    await waitFor(() => expect(page.queryByRole("region", { name: entry.title })).toBeNull());
    expect(page.queryByRole("button", { name: `Open ${entry.title}` })).toBeNull();
    expect(page.getByRole("img", { name: /0 of 400 tokens/ }).querySelector("[data-segment-key]")).toBeNull();
  });

  test("entry selection and Close stay in the section brief route", async () => {
    const backend = fixture();
    const page = renderSlot({ component: SectionPage }, { id: "sec_envoy", entryId: entry.id }, backend.options);
    const panel = await waitFor(() => {
      const sheet = page.container.querySelector('[data-part="KnowledgeSheet"]');
      expect(sheet?.textContent).toContain(entry.title);
      return sheet as HTMLElement;
    });
    expect(within(panel).getByRole("button", { name: "Back to brief" })).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Close entry" }));
    expect(page.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "cortex", options: { subPath: "sections/sec_envoy/brief" } });
  });

  test("tabs use section sub-routes and connect intent opens the dialog", async () => {
    const backend = fixture(false);
    const slot = renderSlot({ component: SectionPage }, { id: "sec_envoy", connect: true }, backend.options);
    expect(await slot.findByRole("dialog", { name: "Share context in Envoy cluster-service" })).toBeTruthy();
    slot.unmount();
    const bound = fixture();
    const page = renderSlot({ component: SectionPage }, { id: "sec_envoy" }, bound.options);
    fireEvent.mouseDown(await page.findByRole("tab", { name: /All knowledge/ }), { button: 0, ctrlKey: false });
    expect(page.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "cortex", options: { subPath: "sections/sec_envoy/knowledge" } });
  });

  test.each([false, true])("accepted suggestions collapse and land only from refreshed eligibility (reduced motion: %s)", async reduced => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("prefers-reduced-motion") && reduced, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(), onchange: null })));
    const backend = fixture();
    let approved: Knowledge | null = null;
    const original = backend.options.rpc.sectionDetail!;
    backend.options.rpc.sectionDetail = input => ({ ...original(input), review: { items: approved ? [] : [{ entry, workstream: ws, hints: [] }], total: approved ? 0 : 1, limit: 50, offset: 0 }, eligibility: { computedAt: now, status: "ready", error: null, entries: approved ? [{ knowledge: approved, text: approved.text, estimatedTokens: 50, origin: "canonical", overrideActor: null }] : [], notices: [], exclusions: [], exactText: "", estimatedTokens: approved ? 50 : 0, budgetTokens: 400 } });
    backend.options.rpc.sectionCandidateAccept = () => { approved = { ...entry, state: "approved", revision: 2, approval: { actor, at: now } }; return { outcome: "updated", entry: approved }; };
    const page = renderSlot({ component: SectionPage }, { id: "sec_envoy" }, backend.options);
    const card = await page.findByRole("region", { name: entry.title });
    fireEvent.click(within(card).getByRole("button", { name: "Everywhere" }));
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    const landed = await page.findByRole("button", { name: new RegExp(`Open ${entry.title}`) });
    expect(landed.classList.contains("cortex-landed")).toBe(true);
    expect(landed.textContent).toContain("just now");
    expect(page.getByRole("img", { name: /50 of 400 tokens/ }).querySelector(`[data-segment-key="${entry.id}"]`)).toBeTruthy();
    await waitFor(() => expect(page.queryByRole("region", { name: entry.title })).toBeNull());
    fireEvent.mouseEnter(landed);
    expect(page.getByRole("img").querySelector(".cortex-strip-highlight")?.getAttribute("data-segment-key")).toBe(entry.id);
    fireEvent.click(landed);
    expect(page.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "cortex", options: { subPath: `sections/sec_envoy/brief/${entry.id}` } });
    vi.unstubAllGlobals();
  });

  test.each([false, true])("accepted card stays in place and cannot reappear enabled during a slow refetch (reduced motion: %s)", async reduced => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("prefers-reduced-motion") && reduced, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const backend = fixture();
    const original = backend.options.rpc.sectionDetail!;
    let refresh: (() => void) | null = null;
    let accepted = false;
    const second = { ...entry, id: "kn_second", title: "Second suggestion" };
    backend.options.rpc.sectionDetail = async input => {
      if (accepted) await new Promise<void>(resolve => { refresh = resolve; });
      return { ...original(input), review: { items: (accepted ? [second] : [entry, second]).map(entry => ({ entry, workstream: ws, hints: [] })), total: accepted ? 1 : 2, limit: 50, offset: 0 } };
    };
    backend.options.rpc.sectionCandidateAccept = () => { accepted = true; return { outcome: "updated", entry: { ...entry, state: "approved", revision: 2, approval: { actor, at: now } } }; };
    const page = renderSlot({ component: SectionPage }, { id: "sec_envoy" }, backend.options);
    const card = await page.findByRole("region", { name: entry.title });
    fireEvent.click(within(card).getByRole("button", { name: "Everywhere" }));
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(refresh).not.toBeNull());
    expect(page.container.querySelectorAll('[data-part="SuggestionCard"]')[0]?.getAttribute("aria-label")).toBe(entry.title);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    const button = within(card).getByRole("button", { name: "Accept" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(calls(page, "sectionCandidateAccept")).toHaveLength(1);
    await act(async () => { refresh!(); });
    await waitFor(() => expect(page.queryByRole("region", { name: entry.title })).toBeNull());
  });

  test("failed acceptance restores the card with an error", async () => {
    const backend = fixture();
    backend.options.rpc.sectionCandidateAccept = () => { throw new Error("Acceptance failed"); };
    const page = renderSlot({ component: SectionPage }, { id: "sec_envoy" }, backend.options);
    const card = await page.findByRole("region", { name: entry.title });
    fireEvent.click(within(card).getByRole("button", { name: "Everywhere" }));
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await within(card).findByText(/Acceptance failed/);
    expect((within(card).getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("Reject remains immediate and Undo returns to review through edit", async () => {
    const backend = fixture();
    backend.options.rpc.knowledgeTransition = input => ({ outcome: "updated", entry: { ...entry, state: input.state, revision: input.expectedRevision + 1 } });
    backend.options.rpc.knowledgeEdit = () => ({ outcome: "updated", entry: { ...entry, revision: 3 } });
    const page = renderSlot({ component: SectionPage }, { id: "sec_envoy" }, backend.options);
    const card = await page.findByRole("region", { name: entry.title });
    fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Rejected. Threads never get it.", expect.objectContaining({ action: expect.anything() })));
    expect(calls(page, "knowledgeTransition")).toHaveLength(1);
    expect(calls(page, "knowledgeTransition")[0]!.input).toMatchObject({ id: entry.id, expectedRevision: 1, state: "rejected" });
    const action = vi.mocked(toast).mock.calls.filter(call => call[0] === "Rejected. Threads never get it.").at(-1)![1]!.action as Action;
    await act(async () => { await action.onClick({} as React.MouseEvent<HTMLButtonElement>); });
    expect(calls(page, "knowledgeEdit")[0]!.input).toMatchObject({ id: entry.id, expectedRevision: 2 });
  });
});

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

  test("sidebar mirrors actual bb sections and keeps library, workstreams and connection overview reachable", async () => {
    const backend = fixture();
    const slot = renderSlot({ component: app.navPanels[0]!.experimental_sidebar! }, { subPath: "sections/sec_envoy" }, backend.options);
    expect(await slot.findByRole("button", { name: "OTLP routing" })).toBeTruthy();
    expect(slot.getAllByRole("button", { name: "Envoy cluster-service", hidden: true }).find(button => button.getAttribute("aria-current") === "page")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Library" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Overview" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Workstreams 1 workstream" })).toBeTruthy();
  });

  test("connect creates and shares in one confirmed job, with no required topic/token setup", async () => {
    const { slot } = renderSection(false);
    fireEvent.click(await slot.findByRole("button", { name: /^Share context in (?:Envoy cluster-service|One|🧠 My own name)/ }));
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
    fireEvent.click(await slot.findByRole("button", { name: /^Share context in (?:Envoy cluster-service|One|🧠 My own name)/ }));
    const dialog = await slot.findByRole("dialog");
    expect(dialog.textContent).not.toContain("🧠");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Use Envoy cluster-service" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Share context" }));
    await waitFor(() => expect(calls(slot, "sectionConnect")).toHaveLength(1));
    expect(calls(slot, "sectionConnect")[0]!.input).toMatchObject({ choice: { kind: "reuse", workstreamId: ws.id, expectedWorkstreamRevision: ws.revision }, expectedTitle: "Envoy cluster-service", markTitle: false });
  });

  test("a refused legacy title application remains an authoritative warning, not a cleanup claim", async () => {
    const { backend, slot } = renderSection(false);
    const message = "Native title decoration is disabled. The SVG is shown in Cortex only.";
    backend.options.rpc.sectionConnect = input => ({ requestId: input.requestId, sectionId: input.sectionId, workstreamId: ws.id, status: "connected", expectedRevision: 0, bindingRevision: 1, error: null, marker: { ...mark, status: "failed", error: message } });
    fireEvent.click(await slot.findByRole("button", { name: /^Share context in (?:Envoy cluster-service|One|🧠 My own name)/ }));
    const dialog = await slot.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: "New workstream" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Share context" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(`Connected. ${message}`));
    expect(calls(slot, "sectionTitleMark")).toHaveLength(0);
  });

  test("connected unmarked sections offer no native title application", async () => {
    const { slot } = renderSection();
    const opener = await slot.findByRole("button", { name: "Sharing Envoy cluster-service" });
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
    fireEvent.click(within(card).getByRole("button", { name: "Everywhere" }));
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

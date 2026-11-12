// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { readFileSync } from "node:fs";
import { CompactViewportOverrideProvider } from "./components/ui/hooks/use-compact-viewport";
import { ChangeForThreadDialog, EditKnowledgeDialog, ObserveDialog, ProposeDialog } from "./ui/dialogs";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, test, vi } from "vitest";
import { workstreamRpcContract } from "./workstream-contract";
import { KnowledgeActions, KnowledgeDetail } from "./ui/knowledge";
import { Library } from "./ui/library";
import type { ContextEntry, Knowledge, ThreadContext, Workstream } from "./ui/types";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const at = "2026-11-11T12:00:00.000Z";
const actor = { id: "person", type: "human" } as const;
const ws: Workstream = { id: "ws_envoy", name: "Envoy", description: "", revision: 1, archived: false, actor, createdAt: at, updatedAt: at };
const entry: Knowledge = { id: "kn_first", workstreamId: ws.id, subject: "first", title: "First finding", text: "A saved finding", kind: "finding", state: "approved", facet: "orientation", applicability: { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } }, sources: [{ ref: "@thread:thr_source#msg=42", authorType: "agent", observedAt: at, status: "available", excerpt: "Exact source quote" }], revision: 2, actor, createdAt: at, updatedAt: at, expiresAt: null, approval: { actor, at }, supersedes: ["kn_old"], conflicts: [], supersededBy: null };
const old: Knowledge = { ...entry, id: "kn_old", title: "Earlier finding", supersedes: [], state: "superseded" };
function setup(component: () => React.JSX.Element) {
  const rpc: Partial<PluginRpcTestHandlers<typeof workstreamRpcContract>> = {
    knowledgeShow: ({ id }) => ({ entry: id === old.id ? old : entry, workstream: ws }),
    reviewQueue: () => ({ items: [{ entry, workstream: ws, hints: [{ id: old.id, reason: "same-subject" }] }], total: 1, limit: 100, offset: 0 }),
    knowledgeSearch: () => ({ items: [{ entry, workstream: ws, hints: [] }, { entry: old, workstream: ws, hints: [] }], total: 2, limit: 50, offset: 0 }),
    sectionBindings: () => ({ bindings: [{ key: "sec_envoy", revision: 1, binding: { workstreamId: ws.id, topic: null, budgetTokens: 400, requiredKnowledgeIds: [] } }] }),
    knowledgeTransition: input => ({ outcome: "updated", entry: { ...entry, state: input.state, revision: 3 } }),
    workstreamHistory: () => ({ revisions: [], total: 0, limit: 50, offset: 0 }),
  };
  return renderSlot({ component }, {}, { rpc: rpc as PluginRpcTestHandlers<typeof workstreamRpcContract>, experimental_rpcContract: workstreamRpcContract, sidebarThreads: { sections: [{ id: "sec_envoy", name: "Envoy section" }], threads: [{ id: "thr_source", displayTitle: "Source conversation", sectionId: "sec_envoy" }] } as any });
}

test("Knowledge sheet shows readable pointers, source thread, optional reason and close without default ids", async () => {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const clipboard = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
  const slot = setup(() => <KnowledgeDetail entry={entry} workstream={ws} onOpen={onOpen} onClose={onClose} reason={{ label: "Held: host not set", icon: "Server", tone: "warning" }} />);
  const sheet = await slot.findByRole("region", { name: entry.title });
  fireEvent.click(await slot.findByRole("button", { name: "Earlier finding" }));
  expect(onOpen).toHaveBeenCalledWith(old.id);
  expect(sheet.textContent).not.toContain("kn_");
  expect(sheet.textContent).not.toContain("thr_");
  expect(slot.getByText("Held: host not set")).toBeTruthy();
  expect(slot.getByText("Exact source quote").tagName).toBe("BLOCKQUOTE");
  fireEvent.click(slot.getByRole("button", { name: "Source conversation · msg 42" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_source" });
  fireEvent.click(slot.getByRole("button", { name: "Copy id" }));
  await waitFor(() => expect(clipboard).toHaveBeenCalledWith(entry.id));
  fireEvent.click(slot.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledOnce();
});

function stubTextareaSize() {
  const size = { content: 300, cap: 448 };
  vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(() => size.content);
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = getStyle(element, pseudo);
    if (element instanceof HTMLTextAreaElement) Object.defineProperties(style, {
      minHeight: { value: "135px" }, maxHeight: { value: `${size.cap}px` },
      borderTopWidth: { value: "1px" }, borderBottomWidth: { value: "1px" },
    });
    return style;
  });
  return size;
}

test("knowledge text grows on mount and edits, shrinks, and scrolls only beyond the viewport cap", async () => {
  const size = stubTextareaSize();
  const slot = setup(() => <EditKnowledgeDialog entry={entry} workstream={ws} open onOpenChange={() => {}} />);
  const field = await slot.findByRole("textbox", { name: "Text" }) as HTMLTextAreaElement;
  expect(field.style.height).toBe("302px");
  expect(field.rows).toBe(6);
  size.content = 1200;
  fireEvent.change(field, { target: { value: "A much longer draft" } });
  expect(field.style.height).toBe("448px");
  size.content = 10;
  fireEvent.change(field, { target: { value: "Short" } });
  expect(field.style.height).toBe("135px");
  size.content = 500;
  size.cap = 240;
  fireEvent(window, new Event("resize"));
  expect(field.style.height).toBe("240px");
});

test("width changes remeasure wrapping, but height-only changes do not loop and observers are disposed", async () => {
  const size = stubTextareaSize();
  const observers: Array<{ callback: ResizeObserverCallback; target: Element | null; disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal("ResizeObserver", class {
    target: Element | null = null;
    disconnect = vi.fn();
    constructor(public callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element) { this.target = target; }
    unobserve() {}
  });
  const slot = setup(() => <EditKnowledgeDialog entry={entry} workstream={ws} open onOpenChange={() => {}} />);
  const field = await slot.findByRole("textbox", { name: "Text" }) as HTMLTextAreaElement;
  const observer = observers.find(item => item.target === field)!;
  const resize = (width: number) => observer.callback([{ contentRect: { width } } as ResizeObserverEntry], observer as unknown as ResizeObserver);
  size.content = 400;
  await act(() => resize(320));
  expect(field.style.height).toBe("402px");
  size.content = 600;
  await act(() => resize(320));
  expect(field.style.height).toBe("402px");
  await act(() => resize(240));
  expect(field.style.height).toBe("448px");
  slot.lifecycle.unmount();
  expect(observer.disconnect).toHaveBeenCalledOnce();
  size.content = 150;
  fireEvent(window, new Event("resize"));
  expect(field.style.height).toBe("448px");
});

test("opening the same retained dialog remeasures its text even when the saved value is unchanged", async () => {
  const size = stubTextareaSize();
  const slot = setup(() => {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open editor</button><EditKnowledgeDialog entry={entry} workstream={ws} open={open} onOpenChange={setOpen} /></>;
  });
  fireEvent.click(slot.getByRole("button", { name: "Open editor" }));
  expect((await slot.findByRole("textbox", { name: "Text" }) as HTMLTextAreaElement).style.height).toBe("302px");
  fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
  size.content = 410;
  fireEvent.click(slot.getByRole("button", { name: "Open editor" }));
  expect((await slot.findByRole("textbox", { name: "Text" }) as HTMLTextAreaElement).style.height).toBe("412px");
});

test.each([false, true])("edit dialog keeps editor and saved-text preview in the responsive columns (compact=%s)", async compact => {
  const slot = setup(() => <CompactViewportOverrideProvider isCompactViewport={compact}><EditKnowledgeDialog entry={entry} workstream={ws} open onOpenChange={() => {}} /></CompactViewportOverrideProvider>);
  const field = await slot.findByRole("textbox", { name: "Text" });
  const columns = field.closest(".cortex-knowledge-editor");
  expect(columns).not.toBeNull();
  expect(columns!.getAttribute("data-compact")).toBe(String(compact));
  const preview = within(columns as HTMLElement).getByRole("region", { name: "Change from the saved text" });
  expect(preview.textContent).toContain(entry.text);
  expect(within(preview).getByRole("status").textContent).toBe("No change yet.");
  const previewPane = preview.querySelector(".cortex-knowledge-preview");
  expect(previewPane).not.toBeNull();
  fireEvent.change(field, { target: { value: "A revised finding" } });
  expect(preview.querySelector(".cortex-knowledge-preview")).toBe(previewPane);
  expect(preview.querySelector("ins")?.textContent).toContain("revised");
  expect(preview.querySelector("del")?.textContent).toContain("saved");
  expect(within(preview).queryByRole("status")).toBeNull();
  expect(columns!.contains(slot.getByRole("textbox", { name: "Title" }))).toBe(false);
  expect(columns!.contains(slot.getByRole("textbox", { name: "Why (kept in history)" }))).toBe(false);
  expect(columns!.contains(slot.getByRole("button", { name: "Save for all threads" }))).toBe(false);
  expect(field.closest(".cortex-text-dialog")).not.toBeNull();
});

test("thread-only change uses the same editor and stable canonical preview without changing scope", async () => {
  const item: ContextEntry = { knowledge: entry, text: entry.text, origin: "canonical", overrideActor: null, estimatedTokens: 10 };
  const context: ThreadContext = {
    threadId: "thr_source", revision: 1, binding: null, bindingRevision: 0, bindingSource: "none", inheritedFrom: null,
    workstream: ws, applicability: entry.applicability, entries: [item], notices: [], exclusions: [], overrides: [], grants: [],
    exactText: entry.text, estimatedTokens: 10, budgetTokens: 400, status: "ready", error: null, dismissed: false,
    dismissedPreference: null, bindingChanged: false, lastReceipt: null,
  };
  const slot = setup(() => <ChangeForThreadDialog context={context} entry={item} open onOpenChange={() => {}} />);
  const field = await slot.findByRole("textbox", { name: "Text for this thread" });
  const columns = field.closest(".cortex-knowledge-editor");
  expect(columns).not.toBeNull();
  const preview = within(columns as HTMLElement).getByRole("region", { name: "Change from the saved text" });
  expect(preview.textContent).toContain(entry.text);
  expect(within(preview).getByRole("status")).toBeTruthy();
  expect(slot.getByText(/Only this thread's next context changes/).closest(".cortex-knowledge-editor")).toBeNull();
});

test.each(["propose", "observe", "evidence"] as const)("%s knowledge fields use the growing textarea", async mode => {
  stubTextareaSize();
  const slot = setup(() => mode === "propose"
    ? <ProposeDialog workstream={ws} facets={[]} open onOpenChange={() => {}} />
    : <ObserveDialog entry={entry} mode={mode} open onOpenChange={() => {}} />);
  const labels = mode === "propose" ? ["Text"] : mode === "observe" ? ["What you observed", "Excerpt"] : ["Excerpt"];
  for (const label of labels) {
    const field = await slot.findByRole("textbox", { name: label }) as HTMLTextAreaElement;
    expect(field.style.height).toBe("302px");
    expect(field.rows).toBe(6);
    expect(field.closest(".cortex-text-dialog")).not.toBeNull();
  }
});

test("knowledge editor CSS caps both panes and the dialog, with a dialog-width breakpoint and compact override", () => {
  const css = readFileSync("ui/knowledge-editor.css", "utf8");
  expect(css).toContain("container-type: inline-size");
  expect(css).toContain("container-name: cortex-knowledge-dialog");
  expect(css).toContain("@container cortex-knowledge-dialog (min-width: 720px)");
  expect(css).toContain('.cortex-knowledge-editor:not([data-compact="true"])');
  expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
  expect(css).toContain("max-height: calc(100dvh - 2rem)");
  expect(css).toContain("max(12rem, calc(100dvh - 22rem))");
  expect(css).toContain("max-height: var(--cortex-knowledge-text-max)");
  expect(css).toContain("overflow-y: auto");
});

test("History toggle includes its visible label in the accessible name", async () => {
  const slot = setup(() => <KnowledgeDetail entry={entry} workstream={ws} onOpen={() => {}} />);
  fireEvent.click(slot.getByRole("button", { name: "Show history" }));
  await waitFor(() => expect(slot.getByRole("button", { name: "Hide history" }).getAttribute("aria-expanded")).toBe("true"));
});

test("Forget remains confirmed, says it cannot be undone and offers Archive instead", async () => {
  const slot = setup(() => <KnowledgeActions entry={entry} workstream={ws} />);
  fireEvent.keyDown(slot.getByRole("button", { name: `More actions for ${entry.title}` }), { key: "ArrowDown" });
  fireEvent.click(within(await slot.findByRole("menu")).getByText("Forget…"));
  const dialog = await slot.findByRole("dialog", { name: `Forget ${entry.title}?` });
  expect(dialog.textContent).toContain("Cannot be undone");
  expect(slot.rpcCalls.filter(call => call.method === "knowledgeTransition")).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole("button", { name: "Archive instead" }));
  const archive = await slot.findByRole("dialog", { name: `Archive ${entry.title}?` });
  expect(archive.textContent).toContain("Sessions already running keep what they received");
  fireEvent.click(within(archive).getByRole("button", { name: "Archive" }));
  await waitFor(() => expect(slot.rpcCalls.filter(call => call.method === "knowledgeTransition")).toHaveLength(1));
  expect(slot.rpcCalls.find(call => call.method === "knowledgeTransition")?.input).toMatchObject({ id: entry.id, expectedRevision: entry.revision, state: "archived" });
});

test("Library filters only loaded results, links Used by and selects related entries outside search results", async () => {
  const slot = setup(Library);
  const root = slot.getByRole("region", { name: "Knowledge library" });
  fireEvent.keyDown(root, { key: "/" });
  const input = slot.getByRole("textbox", { name: "Search saved knowledge" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  fireEvent.change(input, { target: { value: "finding" } });
  await slot.findByRole("list", { name: "Results" });
  fireEvent.keyDown(slot.getByRole("button", { name: "Any state" }), { key: "ArrowDown" });
  fireEvent.click(within(await slot.findByRole("menu")).getByText("Approved"));
  await waitFor(() => expect(within(slot.getByRole("list", { name: "Results" })).getAllByRole("button")).toHaveLength(1));
  expect(slot.getByText("1 of 2 loaded matches")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Envoy section" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "cortex", options: { subPath: "sections/sec_envoy" } });
  fireEvent.click(await slot.findByRole("button", { name: "Earlier finding" }));
  await slot.findByRole("heading", { name: "Earlier finding" });
  fireEvent.click(slot.getByRole("button", { name: "Results" }));
  expect(slot.container.querySelector("[data-show-detail]")).toBeNull();
});

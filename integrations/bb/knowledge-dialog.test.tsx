// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, test, vi } from "vitest";
import { workstreamRpcContract } from "./workstream-contract";
import { KnowledgeActions, KnowledgeDetail } from "./ui/knowledge";
import { Library } from "./ui/library";
import type { Knowledge, Workstream } from "./ui/types";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
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

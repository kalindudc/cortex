// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, test, vi } from "vitest";
import { CompactViewportOverrideProvider } from "./components/ui/hooks/use-compact-viewport";
import { sectionRpcContract, type Section } from "./section-contract";
import { workstreamRpcContract } from "./workstream-contract";
import { SectionPage } from "./ui/sections";
import { NeedsYou } from "./ui/review";
import type { Knowledge, Workstream } from "./ui/types";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const contract = { ...workstreamRpcContract, ...sectionRpcContract };
const now = "2026-11-11T12:00:00.000Z";
const actor = { id: "person", type: "human" } as const;
const ws: Workstream = { id: "ws_envoy", name: "Envoy", description: "", revision: 1, archived: false, actor, createdAt: now, updatedAt: now };
const entry: Knowledge = { id: "kn_first", workstreamId: ws.id, subject: "first", title: "First suggestion", text: "First suggestion text", kind: "finding", state: "candidate", facet: "orientation", applicability: { environment: { mode: "unknown" }, host: { mode: "unknown" } }, sources: [], revision: 1, actor, createdAt: now, updatedAt: now, expiresAt: null, approval: null, supersedes: [], conflicts: [], supersededBy: null };
const next = { ...entry, id: "kn_next", subject: "next", title: "Next suggestion" };
const section: Section = { id: "sec_envoy", name: "Envoy", canonicalName: "Envoy", threadCount: 1, marker: { status: "unmarked", originalTitle: null, decoratedTitle: null, error: null }, connectionJob: null, binding: { key: "sec_envoy", revision: 1, binding: { workstreamId: ws.id, topic: null, budgetTokens: 400, requiredKnowledgeIds: [] } } };
function renderReview(compact: boolean, single = false) {
  const entries = new Map((single ? [entry] : [entry, next]).map(row => [row.id, row]));
  const rpc: Partial<PluginRpcTestHandlers<typeof contract>> = {
    sectionList: () => ({ sections: [section] }),
    sectionDetail: () => ({ section, threads: [], eligibility: { computedAt: now, status: "ready", error: null, entries: [], notices: [], exclusions: [], exactText: "", estimatedTokens: 0, budgetTokens: 400 }, review: { items: [...entries.values()].filter(row => row.state === "candidate").map(row => ({ entry: row, workstream: ws, hints: [] })), total: [...entries.values()].filter(row => row.state === "candidate").length, limit: 50, offset: 0 } }),
    sectionCaptureJobs: ({ limit = 20, offset = 0 }) => ({ jobs: [], total: 0, limit, offset }),
    workstreamList: () => ({ workstreams: [ws], total: 1, limit: 100, offset: 0 }),
    knowledgeShow: ({ id }) => ({ entry: entries.get(id)!, workstream: ws }),
    sectionCandidateEdit: input => { const changed = { ...entries.get(input.id)!, text: input.text!, revision: 2 }; entries.set(input.id, changed); return { outcome: "updated", entry: changed }; },
    sectionCandidateAccept: input => { const changed = { ...entries.get(input.id)!, state: "approved" as const, applicability: input.applicability, approval: { actor, at: now }, revision: 2 }; entries.set(input.id, changed); return { outcome: "updated", entry: changed }; },
  };
  const component = () => <CompactViewportOverrideProvider isCompactViewport={compact}><SectionPage id={section.id} /></CompactViewportOverrideProvider>;
  return renderSlot({ component }, {}, { rpc: rpc as PluginRpcTestHandlers<typeof contract>, experimental_rpcContract: contract, sidebarThreads: { sections: [], threads: [] } });
}
function renderQueue(related: Knowledge[] = []) {
  const suggestion = related.length ? { ...entry, sources: [{ ref: "https://example.com/evidence", authorType: "human" as const, observedAt: now }] } : entry;
  const entries = new Map([suggestion, next, ...related].map(row => [row.id, row]));
  const rpc: Partial<PluginRpcTestHandlers<typeof contract>> = {
    reviewQueue: () => ({ items: [...entries.values()].filter(row => row.state === "candidate").map(row => ({ entry: row, workstream: ws, hints: row.id === suggestion.id ? related.map(other => ({ id: other.id, reason: "same-subject" as const })) : [] })), total: 2, limit: 100, offset: 0 }),
    knowledgeShow: ({ id }) => ({ entry: entries.get(id)!, workstream: ws }),
    knowledgeEvidence: input => ({ outcome: "updated", entry: entries.get(input.id)! }),
    knowledgeTransition: input => {
      const changed = { ...entries.get(input.id)!, state: input.state, revision: 2 };
      entries.set(input.id, changed);
      return { outcome: "updated", entry: changed };
    },
  };
  return renderSlot({ component: NeedsYou }, {}, { rpc: rpc as PluginRpcTestHandlers<typeof contract>, experimental_rpcContract: contract, sidebarThreads: { sections: [], threads: [] } });
}

test("Review root owns J/K, number choices and Enter confirmation", async () => {
  const slot = renderQueue();
  await slot.findByRole("radiogroup", { name: "Your call" });
  const root = slot.getByRole("region", { name: "Review queue" });
  fireEvent.keyDown(root, { key: "j" });
  await waitFor(() => expect(within(slot.getByRole("list", { name: "Waiting for your review" })).getByRole("button", { name: /Next suggestion/ }).getAttribute("aria-current")).toBe("true"));
  fireEvent.keyDown(root, { key: "k" });
  fireEvent.keyDown(root, { key: "1" });
  await waitFor(() => expect((slot.getByRole("button", { name: "Confirm: Approve" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.keyDown(document.body, { key: "Enter" });
  expect(slot.rpcCalls.filter(call => call.method === "knowledgeTransition")).toHaveLength(0);
  fireEvent.keyDown(root, { key: "Enter" });
  await waitFor(() => expect(slot.rpcCalls.filter(call => call.method === "knowledgeTransition")).toHaveLength(1));
  expect(slot.rpcCalls.find(call => call.method === "knowledgeTransition")?.input).toMatchObject({ id: entry.id, expectedRevision: 1, state: "approved" });
});

test("Enter on a focused Reject option selects it without writing the previously chosen Approve", async () => {
  const slot = renderQueue();
  fireEvent.click(await slot.findByRole("radio", { name: /^Approve/ }));
  const reject = slot.getByRole("radio", { name: /Reject/ });
  reject.focus();
  fireEvent.keyDown(reject, { key: "Enter" });
  expect(slot.rpcCalls.filter(call => call.method === "knowledgeTransition")).toHaveLength(0);
  expect(reject.getAttribute("aria-checked")).toBe("true");
});

test("Review retains the ninth decision shortcut after loading more related entries", async () => {
  const related = Array.from({ length: 4 }, (_, index): Knowledge => ({ ...entry, id: `kn_related${index}`, title: `Related finding ${index}`, state: "approved", revision: index + 2 }));
  const slot = renderQueue(related);
  await slot.findByRole("radio", { name: /Approve and replace Related finding 2/ });
  fireEvent.click(slot.getByRole("button", { name: "Compare 1 more of 1 not loaded" }));
  await slot.findByRole("radio", { name: /Keep Related finding 3, add these sources to it/ });
  const root = slot.getByRole("region", { name: "Review queue" });
  fireEvent.keyDown(root, { key: "9" });
  await slot.findByRole("button", { name: "Confirm: Keep Related finding 3, add these sources to it" });
  fireEvent.keyDown(root, { key: "Enter" });
  await waitFor(() => expect(slot.rpcCalls.filter(call => call.method === "knowledgeTransition")).toHaveLength(1));
  expect(slot.rpcCalls.find(call => call.method === "knowledgeEvidence")?.input).toMatchObject({ id: related[3]!.id, expectedRevision: related[3]!.revision });
  expect(slot.rpcCalls.find(call => call.method === "knowledgeTransition")?.input).toMatchObject({ id: entry.id, expectedRevision: entry.revision, state: "rejected" });
});

test("Review shortcuts ignore fields, editable content, dialogs and modified keys", async () => {
  const slot = renderQueue();
  await slot.findByRole("radiogroup", { name: "Your call" });
  const root = slot.getByRole("region", { name: "Review queue" });
  for (const tag of ["input", "textarea", "select", "div"]) {
    const field = document.createElement(tag);
    if (tag === "div") field.setAttribute("contenteditable", "true");
    root.append(field);
    fireEvent.keyDown(field, { key: "j" });
    fireEvent.keyDown(field, { key: "1" });
    fireEvent.keyDown(field, { key: "Enter" });
    field.remove();
  }
  fireEvent.keyDown(root, { key: "j", ctrlKey: true });
  fireEvent.keyDown(root, { key: "1", metaKey: true });
  expect((slot.getByRole("button", { name: "Choose an option" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(slot.getByRole("list", { name: "Waiting for your review" })).getByRole("button", { name: /First suggestion/ }).getAttribute("aria-current")).toBe("true");
  fireEvent.click(slot.getByRole("button", { name: "Edit first" }));
  const dialog = await slot.findByRole("dialog", { name: "Edit saved knowledge" });
  fireEvent.keyDown(dialog, { key: "j" });
  fireEvent.keyDown(dialog, { key: "1" });
  expect(slot.rpcCalls.filter(call => call.method === "knowledgeTransition")).toHaveLength(0);
});

async function openFirst(slot: ReturnType<typeof renderSlot>) {
  const card = await slot.findByRole("region", { name: entry.title });
  const opener = within(card).getByRole("button", { name: "Edit" });
  opener.focus();
  fireEvent.click(opener);
  return { opener, dialog: await slot.findByRole("dialog", { name: "Edit takeaway" }) };
}

for (const [name, compact] of [["desktop", false], ["phone", true]] as const) {
  test.each(["escape", "cancel", "save"])(`${name} %s restores the actual review Edit position`, async action => {
    const slot = renderReview(compact);
    const { opener, dialog } = await openFirst(slot);
    if (action === "escape") fireEvent.keyDown(dialog, { key: "Escape" });
    if (action === "cancel") fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    if (action === "save") {
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Text" }), { target: { value: "Edited text" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save for review" }));
    }
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    const returned = within(slot.getByRole("region", { name: entry.title })).getByRole("button", { name: "Edit" });
    await waitFor(() => expect(document.activeElement).toBe(returned));
    if (action !== "save") expect(returned).toBe(opener);
  });

  test(`${name} acceptance removing the row focuses the next review item`, async () => {
    const slot = renderReview(compact);
    const { dialog } = await openFirst(slot);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Everywhere" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save and accept" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(slot.queryByRole("region", { name: entry.title })).toBeNull();
    const target = within(slot.getByRole("region", { name: next.title })).getByRole("button", { name: "Edit" });
    await waitFor(() => expect(document.activeElement).toBe(target));
  });

  test.each([false, true])(`${name} next focus reveals only clipped controls in the owned scrollport (clipped=%s)`, async clipped => {
    const slot = renderReview(compact);
    const { dialog } = await openFirst(slot);
    const card = slot.getByRole("region", { name: next.title, hidden: true });
    const target = within(card).getByRole("button", { name: "Edit", hidden: true });
    const scrollport = target.closest<HTMLElement>(".overflow-y-auto")!;
    scrollport.style.height = "300px";
    scrollport.scrollTop = 37;
    Object.defineProperty(scrollport, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(scrollport, "clientTop", { configurable: true, value: 0 });
    vi.spyOn(scrollport, "getBoundingClientRect").mockReturnValue({ top: 50, bottom: 350 } as DOMRect);
    vi.spyOn(target, "getBoundingClientRect").mockImplementation(() => {
      const top = (clipped ? 400 : 100) + 37 - scrollport.scrollTop;
      return { top, bottom: top + 44 } as DOMRect;
    });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Everywhere" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save and accept" }));
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(scrollport.scrollTop).toBe(clipped ? 131 : 37);
    expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(350);
    expect(target.nextElementSibling?.textContent).toBe("Reject");
  });

  test(`${name} last acceptance focuses the stable review heading`, async () => {
    const slot = renderReview(compact, true);
    const { dialog } = await openFirst(slot);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Everywhere" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save and accept" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    const heading = slot.getByRole("heading", { name: "Takeaway review" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
}

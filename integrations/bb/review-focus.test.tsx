// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, test, vi } from "vitest";
import { CompactViewportOverrideProvider } from "./components/ui/hooks/use-compact-viewport";
import { sectionRpcContract, type Section } from "./section-contract";
import { workstreamRpcContract } from "./workstream-contract";
import { SectionPage } from "./ui/sections";
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

// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, test, vi } from "vitest";
import { ProblemCard } from "./ui/problem-card";
import { WorkstreamKnowledge } from "./ui/workstreams";
import { NeedsYou } from "./ui/review";
import { useNeedsYouBadge } from "./ui/page";
import { rpcContract } from "./server";
import type { Problem, ProblemEntry } from "./problem-contract";
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const actor = { id: "human", type: "human" } as const;
const at = "2026-01-01T00:00:00.000Z";
const any = { mode: "not-applicable" } as const;
const ws = { id: "ws_one", revision: 1, name: "Envoy", description: "", archived: false, actor, createdAt: at, updatedAt: at };
const entry = { id: "kn_one", revision: 2, workstreamId: ws.id, subject: "production", title: "Manual production writes", text: "Ask first", kind: "finding" as const, state: "approved" as const, facet: "operating rule", applicability: { environment: any, host: any }, sources: [], actor, createdAt: at, updatedAt: at, expiresAt: null, approval: { actor, at }, supersedes: [], supersededBy: null, conflicts: [] };
const row: ProblemEntry = { id: entry.id, revision: 2, title: entry.title, reason: "topic", detail: 'Filed under the topic "operating rule", which this section doesn\'t share' };
const problem: Problem = { id: "sec_one:unreached", kind: "unreached", sectionId: "sec_one", sectionName: "Envoy", severity: "Held back", blocking: false, title: "1 approved entry never reaches a thread in Envoy", consequence: "No thread gets them. Fix each one below.", details: "kn_one · revision 2", actions: [], entries: [row] };
const base = { sectionList: () => ({ sections: [] }), problems: () => ({ problems: [problem] }), knowledgeShow: () => ({ entry, workstream: ws }), reviewQueue: () => ({ items: [], total: 0, limit: 100, offset: 0 }) };
const input = { sectionId: "sec_one", id: entry.id, expectedRevision: entry.revision };
const same = (match: "text" | "title") => ({ reason: "duplicate", match, duplicateOf: "kn_brief" }) as const;
test.each([ ["duplicate text", same("text"), ["Archive duplicate", "Open the brief's copy"]], ["duplicate title", same("title"), ["Open the brief's copy", "Archive this one", "Ignore here"]], ["topic", { reason: "topic" }, ["Move to shared basics", "Ignore here"]], ["scope", { reason: "scope" }, ["Ignore here", "Archive"]] ] as const)("%s row has visible detail, reason and only its safe buttons", async (_name, extra, buttons) => {
  const slot = renderSlot({ component: () => <ProblemCard problem={{ ...problem, entries: [{ ...row, ...extra }] }} /> }, {}, { rpc: base, experimental_rpcContract: rpcContract });
  const el = slot.container.querySelector('[data-part="ProblemEntry"]')! as HTMLElement;
  expect(within(el).getByText(row.detail)).toBeTruthy();
  expect(within(el).getByText("Never reaches a thread")).toBeTruthy();
  expect(within(el).getAllByRole("button").map(button => button.textContent)).toEqual([entry.title, ...buttons]);
  expect(slot.queryByRole("button", { name: "Open them" })).toBeNull();
  fireEvent.click(within(el).getByRole("button", { name: entry.title }));
  expect(slot.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "sections/sec_one/knowledge/kn_one" } });
});
test("Move refusal gives plain words and says it is waiting in Review", async () => {
  const slot = renderSlot({ component: () => <ProblemCard problem={problem} /> }, {}, { rpc: { ...base, knowledgeMoveToBasics: () => ({ result: { outcome: "updated", entry: { ...entry, state: "candidate", facet: "orientation", revision: 3, approval: null } }, waitingInReview: true, refusal: "An approved entry already owns this subject/applicability" }) }, experimental_rpcContract: rpcContract });
  fireEvent.click(slot.getByRole("button", { name: "Move to shared basics" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Waiting in Review. Another approved entry already covers"), expect.anything()));
  expect(slot.rpcCalls.find(call => call.method === "knowledgeMoveToBasics")?.input).toEqual(input);
});
test("Ignore refreshes Needs you, badge and knowledge markers; Undo restores the warning", async () => {
  let ignored = false;
  function Page() { const badge = useNeedsYouBadge(); return <><span data-testid="badge">{badge?.count ?? 0}</span><NeedsYou /><WorkstreamKnowledge sectionId="sec_one" id={ws.id} selectedId={entry.id} onSelect={() => {}} /></>; }
  const slot = renderSlot({ component: Page }, {}, { rpc: { ...base, problems: () => ({ problems: ignored ? [] : [problem] }), workstreamShow: () => ({ workstream: ws, entries: [entry], total: 1, limit: 100, offset: 0 }), problemEntryDismiss: () => { ignored = true; return { dismissed: true }; }, problemEntryUndo: () => { ignored = false; return { dismissed: false }; } }, experimental_rpcContract: rpcContract, sidebarThreads: { sections: [], threads: [] } });
  await waitFor(() => expect(slot.getAllByText("Never reaches a thread")).toHaveLength(3));
  expect(slot.getByTestId("badge").textContent).toBe("1");
  const list = slot.getByRole("list", { name: "All knowledge" });
  expect(within(list).getByText("Topic not shared")).toBeTruthy();
  // The last sheet is All knowledge's entry detail; Needs you's detail pane also shows the entry, with the fix under Your call.
  const sheet = Array.from(slot.container.querySelectorAll('[data-part="KnowledgeSheet"]')).at(-1) as HTMLElement;
  fireEvent.click(within(sheet).getByRole("button", { name: "Ignore here" }));
  await waitFor(() => expect(slot.queryByText("Never reaches a thread")).toBeNull());
  expect(slot.getByTestId("badge").textContent).toBe("0");
  expect(slot.rpcCalls.find(call => call.method === "problemEntryDismiss")?.input).toEqual(input);
  const undo = toast.mock.calls.find(call => call[0].startsWith("Ignored here"))?.[1]?.action;
  expect(undo?.label).toBe("Undo");
  await undo.onClick();
  await waitFor(() => expect(slot.getAllByText("Never reaches a thread")).toHaveLength(3));
  expect(slot.rpcCalls.find(call => call.method === "problemEntryUndo")?.input).toEqual(input);
});
test.each([ ["Archive duplicate", same("text")], ["Archive this one", same("title")], ["Archive", { reason: "scope" }] ] as const)("%s offers the existing revision-checked Undo", async (label, extra) => {
  const slot = renderSlot({ component: () => <ProblemCard problem={{ ...problem, entries: [{ ...row, ...extra }] }} /> }, {}, { rpc: { ...base, knowledgeTransition: () => ({ outcome: "updated", entry: { ...entry, revision: 3, state: "archived" } }) }, experimental_rpcContract: rpcContract });
  fireEvent.click(slot.getByRole("button", { name: label }));
  await waitFor(() => expect(toast).toHaveBeenCalled());
  expect(slot.rpcCalls.find(call => call.method === "knowledgeTransition")?.input).toMatchObject({ id: entry.id, expectedRevision: 2, state: "archived" });
  const undo = toast.mock.calls.at(-1)?.[1]?.action;
  expect(undo?.label).toBe("Undo");
  await undo.onClick();
  expect(slot.rpcCalls.filter(call => call.method === "knowledgeTransition").at(-1)?.input).toMatchObject({ id: entry.id, expectedRevision: 3, state: "approved" });
});
test("Open the brief's copy opens the entry already in the brief, not the unreached one", () => {
  const slot = renderSlot({ component: () => <ProblemCard problem={{ ...problem, entries: [{ ...row, ...same("title") }] }} /> }, {}, { rpc: base, experimental_rpcContract: rpcContract });
  fireEvent.click(slot.getByRole("button", { name: "Open the brief's copy" }));
  expect(slot.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "sections/sec_one/knowledge/kn_brief" } });
});

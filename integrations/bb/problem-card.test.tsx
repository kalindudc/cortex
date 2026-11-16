// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, test } from "vitest";
import { ProblemCard } from "./ui/problem-card";
import { rpcContract } from "./server";
import { NeedsYou } from "./ui/review";
import { useNeedsYouBadge } from "./ui/page";
import type { Problem } from "./problem-contract";
afterEach(cleanup);
const problem: Problem = { id: "capture:request", kind: "capture", sectionId: "sec_one", sectionName: "Payments", severity: "Failed", blocking: false, title: "A takeaway could not be saved in Payments", consequence: "This takeaway is not available to new threads.", details: "raw failure", actions: [{ kind: "retry-capture", label: "Retry", id: "request" }] };
test("card has actionable anatomy and folded raw detail", () => {
  const slot = renderSlot({ component: () => <ProblemCard problem={problem} /> }, {}, { rpc: { sectionList: () => ({ sections: [] }) }, experimental_rpcContract: rpcContract });
  expect(slot.getByText(problem.title)).toBeTruthy();
  expect(slot.getByText(problem.consequence)).toBeTruthy();
  expect(slot.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(slot.getByText("Details").closest("details")?.open).toBe(false);
});
test("compact card omits section name; open navigates to the exact section", () => {
  const slot = renderSlot({ component: () => <ProblemCard compact problem={{ ...problem, actions: [{ kind: "open-section", label: "Open the brief" }] }} /> }, {}, { rpc: { sectionList: () => ({ sections: [] }) }, experimental_rpcContract: rpcContract });
  expect(slot.getByText("A takeaway could not be saved")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Open the brief" }));
  expect(slot.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "sections/sec_one/brief" } });
});
test("capture Retry and Dismiss call the existing recovery RPCs", async () => {
  const job = { requestId: "request", sectionId: "sec_one", intendedKnowledgeId: "kn_one", knowledgeId: null, status: "failed" as const, entry: null, error: "raw failure" };
  const slot = renderSlot({ component: () => <ProblemCard problem={{ ...problem, actions: [...problem.actions, { kind: "dismiss-capture", label: "Dismiss", id: "request" }] }} /> }, {}, { rpc: {
    sectionList: () => ({ sections: [] }),
    sectionCaptureRetry: () => job,
    sectionCaptureDismiss: () => ({ requestId: "request", dismissed: true as const }),
  }, experimental_rpcContract: rpcContract });
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(slot.rpcCalls.some(call => call.method === "sectionCaptureRetry" && JSON.stringify(call.input) === JSON.stringify({ requestId: "request" }))).toBe(true));
  await waitFor(() => expect(slot.getByRole("button", { name: "Dismiss" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(slot.rpcCalls.find(call => call.method === "sectionCaptureDismiss")?.input).toEqual({ sectionId: "sec_one", requestId: "request" }));
});
const actor = { id: "human", type: "human" } as const;
const at = "2026-01-01T00:00:00.000Z";
const any = { mode: "not-applicable" } as const;
const ws = { id: "ws_one", revision: 1, name: "Payments", description: "", archived: false, actor, createdAt: at, updatedAt: at };
const knowledge = (id: string, title: string, text: string, state: "approved" | "candidate") => ({ id, revision: 1, workstreamId: ws.id, subject: id, title, text, kind: "finding" as const, state, facet: "protocol", applicability: { environment: any, host: any }, sources: [], actor, createdAt: at, updatedAt: at, expiresAt: null, approval: state === "approved" ? { actor, at } : null, supersedes: [], supersededBy: null, conflicts: [] });
const suggestion = { entry: knowledge("kn_suggested", "A suggested entry", "Check it", "candidate"), workstream: ws, hints: [] };
const unreached: Problem = { id: "sec_one:unreached", kind: "unreached", sectionId: "sec_one", sectionName: "Payments", severity: "Held back", blocking: false, title: "2 approved entries never reach a thread in Payments", consequence: "No thread gets them. Fix each one below.", details: "", actions: [], entries: [
  { id: "kn_rule", revision: 1, title: "Ask before production writes", reason: "topic", detail: 'Filed under the topic "operating rule", which this section doesn\'t share' },
  { id: "kn_cert", revision: 1, title: "Keep one delegated name", reason: "duplicate", match: "title", duplicateOf: "kn_brief", detail: "Same title as an entry in the brief, but worded differently. Read both before archiving either." },
] };
const entries: Record<string, ReturnType<typeof knowledge>> = {
  kn_rule: knowledge("kn_rule", "Ask before production writes", "Ask first", "approved"),
  kn_cert: knowledge("kn_cert", "Keep one delegated name", "Keep one delegated name, or delete the Certificate", "approved"),
  kn_brief: knowledge("kn_brief", "Keep one delegated name", "Keep one delegated name", "approved"),
};
const queueRpc = (problems: Problem[], reviewQueue: () => unknown) => ({
  sectionList: () => ({ sections: [] }), problems: () => ({ problems }), reviewQueue,
  knowledgeShow: (input: unknown) => ({ entry: entries[(input as { id: string }).id], workstream: ws }),
});
test("problems are rows in the review list, before suggestions, and stay when the suggestions read fails", async () => {
  const slot = renderSlot({ component: NeedsYou }, {}, { rpc: queueRpc([problem], () => { throw new Error("Suggestions unavailable"); }), experimental_rpcContract: rpcContract, sidebarThreads: { sections: [], threads: [] } });
  const list = await slot.findByRole("list", { name: "Problems" });
  expect(within(list).getByRole("button").textContent).toContain("A takeaway could not be saved");
  expect(await slot.findByText("1 problem · suggestions not loaded")).toBeTruthy();
  expect(slot.queryByRole("region", { name: "Problems" })).toBeNull();
  // The first row is selected and its card fills the detail pane, as a suggestion's decision does.
  expect(within(slot.container.querySelector(".cortex-detail") as HTMLElement).getByRole("button", { name: "Retry" })).toBeTruthy();
});
test("each unreached entry is its own row; its detail compares the brief's copy and offers the fix; J and K cross into suggestions", async () => {
  const blocker = { ...problem, id: "human", sectionId: null, sectionName: null, severity: "Blocks" as const, blocking: true, title: "Cortex cannot identify you", actions: [] };
  const rpc = queueRpc([unreached, blocker], () => ({ items: [suggestion], total: 7, limit: 100, offset: 0 }));
  const slot = renderSlot({ component: NeedsYou }, {}, { rpc, experimental_rpcContract: rpcContract, sidebarThreads: { sections: [], threads: [] } });
  const list = await slot.findByRole("list", { name: "Problems" });
  expect(within(list).getAllByRole("button").map(row => row.textContent)).toEqual([
    "Cortex cannot identify youBlocks · Cortex",
    "Ask before production writesNever reaches a thread · Topic not shared · Payments",
    "Keep one delegated nameNever reaches a thread · Same title · Payments",
  ]);
  expect(slot.getByText("10")).toBeTruthy();
  fireEvent.click(within(list).getByRole("button", { name: /Keep one delegated name/ }));
  const detail = slot.container.querySelector(".cortex-detail") as HTMLElement;
  expect(await within(detail).findByText("Already in the brief")).toBeTruthy();
  expect(within(detail).getByText("No thread in Payments gets this entry.")).toBeTruthy();
  expect(within(detail).getByRole("button", { name: "Open the brief's copy" })).toBeTruthy();
  const queue = slot.getByRole("region", { name: "Review queue" });
  fireEvent.keyDown(queue, { key: "j" });
  expect(within(slot.getByRole("list", { name: "Waiting for your review" })).getByRole("button").getAttribute("aria-current")).toBe("true");
  fireEvent.keyDown(queue, { key: "k" });
  await waitFor(() => expect(within(list).getAllByRole("button")[2]!.getAttribute("aria-current")).toBe("true"));
  function Badge() { const badge = useNeedsYouBadge(); return <span>{badge?.count}</span>; }
  const badge = renderSlot({ component: Badge }, {}, { rpc, experimental_rpcContract: rpcContract });
  expect(await badge.findByText("10")).toBeTruthy();
});

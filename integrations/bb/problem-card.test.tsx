// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
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
test("lasting problems remain visible when the suggestions read fails", async () => {
  const slot = renderSlot({ component: NeedsYou }, {}, { rpc: {
    sectionList: () => ({ sections: [] }), problems: () => ({ problems: [problem] }),
    reviewQueue: () => { throw new Error("Suggestions unavailable"); },
  }, experimental_rpcContract: rpcContract, sidebarThreads: { sections: [], threads: [] } });
  expect(await slot.findByText(problem.title)).toBeTruthy();
  expect(await slot.findByText("1 problem · suggestions not loaded")).toBeTruthy();
});
test("Needs you groups blockers before other problems and suggestions, and badge adds both", async () => {
  const blocker = { ...problem, id: "human", sectionId: null, sectionName: null, severity: "Blocks" as const, blocking: true, title: "Cortex cannot identify you", actions: [] };
  const rpc = {
    sectionList: () => ({ sections: [] }),
    problems: () => ({ problems: [problem, blocker] }),
    reviewQueue: () => ({ items: [], total: 7, limit: 100, offset: 0 }),
  };
  const slot = renderSlot({ component: NeedsYou }, {}, { rpc, experimental_rpcContract: rpcContract, sidebarThreads: { sections: [], threads: [] } });
  expect(await slot.findByText("2 problems · 7 suggestions")).toBeTruthy();
  const headings = slot.getAllByRole("heading").map(row => row.textContent);
  expect(headings.indexOf("Blocking work")).toBeLessThan(headings.indexOf("Getting in the way"));
  expect(headings.indexOf("Getting in the way")).toBeLessThan(headings.indexOf("to review"));
  function Badge() { const badge = useNeedsYouBadge(); return <span>{badge?.count}</span>; }
  const badge = renderSlot({ component: Badge }, {}, { rpc, experimental_rpcContract: rpcContract });
  expect(await badge.findByText("9")).toBeTruthy();
});

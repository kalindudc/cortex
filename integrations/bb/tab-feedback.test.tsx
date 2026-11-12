// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, test } from "vitest";
import { MemoryPanel } from "./panel/memory";
import { CortexPanel } from "./panel/panel";
import type { MemoryState } from "./memory";
import type { rpcContract } from "./server";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { CortexTaskDetail, CortexThreadState } from "./state";
import { CORTEX_TAB_LIST, CORTEX_TAB_TRIGGER } from "./ui/parts";
import { SectionView } from "./ui/sections";
import { ThreadContextPage } from "./ui/thread-context";
import type { ThreadContext } from "./ui/types";

const threadId = "thr_tabfeedback";
const at = "2026-11-12T12:00:00Z";
const actor = { id: "you", type: "human" } as const;
const workstream = { id: "ws_tabs", name: "Tabs", description: "", revision: 1, archived: false, actor, createdAt: at, updatedAt: at };
const binding = { workstreamId: workstream.id, topic: null, budgetTokens: 1000, requiredKnowledgeIds: [] };
const context: ThreadContext = {
  threadId, revision: 1, binding, bindingRevision: 1, bindingSource: "section", inheritedFrom: null, workstream,
  applicability: { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } },
  entries: [], notices: [], exclusions: [], overrides: [], grants: [], exactText: "", estimatedTokens: 0, budgetTokens: 1000,
  status: "ready", error: null, dismissed: false, dismissedPreference: null, bindingChanged: false, lastReceipt: null,
};
const section = { id: "sec_tabs", name: "Tabs", canonicalName: "Tabs", threadCount: 0,
  binding: { key: "sec_tabs", revision: 1, binding }, marker: { status: "unmarked" as const, originalTitle: null, decoratedTitle: null, error: null }, connectionJob: null };
const memory: MemoryState = { threadId, setting: "auto", override: null, mode: "write", child: false, view: null };
const state: CortexThreadState = { threadId, lane: "cortex", focusTaskId: 1, pinnedTaskId: null, canWrite: true,
  links: [{ id: 1, title: "Feedback", status: "open", lane: "cortex", activity: 1, authored: true, manual: false }], health: { kind: "ok" } };
const detail: CortexTaskDetail = {
  task: { id: 1, title: "Feedback", status: "open", lane: "cortex", tags: [], body: "", created: 1, updated: 1, memoryExcluded: false },
  updates: [], authors: {}, staleness: { verdict: "fresh" }, sync: { syncedAt: 1, changed: [], missing: [], old: false, ageDays: 0, notFolded: 0 }, progress: null,
};
const rpc = {
  threadContext: () => context, memory: () => memory, threadState: () => state, task: () => detail, taskRows: () => ({ tasks: [] }),
  workstreamShow: () => ({ workstream, entries: [], total: 0, limit: 100, offset: 0 }),
  workstreamHistory: () => ({ revisions: [], total: 0, limit: 20, offset: 0 }),
  draftJobs: () => ({ jobs: [], total: 0, limit: 20, offset: 0 }),
  deliveryReceipts: () => ({ receipts: [], total: 0, limit: 20, offset: 0 }),
} satisfies Partial<PluginRpcTestHandlers<typeof rpcContract>>;

afterEach(cleanup);

function expectSharedTabs(list: HTMLElement, count: number, active: string) {
  for (const token of CORTEX_TAB_LIST.split(" ")) expect(list.classList.contains(token), token).toBe(true);
  const tabs = within(list).getAllByRole("tab");
  expect(tabs).toHaveLength(count);
  for (const tab of tabs) {
    for (const token of CORTEX_TAB_TRIGGER.split(" ")) expect(tab.classList.contains(token), token).toBe(true);
    expect(tab.classList.contains("focus-visible:ring-ring")).toBe(true);
    expect(tab.closest("[data-cortex]")).not.toBeNull();
  }
  expect(within(list).getByRole("tab", { name: active }).getAttribute("data-state")).toBe("active");
}

test("section tabs use the shared underline and inactive-only hover style", async () => {
  const slot = renderSlot({ component: SectionView }, {
    data: { section, threads: [], eligibility: { ...context, computedAt: at }, review: { items: [], total: 0, limit: 50, offset: 0 } },
    sections: [section], workstreams: [workstream], tab: "edits", onConnect: () => {}, onCapture: () => {}, onEdit: () => {}, onStop: () => {}, onMark: () => {}, onRetry: () => {},
  }, { rpc });
  expectSharedTabs(await slot.findByRole("tablist", { name: "Section views" }), 4, "Edits");
});

test("Memory tabs use the same trigger and list classes", async () => {
  const slot = renderSlot({ component: MemoryPanel }, { threadId, environment: null, params: null }, { rpc });
  expectSharedTabs(await slot.findByRole("tablist"), 3, "Section brief");
});

test("task tabs use the same trigger and list classes", async () => {
  const slot = renderSlot({ component: CortexPanel }, { threadId, environment: null, params: null }, { rpc });
  expectSharedTabs(await slot.findByRole("tablist"), 2, "Overview");
});

test("full thread context tabs use the same trigger and list classes", async () => {
  const slot = renderSlot({ component: ThreadContextPage }, { threadId }, { rpc });
  expectSharedTabs(await slot.findByRole("tablist", { name: "Thread context views" }), 3, "Next context");
});

test("the scoped pointer rule covers roots, enabled controls and choice labels, not disabled controls or menu items", () => {
  const css = readFileSync("ui/cortex.css", "utf8");
  const selector = css.match(/([^{}]+)\{\s*cursor: pointer;\s*\}/)?.[1]?.trim();
  expect(selector).toBeTruthy();
  if (!selector) return;
  const root = document.createElement("div");
  root.innerHTML = `<button data-cortex id="summary"></button><div data-cortex>
    <button id="button"></button><div role="button" id="role-button"></div><div role="tab" id="tab"></div><div role="switch" id="switch"></div>
    <div role="radio" id="radio"></div><div role="checkbox" id="checkbox"></div><div role="option" id="option"></div>
    <details><summary id="disclosure">Details</summary></details><a href="/" id="link">Link</a>
    <label id="native-label"><input type="radio" id="native-radio"></label><label id="custom-label"><button role="checkbox"></button></label>
    <button disabled id="disabled"></button><button aria-disabled="true" id="aria-disabled"></button><div role="option" data-disabled id="data-disabled"></div>
    <fieldset disabled><button id="fieldset-button"></button><label id="disabled-label"><input type="checkbox"></label></fieldset>
    <label id="text-label"><input type="text"></label><a id="no-href">Anchor</a>
    <button role="menuitem" id="menuitem"></button><button role="menuitemradio" id="menu-radio"></button><button role="menuitemcheckbox" id="menu-checkbox"></button>
  </div><button id="outside"></button>`;
  for (const id of ["summary", "button", "role-button", "tab", "switch", "radio", "checkbox", "option", "disclosure", "link", "native-label", "native-radio", "custom-label"]) {
    expect(root.querySelector(`#${id}`)!.matches(selector), id).toBe(true);
  }
  for (const id of ["disabled", "aria-disabled", "data-disabled", "fieldset-button", "disabled-label", "text-label", "no-href", "menuitem", "menu-radio", "menu-checkbox", "outside"]) {
    expect(root.querySelector(`#${id}`)!.matches(selector), id).toBe(false);
  }
});

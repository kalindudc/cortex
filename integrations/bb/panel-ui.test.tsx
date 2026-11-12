// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, type PluginRpcTestHandlers, type RenderSlotOptions, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { selectTask } from "./panel/selection";
import { sectionRpcMethods } from "./section-contract";
import type { rpcContract } from "./server";
import type { CortexTaskDetail, CortexThreadState } from "./state";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const THREAD = "thr_paneltest";
const SECTION = "sec_paneltest";
type App = Awaited<ReturnType<typeof loadPluginApp>>;
type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
let app: App;
beforeAll(async () => { app = await loadPluginApp(() => import("./app")); });
beforeEach(() => { toast.mockClear(); toast.error.mockClear(); });
afterEach(() => { cleanup(); selectTask(THREAD, null); });

function state(overrides: Partial<CortexThreadState> = {}): CortexThreadState {
  return {
    threadId: THREAD, lane: "infrastructure", focusTaskId: 908, pinnedTaskId: null, canWrite: true,
    links: [
      { id: 908, title: "Envoy rollout", status: "open", lane: "infrastructure", activity: 2, authored: true, manual: false },
      { id: 909, title: "Gateway checks", status: "review", lane: "infrastructure", activity: 1, authored: false, manual: true },
    ],
    health: { kind: "ok" }, ...overrides,
  };
}
function detail(id = 908): CortexTaskDetail {
  return {
    task: { id, title: id === 908 ? "Envoy rollout" : "Gateway checks", lane: "infrastructure", status: "open", tags: ["rollout"], body: "## Goal\n- Replace ingress\n## Plan\n- [x] Install\n- [ ] Verify\n## Decisions\n" + "Saved decision. ".repeat(220), created: Date.now(), updated: Date.now(), memoryExcluded: false },
    updates: [{ id: 1, author: "kal", kind: "note", summary: "Checked the gateway", body: null, created: Date.now() }],
    authors: { kal: { kind: "you", label: "You" } }, staleness: { verdict: "fresh" },
    sync: { syncedAt: Date.now(), changed: [], missing: [], old: false, ageDays: 0, notFolded: 1 }, progress: { done: 1, total: 2 },
  };
}
function mount(overrides: Partial<Handlers> = {}, thread = state(), options: RenderSlotOptions<typeof rpcContract> = {}) {
  const rows = new Map<number, CortexTaskDetail>();
  const get = (id: number) => rows.get(id) ?? detail(id);
  const rpc = {
    threadState: () => thread, task: ({ taskId }) => get(taskId),
    setStatus: ({ taskId, status }) => {
      const next = { ...get(taskId), task: { ...get(taskId).task, status } };
      rows.set(taskId, next); return next;
    },
    pin: ({ taskId }) => ({ ...thread, pinnedTaskId: taskId }), postNote: ({ taskId }) => get(taskId),
    ...overrides,
  } as Handlers;
  const tab = app.tabs.find(tab => tab.id === "cortex")! as Extract<App["tabs"][number], { context: { kind: "thread" }; availability: "action" }>;
  return renderSlot(tab, { threadId: THREAD, environment: null, params: null }, { ...options, rpc });
}
const calls = (slot: ReturnType<typeof mount>, method: string) => slot.inspection.rpcCalls.filter(call => call.method === method).map(call => call.input);
async function openMenu(button: HTMLElement) {
  fireEvent.pointerDown(button, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(button);
}
function sectionDetail() {
  return sectionRpcMethods.sectionDetail.output.parse({
    section: { id: SECTION, name: "Envoy cluster-service", canonicalName: "Envoy cluster-service", threadCount: 2,
      binding: { key: SECTION, revision: 1, binding: { workstreamId: "ws_envoy", topic: "orientation", budgetTokens: 1000, requiredKnowledgeIds: [] } },
      marker: { status: "unmarked", originalTitle: null, decoratedTitle: null, error: null }, connectionJob: null },
    threads: [{ id: THREAD, name: "Envoy rollout" }],
    eligibility: { computedAt: new Date().toISOString(), status: "ready", error: null, entries: [], notices: [], exclusions: [], exactText: "", estimatedTokens: 0, budgetTokens: 1000 },
    review: { items: [], total: 2, limit: 50, offset: 0 },
  });
}
const sidebarThreads: RenderSlotOptions["sidebarThreads"] = {
  sections: [{ id: SECTION, name: "Envoy cluster-service", createdAt: 1, updatedAt: 1 }],
  threads: [{ id: THREAD, name: "Envoy rollout", sectionId: SECTION } as never],
};

test.each(["over-budget", "missing-required", "unavailable", "unbound"] as const)("section bridge refuses delivery claims for %s", async status => {
  const data = sectionDetail();
  data.eligibility.status = status;
  const slot = mount({ sectionDetail: () => data }, state(), { sidebarThreads });
  await slot.findByText(/Sends nothing:/);
  expect(slot.container.textContent).not.toContain("go in");
});

describe("redesigned task panel", () => {
  test("shows the selected task's position in the switcher chip", async () => {
    const slot = mount();
    const switcher = await slot.findByRole("button", { name: "Thread tasks (2)" });
    expect(switcher.textContent).toContain("#908");
    expect(switcher.textContent).toContain("1 of 2 thread tasks");
  });

  test("the status track changes status with Undo and keeps the current step's menu", async () => {
    const slot = mount();
    const track = await slot.findByRole("group", { name: "Task status" });
    expect(within(track).getByRole("button", { name: /Status: Open/ }).getAttribute("aria-current")).toBe("step");
    fireEvent.click(within(track).getByRole("button", { name: "In review" }));
    await waitFor(() => expect(calls(slot, "setStatus")).toEqual([{ threadId: THREAD, taskId: 908, status: "review" }]));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Moved #908 to In review", expect.anything()));
    const [, options] = toast.mock.calls.find(([message]) => message === "Moved #908 to In review")!;
    await act(async () => options.action.onClick());
    expect(calls(slot, "setStatus").at(-1)).toEqual({ threadId: THREAD, taskId: 908, status: "open" });
    await openMenu(slot.getByRole("button", { name: /Status: Open/ }));
    expect(await slot.findByRole("menuitem", { name: /Blocked/ })).toBeTruthy();
  });

  test("Blocked is separate from the lifecycle and toggles back to Open", async () => {
    const slot = mount();
    fireEvent.click(await slot.findByRole("button", { name: "Block task" }));
    const unblock = await slot.findByRole("button", { name: "Unblock task" });
    expect(unblock.getAttribute("aria-pressed")).toBe("true");
    expect(slot.getByRole("button", { name: "Unblock" })).toBeTruthy();
    fireEvent.click(unblock);
    await waitFor(() => expect(calls(slot, "setStatus").map(input => (input as { status: string }).status)).toEqual(["blocked", "open"]));
  });

  test("the docked composer keeps a draft across tabs and posts from Overview with Cmd+Enter", async () => {
    const slot = mount();
    const note = await slot.findByRole("textbox", { name: "Note" }) as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "Verified the rollout" } });
    fireEvent.mouseDown(slot.getByRole("tab", { name: /Activity/ }));
    await slot.findByText("Checked the gateway");
    expect(slot.getByRole("textbox", { name: "Note" })).toBe(note);
    fireEvent.mouseDown(slot.getByRole("tab", { name: "Overview" }));
    expect(note.value).toBe("Verified the rollout");
    fireEvent.keyDown(note, { key: "Enter", metaKey: true });
    await waitFor(() => expect(calls(slot, "postNote")).toEqual([{ threadId: THREAD, taskId: 908, text: "Verified the rollout" }]));
    await waitFor(() => expect(note.value).toBe(""));
  });

  test("note drafts never move to another selected task", async () => {
    const slot = mount();
    const note = await slot.findByRole("textbox", { name: "Note" });
    fireEvent.change(note, { target: { value: "Only for task 908" } });
    await openMenu(slot.getByRole("button", { name: "Thread tasks (2)" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: /Gateway checks/ }));
    await slot.findByRole("heading", { name: "Gateway checks" });
    expect((slot.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe("");
    expect(calls(slot, "postNote")).toEqual([]);
  });

  test("unfolded updates have a Show action even when source files are fresh", async () => {
    const slot = mount();
    const note = await slot.findByTestId("unfolded-updates");
    expect(note.textContent).toContain("1 update is not in the body yet.");
    fireEvent.click(within(note).getByRole("button", { name: "Show" }));
    expect(await slot.findByText("Checked the gateway")).toBeTruthy();
    expect(slot.getByRole("tab", { name: /Activity/ }).getAttribute("aria-selected")).toBe("true");
  });

  test("Expand all lives beside the tabs and still controls every body section", async () => {
    const slot = mount();
    const expand = await slot.findByRole("button", { name: "Expand all" });
    expect(expand.closest("header")).not.toBeNull();
    expect(slot.getAllByTestId("section-preview")).toHaveLength(2);
    fireEvent.click(expand);
    await waitFor(() => expect(slot.queryAllByTestId("section-preview")).toHaveLength(0));
    fireEvent.click(slot.getByRole("button", { name: "Collapse all" }));
    await waitFor(() => expect(slot.getAllByTestId("section-preview")).toHaveLength(3));
  });

  test("read-only shows status but offers neither track writes nor a composer", async () => {
    const slot = mount({}, state({ canWrite: false }));
    const track = await slot.findByRole("group", { name: "Task status" });
    expect(within(track).queryByRole("button")).toBeNull();
    expect(slot.getByTestId("status-pill").textContent).toContain("Open");
    expect(slot.queryByRole("textbox", { name: "Note" })).toBeNull();
    expect(slot.getByText("Update cortex to change status from bb.")).toBeTruthy();
  });

  test("the section brief bridge uses existing data and navigates to the section", async () => {
    const slot = mount({ sectionDetail }, state(), { sidebarThreads });
    const bridge = await slot.findByRole("button", { name: /Envoy cluster-service brief/ });
    expect(bridge.textContent).toContain("0 go in");
    expect(bridge.textContent).toContain("2 to review");
    fireEvent.click(bridge);
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "cortex", options: { subPath: `sections/${SECTION}` } });
    expect(calls(slot, "sectionDetail")).toEqual([{ sectionId: SECTION, limit: 50, offset: 0 }]);
  });

  test("no bridge when the section is unbound or its read failed", async () => {
    const data = sectionDetail();
    data.section.binding.binding = null;
    const slot = mount({ sectionDetail: () => data }, state(), { sidebarThreads });
    await slot.findByRole("heading", { name: "Envoy rollout" });
    await waitFor(() => expect(calls(slot, "sectionDetail")).toHaveLength(1));
    expect(slot.queryByRole("button", { name: /brief/ })).toBeNull();
    slot.lifecycle.unmount();
    const failed = mount({ sectionDetail: () => { throw new Error("Unavailable"); } }, state(), { sidebarThreads });
    await failed.findByRole("heading", { name: "Envoy rollout" });
    expect(failed.queryByRole("button", { name: /brief/ })).toBeNull();
    expect(failed.getByRole("textbox", { name: "Note" })).toBeTruthy();
  });
});

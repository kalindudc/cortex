// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { experimental_useAppPanel, useBbNavigate, useSdk, type PluginThreadAction } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, type PluginRpcTestHandlers, type RenderSlotOptions, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { MemoryState, MemoryView } from "./memory";
import { MemorySummary } from "./panel/memory";
import { selectTask } from "./panel/selection";
import type { rpcContract } from "./server";
import type { CortexTaskDetail, CortexThreadState } from "./state";
import type { ThreadContext, Workstream } from "./ui/types";
import { threadContextSchema } from "./workstream-contract";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const THREAD = "thr_aaaaaaaa";
const AUTHOR_THREAD = "thr_dddddddd";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type App = Awaited<ReturnType<typeof loadPluginApp>>;
let app: App;
beforeAll(async () => {
  app = await loadPluginApp(() => import("./app"));
});
// A fixed midday, so "Today" and "Yesterday" never depend on when the suite runs.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 17, 12, 0, 0));
  toast.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  cleanup();
  selectTask(THREAD, null);
  vi.useRealTimers();
});

function threadState(overrides: Partial<CortexThreadState> = {}): CortexThreadState {
  return {
    threadId: THREAD,
    lane: "cortex",
    focusTaskId: 1,
    pinnedTaskId: null,
    canWrite: true,
    links: [
      { id: 1, title: "First task", status: "open", lane: "cortex", activity: 3, authored: true, manual: false },
      { id: 2, title: "Second task", status: "blocked", lane: "cortex", activity: 2, authored: false, manual: true },
    ],
    health: { kind: "ok" },
    ...overrides,
  };
}

function detail(id: number, overrides: Partial<CortexTaskDetail> = {}): CortexTaskDetail {
  const now = Date.now();
  return {
    task: {
      id,
      title: `Title ${id}`,
      status: "open",
      lane: "cortex",
      tags: ["plan"],
      body: `Body of task ${id}`,
      created: now - 3 * DAY,
      updated: now - 4 * 60_000,
      memoryExcluded: false,
    },
    updates: [
      { id: 10, author: "pi-01a145fc-cdce", summary: "created", body: null, created: now - 3 * DAY, kind: "created" },
      { id: 11, author: `bb-${AUTHOR_THREAD}`, summary: "older note", body: null, created: now - DAY - HOUR, kind: "note" },
      {
        id: 12,
        author: "kal",
        summary: "status \u2192 open",
        body: null,
        created: now - 2 * HOUR,
        kind: "status",
        to: "open",
      },
      { id: 13, author: "pi-01a145fc-cdce", summary: "newer note", body: "detail text", created: now - HOUR, kind: "note" },
    ],
    staleness: { verdict: "fresh" },
    sync: { syncedAt: now - DAY, changed: [], missing: [], old: false, ageDays: 1, notFolded: 2 },
    progress: { done: 3, total: 13 },
    authors: {
      "pi-01a145fc-cdce": { kind: "pi", label: "pi session 01a145fc" },
      [`bb-${AUTHOR_THREAD}`]: { kind: "thread", label: "implement @533", threadId: AUTHOR_THREAD },
      kal: { kind: "you", label: "You" },
    },
    ...overrides,
  };
}

function memoryView(overrides: Partial<MemoryView> = {}): MemoryView {
  return {
    role: "writer",
    lane: "cortex",
    error: "",
    stale: null,
    saving: false,
    recallBudget: 2,
    focus: [],
    inContext: [],
    stats: { prompts: 0, lookups: 0, lastMs: 0, chars: 0, checkpoints: 0, breadcrumbs: 0, silentRuns: 0 },
    ...overrides,
  };
}

function memoryState(overrides: Partial<MemoryState> = {}): MemoryState {
  return {
    threadId: THREAD,
    setting: "auto",
    override: null,
    mode: "write",
    child: false,
    view: memoryView(),
    ...overrides,
  };
}

function threadContext(overrides: Partial<ThreadContext> = {}): ThreadContext {
  return threadContextSchema.parse({
    threadId: THREAD,
    revision: 0,
    binding: null,
    bindingRevision: 0,
    bindingSource: "none",
    inheritedFrom: null,
    workstream: null,
    applicability: { environment: { mode: "not-applicable" }, host: { mode: "not-applicable" } },
    entries: [],
    notices: [],
    exclusions: [],
    overrides: [],
    grants: [],
    exactText: "",
    estimatedTokens: 0,
    budgetTokens: 400,
    status: "unbound",
    error: null,
    dismissed: false,
    dismissedPreference: null,
    bindingChanged: false,
    lastReceipt: null,
    ...overrides,
  });
}

function boundContext(overrides: Partial<ThreadContext> = {}): ThreadContext {
  const workstream: Workstream = {
    id: "ws_cortex",
    name: "Cortex",
    description: "Shared context for Cortex integration tests",
    revision: 1,
    archived: false,
    createdAt: new Date(Date.now() - DAY).toISOString(),
    updatedAt: new Date(Date.now()).toISOString(),
    actor: { id: "kal", type: "human" },
  };
  return threadContext({
    revision: 1,
    binding: { workstreamId: workstream.id, topic: "memory", budgetTokens: 400, requiredKnowledgeIds: [] },
    bindingRevision: 1,
    bindingSource: "section",
    workstream,
    status: "ready",
    ...overrides,
  });
}

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;

function handlers(state: CortexThreadState = threadState(), overrides: Partial<Handlers> = {}): Handlers {
  const details = new Map<number, CortexTaskDetail>();
  const get = (id: number) => details.get(id) ?? detail(id);
  let dismissed: boolean | null = null;
  const base: Partial<Handlers> = {
    threadState: () => state,
    task: ({ taskId }) => get(taskId),
    pin: ({ taskId }) => ({ ...state, pinnedTaskId: taskId, focusTaskId: taskId ?? state.focusTaskId }),
    link: () => state,
    unlink: () => state,
    setStatus: ({ taskId, status }) => {
      const next = { ...get(taskId), task: { ...get(taskId).task, status } };
      details.set(taskId, next);
      return next;
    },
    setMemoryExcluded: ({ taskId, excluded }) => {
      const next = { ...get(taskId), task: { ...get(taskId).task, memoryExcluded: excluded } };
      details.set(taskId, next);
      return next;
    },
    postNote: ({ taskId }) => get(taskId),
    searchTasks: ({ query }) => ({
      tasks: query === "widget" ? [{ id: 44, title: "Widget task", lane: "cortex", status: "review" }] : [],
    }),
    recentTasks: () => ({
      lane: "cortex",
      tasks: [
        { id: 479, title: "Reading cursor", lane: "cortex", status: "review" },
        { id: 478, title: "Vaults", lane: "cortex", status: "draft" },
      ],
    }),
    memory: () => memoryState(),
    taskRows: ({ ids }) => ({ tasks: ids.map(id => ({ id, title: `Stream ${id}`, lane: "cortex", status: "open" })) }),
    setMemoryMode: ({ mode }) => memoryState({ override: mode }),
    threadContext: ({ threadId }) => threadContext({ threadId, dismissed: dismissed === true, dismissedPreference: dismissed }),
    contextVisibility: ({ threadIds }) => ({
      threads: threadIds.map(threadId => ({ threadId, dismissed: dismissed === true, dismissedPreference: dismissed })),
    }),
    setContextDismissed: ({ threadId, dismissed: next }) => {
      dismissed = next;
      return threadContext({ threadId, dismissed: next === true, dismissedPreference: next });
    },
    deliveryReceipts: () => ({ receipts: [], total: 0, limit: 20, offset: 0 }),
  };
  return { ...base, ...overrides } as Handlers;
}

const calls = (slot: { inspection: { rpcCalls: Array<{ method: string; input: unknown }> } }, method: string) =>
  slot.inspection.rpcCalls.filter(call => call.method === method).map(call => call.input);

type ActionTab = Extract<App["tabs"][number], { context: { kind: "thread" }; availability: "action" }>;
const taskTab = () => app.tabs.find(tab => tab.id === "cortex")! as ActionTab;
const memoryTab = () => app.tabs.find(tab => tab.id === "cortex-memory")! as ActionTab;
const contextSegment = () => app.threadContextSegments.find(segment => segment.id === "cortex-context")!;
const contextCard = () => app.threadContextCardSections.find(section => section.id === "cortex-context")!;
const tabProps = { threadId: THREAD, environment: null, params: null };
const panel = (rpc: Handlers = handlers(), params: unknown = null) =>
  renderSlot(taskTab(), { ...tabProps, params: params as never }, { rpc });

const openCall = (id = "cortex") => ({
  method: "openTab",
  options: { tab: { id, context: { kind: "thread" }, availability: "action" } },
});

const targetThread = {
  id: THREAD,
  projectId: "proj_1",
  parentThreadId: null,
  parentNotifications: "auto" as const,
  archivedAt: null,
  pinnedAt: null,
  sectionId: null,
  isUnread: false,
  status: "idle" as const,
  environment: null,
};

function headerAction(rpc: Handlers = handlers(), options: RenderSlotOptions<typeof rpcContract> = {}) {
  const registration = app.threadActions.find(action => action.id === "cortex-task")!;
  let item: PluginThreadAction | null = null;
  function Probe({ threadIds }: { threadIds: readonly string[] }) {
    const data = registration.useData!({ threadIds });
    const sdk = useSdk();
    const navigate = useBbNavigate();
    const experimental_panel = experimental_useAppPanel();
    item = registration.item({ thread: targetThread, data, sdk, navigate, experimental_panel });
    return null;
  }
  const slot = renderSlot({ component: Probe }, { threadIds: [THREAD] }, {
    rpc,
    experimental_panel: { openTab: () => true },
    ...options,
  });
  return { ...slot, item: () => item, Probe };
}

const cardProps = { threadId: THREAD, projectId: "proj_1", environment: null };
const segmentProps = {
  threadId: THREAD,
  projectId: "proj_1",
  environment: null,
  segments: [],
  isExpanded: false,
  onToggle: vi.fn(),
};
const memoryIcon = (rpc: Handlers = handlers(), options: RenderSlotOptions<typeof rpcContract> = {}) =>
  renderSlot({ component: contextSegment().summary }, segmentProps, { rpc, ...options });

function contextSurface(rpc: Handlers = handlers(), options: RenderSlotOptions<typeof rpcContract> = {}) {
  const registration = contextSegment();
  function Surface() {
    const [isExpanded, setExpanded] = useState(false);
    const props = { ...segmentProps, isExpanded, onToggle: () => setExpanded(value => !value) };
    const visible = registration.useVisible!(props);
    const Summary = registration.summary;
    const Details = registration.details!;
    return (
      <section data-testid="context-surface" data-visible={String(visible)}>
        {visible ? <Summary {...props} /> : null}
        {visible ? <Details {...props} /> : null}
      </section>
    );
  }
  return renderSlot({ component: Surface }, {}, {
    rpc,
    experimental_panel: { openTab: () => true },
    ...options,
  });
}

/** Radix menus open from the keyboard in jsdom (no pointer events). */
async function openMenu(trigger: HTMLElement) {
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
}

test("registers the Cortex and Memory tabs, header action, context segment and card, and message directive", () => {
  expect(app.tabs.map(tab => [tab.id, tab.layout])).toEqual([
    ["cortex", "flush"],
    ["cortex-memory", "flush"],
    ["cortex-takeaway", undefined],
  ]);
  expect(app.tabs.map(tab => [tab.context, tab.availability])).toEqual([
    [{ kind: "thread" }, "action"],
    [{ kind: "thread" }, "action"],
    [{ kind: "thread" }, "action"],
  ]);
  expect(app.threadActions.map(action => [action.id, action.placement])).toEqual([
    ["cortex-task", "header"],
    ["cortex-context", undefined],
    ["cortex-save-takeaway", undefined],
  ]);
  expect(app.threadContextSegments.map(segment => segment.id)).toEqual(["cortex-context"]);
  expect(app.threadContextCardSections.map(section => section.id)).toEqual(["cortex-context"]);
  expect(app.threadHeaderActions).toEqual([]);
  // Not a prompt-box action: bb mounts only the three most-used plugins' actions there.
  expect(app.composerCustomizations).toEqual([]);
  expect(app.messageDirectives.map(directive => directive.id)).toEqual(["cortex"]);
});

describe("header", () => {
  test("shows the id, lane, tags, title, status, freshness, progress and counts", async () => {
    const slot = panel();
    expect(await slot.findByRole("heading", { name: "Title 1" })).toBeTruthy();
    expect(slot.getByText("#plan")).toBeTruthy();
    expect(slot.getByRole("button", { name: /Status: Open/ })).toBeTruthy();
    expect(slot.getByRole("button", { name: /Ready for review/ })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Files unchanged" })).toBeTruthy();
    expect(slot.getByRole("progressbar", { name: "Plan progress" }).getAttribute("aria-valuenow")).toBe("3");
    expect(slot.getByText("3/13 tasks")).toBeTruthy();
    expect(slot.getByText("Updated 4m ago · 4 updates · 2 not yet in the body")).toBeTruthy();
  });

  test("the status menu lists every status with their keys and checks the current one; a key picks", async () => {
    const slot = panel();
    await openMenu(await slot.findByRole("button", { name: /Status: Open/ }));
    const menu = await slot.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map(item => item.textContent)).toEqual(["Draftd", "Openo", "In reviewr", "Blockedb", "Donex"]);
    expect(items.map(item => item.getAttribute("aria-checked"))).toEqual(["false", "true", "false", "false", "false"]);
    expect(within(menu).getByText(/Nobody is notified/)).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(menu, { key: "x" });
    });
    await waitFor(() => expect(calls(slot, "setStatus")).toEqual([{ threadId: THREAD, taskId: 1, status: "done" }]));
    expect(await slot.findByRole("button", { name: /Status: Done/ })).toBeTruthy();
    expect(toast).toHaveBeenCalledWith("Moved #1 to Done", expect.objectContaining({ action: expect.anything() }));
  });

  test("the next step applies at once and reconciles; Undo is a second change back", async () => {
    let release: (value: CortexTaskDetail) => void = () => {};
    const slot = panel(
      handlers(threadState(), {
        setStatus: ({ taskId, status }) =>
          status === "review"
            ? new Promise(resolve => {
                release = resolve;
              })
            : { ...detail(taskId), task: { ...detail(taskId).task, status } },
      }),
    );
    fireEvent.click(await slot.findByRole("button", { name: /Ready for review/ }));
    expect(await slot.findByRole("button", { name: /Status: In review/ })).toBeTruthy();
    await act(async () => {
      release({ ...detail(1), task: { ...detail(1).task, status: "review" } });
    });
    expect(slot.getByRole("button", { name: /Mark done/ })).toBeTruthy();
    const [, options] = toast.mock.calls.find(([text]) => text === "Moved #1 to In review") ?? [];
    await act(async () => {
      (options as { action: { onClick: () => void } }).action.onClick();
    });
    await waitFor(() =>
      expect(calls(slot, "setStatus")).toEqual([
        { threadId: THREAD, taskId: 1, status: "review" },
        { threadId: THREAD, taskId: 1, status: "open" },
      ]),
    );
    expect(await slot.findByRole("button", { name: /Status: Open/ })).toBeTruthy();
    expect(toast).toHaveBeenCalledWith("#1 is back to Open");
  });

  test("a failed change reverts and shows an error toast", async () => {
    const slot = panel(
      handlers(threadState(), {
        setStatus: () => {
          throw new Error("task 1 is locked");
        },
      }),
    );
    fireEvent.click(await slot.findByRole("button", { name: /Ready for review/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not move #1: task 1 is locked"));
    expect(slot.getByRole("button", { name: /Status: Open/ })).toBeTruthy();
  });

  test("read-only when cortex cannot write as the user", async () => {
    const slot = panel(handlers(threadState({ canWrite: false })));
    expect(await slot.findByTestId("status-pill")).toBeTruthy();
    expect(slot.queryByRole("button", { name: /Status:/ })).toBeNull();
    expect(slot.queryByRole("button", { name: /Ready for review/ })).toBeNull();
    expect(slot.getByText("Update cortex to change status from bb.")).toBeTruthy();
    fireEvent.mouseDown(slot.getByRole("tab", { name: /Activity/ }));
    expect(await slot.findByText("newer note")).toBeTruthy();
    expect(slot.queryByLabelText("Note")).toBeNull();
  });
});

describe("freshness", () => {
  test("stale lists the files in a callout; clicking the pill returns to Overview and highlights it", async () => {
    const stale = detail(1, {
      staleness: { verdict: "stale", reason: "changed: a.ts" },
      sync: { syncedAt: Date.now() - 6 * HOUR, changed: ["src/a.ts"], missing: ["src/gone.ts"], old: false, ageDays: 0, notFolded: 2 },
    });
    const slot = panel(handlers(threadState(), { task: () => stale }));
    const pill = await slot.findByRole("button", { name: "Stale · 2 files" });
    const callout = slot.getByTestId("freshness-callout");
    expect(within(callout).getByText("src/a.ts")).toBeTruthy();
    expect(within(callout).getByText("src/gone.ts")).toBeTruthy();
    expect(callout.textContent).toContain("2 updates are not yet folded into the body.");
    fireEvent.mouseDown(slot.getByRole("tab", { name: /Activity/ }));
    await slot.findByText("newer note");
    fireEvent.click(pill);
    const shown = await slot.findByTestId("freshness-callout");
    expect(shown.className).toContain("ring-2");
    fireEvent.click(within(shown).getByText("See them in Activity"));
    expect(await slot.findByText("newer note")).toBeTruthy();
  });

  test("unverifiable is a neutral callout with the reason", async () => {
    const slot = panel(
      handlers(threadState(), { task: () => detail(1, { staleness: { verdict: "unverifiable", reason: "elsewhere" } }) }),
    );
    expect((await slot.findByRole("button", { name: "Not checked" })).getAttribute("title")).toBe(
      "Freshness not checked: elsewhere",
    );
    expect(slot.getByTestId("freshness-callout").textContent).toContain("Freshness not checked: elsewhere.");
  });

  test("fresh has no callout", async () => {
    const slot = panel();
    await slot.findByRole("button", { name: "Files unchanged" });
    expect(slot.queryByTestId("freshness-callout")).toBeNull();
  });
});

describe("overview", () => {
  const long = [
    "# Plan: title",
    "Lead paragraph.",
    "## First",
    "First section text.",
    "## Second",
    `- second item\n- another\n${"x".repeat(2600)}`,
    "## Third",
    "Third preview line.",
  ].join("\n");

  test("a long body opens on its first section; the rest fold to a preview; Expand all opens them", async () => {
    const slot = panel(handlers(threadState(), { task: () => detail(1, { task: { ...detail(1).task, body: long } }) }));
    expect(await slot.findByText("Lead paragraph.")).toBeTruthy();
    expect(slot.queryByText("# Plan: title")).toBeNull();
    expect(slot.getByText("First section text.")).toBeTruthy();
    expect(slot.getAllByTestId("section-preview").map(p => p.textContent)).toEqual(["second item", "Third preview line."]);
    expect(slot.getByText("2 items")).toBeTruthy();
    fireEvent.click(slot.getByText("Expand all"));
    expect(await slot.findByText("Third preview line.")).toBeTruthy();
    expect(slot.queryAllByTestId("section-preview")).toEqual([]);
    fireEvent.click(slot.getByText("Collapse all"));
    await waitFor(() => expect(slot.getAllByTestId("section-preview")).toHaveLength(3));
  });

  test("a short body shows fully open", async () => {
    const body = "## One\nalpha\n## Two\nbeta\n## Three\ngamma";
    const slot = panel(handlers(threadState(), { task: () => detail(1, { task: { ...detail(1).task, body } }) }));
    expect(await slot.findByText("gamma")).toBeTruthy();
    expect(slot.queryAllByTestId("section-preview")).toEqual([]);
    expect(slot.getByText("Collapse all")).toBeTruthy();
  });
});

describe("activity", () => {
  test("newest first, grouped by day, with the body sync divider and compact status rows", async () => {
    const slot = panel();
    fireEvent.mouseDown(await slot.findByRole("tab", { name: /Activity/ }));
    await slot.findByText("newer note");
    const groups = slot.getAllByRole("region").map(region => region.getAttribute("aria-label"));
    expect(groups.slice(0, 2)).toEqual(["Today", "Yesterday"]);
    const today = within(slot.getByRole("region", { name: "Today" }));
    expect(today.getAllByRole("listitem").map(item => item.textContent)).toEqual([
      expect.stringContaining("newer note"),
      expect.stringMatching(/You.*moved this to.*Open/),
    ]);
    const yesterday = within(slot.getByRole("region", { name: "Yesterday" }));
    expect(yesterday.getAllByRole("listitem")[0]?.textContent).toContain("older note");
    expect(slot.getByRole("separator").textContent).toContain("Body last synced here");
    expect(slot.getAllByTestId("activity-compact").at(-1)?.textContent).toContain("created this task");
    fireEvent.click(slot.getByText("Show details"));
    expect(await slot.findByText("detail text")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "implement @533" }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: AUTHOR_THREAD });
  });

  test("shows the newest 50 and pages older ones", async () => {
    const now = Date.now();
    const updates = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      author: "kal",
      summary: `note ${i + 1}`,
      body: null,
      created: now - (60 - i) * 60_000,
      kind: "note" as const,
    }));
    const slot = panel(handlers(threadState(), { task: () => detail(1, { updates }) }));
    fireEvent.mouseDown(await slot.findByRole("tab", { name: /Activity/ }));
    expect(await slot.findByText("note 60")).toBeTruthy();
    expect(slot.queryByText("note 10")).toBeNull();
    fireEvent.click(slot.getByText("Show older (10)"));
    expect(await slot.findByText("note 1")).toBeTruthy();
  });

  test("the composer posts summary and body with a chosen status on ⌘/Ctrl+Enter, then clears", async () => {
    const slot = panel();
    fireEvent.mouseDown(await slot.findByRole("tab", { name: /Activity/ }));
    const note = (await slot.findByLabelText("Note")) as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "Shipped it\n\n- detail" } });
    await openMenu(slot.getByRole("button", { name: /Keep status/ }));
    fireEvent.click(await slot.findByRole("menuitem", { name: /Set Done/ }));
    expect(await slot.findByRole("button", { name: /Set Done/ })).toBeTruthy();
    fireEvent.keyDown(note, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(calls(slot, "postNote")).toEqual([{ threadId: THREAD, taskId: 1, text: "Shipped it\n\n- detail", status: "done" }]),
    );
    await waitFor(() => expect(note.value).toBe(""));
    expect(slot.getByRole("button", { name: /Keep status/ })).toBeTruthy();
    expect(toast).toHaveBeenCalledWith("Note posted");
  });

  test("a failed post keeps the text and shows the error inline; plain Enter is a new line", async () => {
    const slot = panel(
      handlers(threadState(), {
        postNote: () => {
          throw new Error("The first line is the note's summary: at most 4096 characters.");
        },
      }),
    );
    fireEvent.mouseDown(await slot.findByRole("tab", { name: /Activity/ }));
    const note = (await slot.findByLabelText("Note")) as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "too long" } });
    fireEvent.keyDown(note, { key: "Enter" });
    expect(calls(slot, "postNote")).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Post" }));
    expect((await slot.findByRole("alert")).textContent).toContain("at most 4096 characters");
    expect(note.value).toBe("too long");
  });
});

describe("switcher and more menu", () => {
  test("the switcher lists the thread's tasks with their origin; picking one switches", async () => {
    const slot = panel();
    await openMenu(await slot.findByRole("button", { name: "Thread tasks (2)" }));
    const menu = await slot.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map(item => item.textContent)).toEqual([
      expect.stringContaining("First task"),
      expect.stringMatching(/Second task.*linked/),
    ]);
    expect(within(menu).getByText("Tasks this thread posted to appear on their own.")).toBeTruthy();
    fireEvent.click(within(menu).getByText("Second task"));
    expect(await slot.findByRole("heading", { name: "Title 2" })).toBeTruthy();
  });

  test("searching in the switcher and picking a result links and selects it", async () => {
    const slot = panel();
    await openMenu(await slot.findByRole("button", { name: "Thread tasks (2)" }));
    fireEvent.change(await slot.findByLabelText("Search tasks to link"), { target: { value: "widget" } });
    fireEvent.click(await slot.findByText("Widget task"));
    await waitFor(() => expect(calls(slot, "link")).toEqual([{ threadId: THREAD, taskId: 44 }]));
    expect(await slot.findByRole("heading", { name: "Title 44" })).toBeTruthy();
  });

  test("more: pin, copy the app command, and unlink only a linked task", async () => {
    const slot = panel();
    await openMenu(await slot.findByRole("button", { name: "More" }));
    const unlink = await slot.findByRole("menuitem", { name: /Unlink/ });
    expect(unlink.getAttribute("aria-disabled")).toBe("true");
    expect(unlink.textContent).toContain("posted here");
    fireEvent.click(slot.getByRole("menuitem", { name: /Copy cortex app 1/ }));
    await waitFor(() => expect(slot.inspection.experimental_clipboardWrites).toEqual([{ text: "cortex app 1" }]));
    await openMenu(slot.getByRole("button", { name: "More" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: /Pin as focus/ }));
    await waitFor(() => expect(calls(slot, "pin")).toEqual([{ threadId: THREAD, taskId: 1 }]));
    expect(await slot.findByRole("button", { name: /Pinned as this thread's focus/ })).toBeTruthy();
  });

  test("more: copy the task body as its raw Markdown", async () => {
    const body = "## Goal\n\n- [ ] ship `it`\n";
    const slot = panel(handlers(threadState(), { task: () => detail(1, { task: { ...detail(1).task, body } }) }));
    await openMenu(await slot.findByRole("button", { name: "More" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Copy task body" }));
    await waitFor(() => expect(slot.inspection.experimental_clipboardWrites).toEqual([{ text: body }]));
    expect(toast).toHaveBeenCalledWith("Copied the body of #1");
  });

  test("more: a task with no body offers no body to copy", async () => {
    for (const body of [null, "  \n"]) {
      const slot = panel(handlers(threadState(), { task: () => detail(1, { task: { ...detail(1).task, body } }) }));
      await openMenu(await slot.findByRole("button", { name: "More" }));
      const copy = await slot.findByRole("menuitem", { name: "Copy task body" });
      expect(copy.getAttribute("aria-disabled")).toBe("true");
      cleanup();
    }
  });

  test("more: exclude a task from agent memory, see it marked, and include it again", async () => {
    const slot = panel();
    expect(await slot.findByRole("heading", { name: "Title 1" })).toBeTruthy();
    expect(slot.queryByText("excluded from memory")).toBeNull();
    await openMenu(slot.getByRole("button", { name: "More" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Exclude task from automatic memory (all threads)" }));
    await waitFor(() => expect(calls(slot, "setMemoryExcluded")).toEqual([{ threadId: THREAD, taskId: 1, excluded: true }]));
    expect(await slot.findByText("excluded from memory")).toBeTruthy();
    expect(toast).toHaveBeenCalledWith("#1 is out of automatic memory in every thread; reading it by id still works");
    await openMenu(slot.getByRole("button", { name: "More" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Include task in automatic memory (all threads)" }));
    await waitFor(() => expect(calls(slot, "setMemoryExcluded")).toHaveLength(2));
    expect(calls(slot, "setMemoryExcluded")[1]).toEqual({ threadId: THREAD, taskId: 1, excluded: false });
    await waitFor(() => expect(slot.queryByText("excluded from memory")).toBeNull());
    expect(toast).toHaveBeenCalledWith("#1 is back in automatic memory in every thread");
  });

  test("more: a cortex without memory exclusion offers no memory item", async () => {
    const old = detail(1, { task: { ...detail(1).task, memoryExcluded: null } });
    const slot = panel(handlers(threadState(), { task: () => old }));
    await openMenu(await slot.findByRole("button", { name: "More" }));
    expect(await slot.findByRole("menuitem", { name: "Copy task body" })).toBeTruthy();
    expect(slot.queryByRole("menuitem", { name: /memory/ })).toBeNull();
  });

  test("more: a refused clipboard write says so", async () => {
    const slot = renderSlot(
      taskTab(),
      tabProps,
      { rpc: handlers(), experimental_copyToClipboard: () => Promise.resolve(false) },
    );
    await openMenu(await slot.findByRole("button", { name: "More" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Copy task body" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not copy to the clipboard."));
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("other states", () => {
  test("empty: explains auto-linking, offers recent tasks and a search, and links one", async () => {
    const slot = panel(handlers(threadState({ links: [], focusTaskId: null })));
    expect(await slot.findByText(/No Cortex task on this thread yet/)).toBeTruthy();
    expect(await slot.findByText("Recent in cortex")).toBeTruthy();
    expect(slot.getByText("Reading cursor")).toBeTruthy();
    const search = slot.getByLabelText("Search tasks to link");
    fireEvent.change(search, { target: { value: "widget" } });
    expect(await slot.findByText("Widget task")).toBeTruthy();
    expect(slot.getByText("Matching tasks")).toBeTruthy();
    expect(calls(slot, "searchTasks")).toEqual([{ query: "widget" }]);
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click((await slot.findAllByRole("button", { name: /Link/ }))[0] as HTMLElement);
    await waitFor(() => expect(calls(slot, "link")).toEqual([{ threadId: THREAD, taskId: 479 }]));
    // A linked task opens at once.
    expect(await slot.findByRole("heading", { name: "Title 479" })).toBeTruthy();
  });

  test("an error shows a notice with Retry", async () => {
    let fail = true;
    const slot = panel(
      handlers(threadState(), {
        threadState: () => {
          if (fail) throw new Error("cortex is down");
          return threadState();
        },
      }),
    );
    expect((await slot.findByRole("alert")).textContent).toContain("cortex is down");
    fail = false;
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    expect(await slot.findByRole("heading", { name: "Title 1" })).toBeTruthy();
  });

  test("loading shows a skeleton only after a short delay", async () => {
    vi.useFakeTimers();
    try {
      const slot = panel(handlers(threadState(), { threadState: () => new Promise(() => {}) }));
      expect(slot.queryByTestId("cortex-loading")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      expect(slot.getByTestId("cortex-loading")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  test("restores a legacy task param, offers to link it, and ignores invalid stored params", async () => {
    const slot = panel(handlers(), { taskId: 7 });
    expect(await slot.findByRole("heading", { name: "Title 7" })).toBeTruthy();
    await openMenu(slot.getByRole("button", { name: "More" }));
    expect(await slot.findByRole("menuitem", { name: /Link to this thread/ })).toBeTruthy();
    cleanup();
    const invalid = panel(handlers(), { taskId: "7; rm" });
    expect(await invalid.findByRole("heading", { name: "Title 1" })).toBeTruthy();
  });

  test("refetches on its own thread, a shown task, and reconnects only", async () => {
    const slot = panel();
    await slot.findByRole("heading", { name: "Title 1" });
    const counts = () => [calls(slot, "threadState").length, calls(slot, "task").length];
    const [threads, tasks] = counts();
    await slot.behavior.emitRealtime("thread", { threadId: "thr_zzzzzzzz" });
    await slot.behavior.emitRealtime("task", { taskId: 99 });
    expect(counts()).toEqual([threads, tasks]);
    await slot.behavior.emitRealtime("thread", { threadId: THREAD });
    await waitFor(() => expect(counts()).toEqual([(threads ?? 0) + 1, tasks]));
    await slot.behavior.emitRealtime("task", { taskId: 1 });
    await waitFor(() => expect(counts()).toEqual([(threads ?? 0) + 2, (tasks ?? 0) + 1]));
    await slot.behavior.emitRealtime("all", null);
    await waitFor(() => expect(counts()).toEqual([(threads ?? 0) + 3, (tasks ?? 0) + 2]));
  });
});

describe("header task action", () => {
  test("names the focus task with its status icon and opens the Cortex tab", async () => {
    const slot = headerAction();
    await waitFor(() => expect(slot.item()?.label).toBe("#1 · Open"));
    expect(slot.item()?.detail).toBe("First task");
    expect(slot.item()?.icon).toBe("Circle");
    await act(async () => { await slot.item()!.run({ requestRename: vi.fn() }); });
    expect(slot.inspection.experimental_panelCalls).toEqual([openCall()]);
  });

  test("is absent without a focus task and represents every status with a label and icon", async () => {
    const empty = headerAction(handlers(threadState({ links: [], focusTaskId: null })));
    await waitFor(() => expect(calls(empty, "threadState")).toHaveLength(1));
    await act(async () => {});
    expect(empty.item()).toBeNull();
    empty.lifecycle.unmount();
    const cases = [
      ["draft", "Draft", "CircleDot"],
      ["open", "Open", "Circle"],
      ["review", "In review", "Eye"],
      ["blocked", "Blocked", "OctagonPause"],
      ["done", "Done", "CircleCheck"],
    ] as const;
    for (const [status, label, icon] of cases) {
      const state = threadState({
        links: [{ ...threadState().links[0]!, status }],
        health: { kind: "stale", message: "changed: x" },
      });
      const slot = headerAction(handlers(state));
      await waitFor(() => expect(slot.item()?.label).toBe(`#1 · ${label}`));
      expect(slot.item()?.detail).toBe("First task");
      expect(slot.item()?.icon).toBe(icon);
      slot.lifecycle.unmount();
    }
  });

  test("the context segment never displaces the header's task action", async () => {
    const task = headerAction();
    const memory = contextSurface();
    await waitFor(() => expect(task.item()?.label).toBe("#1 · Open"));
    expect(await memory.findByText("Memory: nothing loaded yet")).toBeTruthy();
    memory.lifecycle.unmount();
    expect(task.item()?.label).toBe("#1 · Open");
    expect(calls(task, "threadState")).toEqual([{ threadId: THREAD }]);
  });

  test("the task action remains when the memoryChip setting hides the marker", async () => {
    const settings = { memoryChip: false };
    const task = headerAction(handlers(), { settings });
    const memory = contextSurface(handlers(), { settings });
    await waitFor(() => expect(task.item()?.label).toBe("#1 · Open"));
    expect(await memory.findByRole("button", { name: /Cortex memory/ })).toBeTruthy();
    expect(memory.queryByText(/^Memory:/)).toBeNull();
    expect(calls(memory, "memory")).toEqual([]);
  });

  test("the host owns header placement while both pane kinds retain the task action and tab", async () => {
    expect(app.threadActions.find(action => action.id === "cortex-task")?.placement).toBe("header");
    for (const threadContextKind of ["banner", "card"] as const) {
      const slot = headerAction(handlers(), { threadContextKind });
      await waitFor(() => expect(slot.item()?.label).toBe("#1 · Open"));
      await act(async () => { await slot.item()!.run({ requestRename: vi.fn() }); });
      expect(slot.inspection.experimental_panelCalls).toEqual([openCall()]);
      slot.lifecycle.unmount();
    }
    expect(taskTab().availability).toBe("action");
  });

  test("is absent and skips task reads when the taskChip setting is off", async () => {
    const slot = headerAction(handlers(), { settings: { taskChip: false } });
    await act(async () => {});
    expect(slot.item()).toBeNull();
    expect(slot.inspection.rpcCalls).toEqual([]);
  });

  test("refetches listed tasks on matching thread, task, workstream and reconnect signals; releases hidden headers", async () => {
    const slot = headerAction();
    await waitFor(() => expect(slot.item()?.label).toBe("#1 · Open"));
    const count = () => calls(slot, "threadState").length;
    const before = count();
    await slot.behavior.emitRealtime("thread", { threadId: "thr_zzzzzzzz" });
    await slot.behavior.emitRealtime("task", { taskId: 99 });
    await slot.behavior.emitRealtime("memory", { threadId: THREAD });
    await slot.behavior.emitRealtime("workstreams", { threadId: "thr_zzzzzzzz" });
    expect(count()).toBe(before);
    await slot.behavior.emitRealtime("thread", { threadId: THREAD });
    await waitFor(() => expect(count()).toBe(before + 1));
    await slot.behavior.emitRealtime("task", { taskId: 2 });
    await waitFor(() => expect(count()).toBe(before + 2));
    await slot.behavior.emitRealtime("workstreams", { threadId: THREAD });
    await waitFor(() => expect(count()).toBe(before + 3));
    await slot.behavior.emitRealtime("all", null);
    await waitFor(() => expect(count()).toBe(before + 4));
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    expect(count()).toBe(before + 4);
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(count()).toBe(before + 5));
    slot.lifecycle.rerender(<slot.Probe threadIds={[]} />);
    expect(slot.item()).toBeNull();
    await slot.behavior.emitRealtime("thread", { threadId: THREAD });
    await slot.behavior.emitRealtime("all", null);
    expect(count()).toBe(before + 5);
  });

  test("a declined header open leaves selection alone and reports why", async () => {
    const tab = panel();
    await tab.findByRole("heading", { name: "Title 1" });
    await act(async () => { selectTask(THREAD, 2); });
    await tab.findByRole("heading", { name: "Title 2" });
    const slot = headerAction(handlers(), { experimental_panel: { openTab: () => false } });
    await waitFor(() => expect(slot.item()?.label).toBe("#1 · Open"));
    await act(async () => { await slot.item()!.run({ requestRename: vi.fn() }); });
    expect(slot.inspection.experimental_panelCalls).toEqual([openCall()]);
    expect(toast.error).toHaveBeenCalledWith("bb could not open the Cortex tab here.");
    expect(tab.getByRole("heading", { name: "Title 2" })).toBeTruthy();
  });
});

describe("memory context marker", () => {
  const withMemory = (memory: MemoryState) => handlers(threadState(), { memory: () => memory });
  const stale = { id: 421, detail: "changed: a.ts" };
  const mark = (slot: ReturnType<typeof memoryIcon>) => slot.getByText(/^Memory:/).parentElement!;

  test("its tone and accessible text follow the memory-state priority; off hides the marker", async () => {
    const cases: Array<[MemoryState, string, RegExp]> = [
      [memoryState({ view: memoryView({ inContext: [{ id: 1, via: "summary" }] }) }), "info", /1 stream in context/],
      [memoryState(), "info", /nothing loaded yet/],
      [memoryState({ view: memoryView({ stale }) }), "warning", /@421 is stale: changed: a\.ts/],
      [memoryState({ view: memoryView({ saving: true }) }), "info", /automatic save turn/],
      [memoryState({ view: memoryView({ error: "boom", stale, saving: true }) }), "error", /error: boom/],
      [memoryState({ view: memoryView({ stale, saving: true }) }), "warning", /@421 is stale/],
      [memoryState({ view: null }), "muted", /no agent session since the Cortex plugin loaded/],
    ];
    for (const [memory, tone, title] of cases) {
      const slot = memoryIcon(withMemory(memory));
      await waitFor(() => expect(mark(slot).getAttribute("title")).toMatch(title));
      expect(mark(slot).getAttribute("data-tone")).toBe(tone);
      expect(slot.getByText(/^Memory:/).className).toContain("sr-only");
      expect(mark(slot).querySelector("[aria-hidden]")).toBeTruthy();
      slot.lifecycle.unmount();
    }
    for (const memory of [
      memoryState({ view: memoryView({ role: "off" }) }),
      memoryState({ mode: "off", view: null }),
    ]) {
      const slot = memoryIcon(withMemory(memory));
      await waitFor(() => expect(calls(slot, "memory")).toHaveLength(1));
      await waitFor(() => expect(slot.queryByText(/^Memory:/)).toBeNull());
      slot.lifecycle.unmount();
    }
  });

  test("expands in the public context row and opens the Memory tab from its details", async () => {
    const slot = contextSurface(withMemory(memoryState({ view: null })));
    const trigger = await slot.findByRole("button", { name: "Cortex memory. Not connected to a workstream. Memory: no agent session since the Cortex plugin loaded. Task #1: First task, Open. Show details" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(slot.queryByRole("button", { name: "Open Memory tab" })).toBeNull();
    fireEvent.click(trigger);
    const open = await slot.findByRole("button", { name: "Open Memory tab" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(open);
    expect(slot.inspection.experimental_panelCalls).toEqual([openCall("cortex-memory")]);
  });

  test("a failed read is an error and loading is muted", async () => {
    const failing = memoryIcon(handlers(threadState(), {
      memory: () => { throw new Error("cortex is down"); },
    }));
    expect(await failing.findByText("Memory: error: cortex is down")).toBeTruthy();
    expect(mark(failing).getAttribute("data-tone")).toBe("error");
    failing.lifecycle.unmount();
    const loading = memoryIcon(handlers(threadState(), { memory: () => new Promise(() => {}) }));
    expect((await loading.findByText("Memory: loading")).parentElement!.getAttribute("data-tone")).toBe("muted");
  });

  test("uses the banner segment or the card section without a duplicate banner in card panes", async () => {
    const banner = contextSurface();
    expect(await banner.findByText("Memory: nothing loaded yet")).toBeTruthy();
    expect(banner.getByTestId("context-surface").getAttribute("data-visible")).toBe("true");
    banner.lifecycle.unmount();
    const segment = contextSurface(handlers(), { threadContextKind: "card" });
    const card = renderSlot(contextCard(), cardProps, {
      rpc: handlers(),
      threadContextKind: "card",
      experimental_panel: { openTab: () => true },
    });
    const row = await card.findByRole("button", { name: /^Nothing loaded yet/ });
    expect(row.getAttribute("data-icon")).toBe("Brain");
    expect(row.textContent).toBe("Nothing loaded yet○");
    expect(segment.getByTestId("context-surface").getAttribute("data-visible")).toBe("false");
    expect(within(segment.container).queryByRole("button")).toBeNull();
    fireEvent.click(row);
    expect(card.inspection.experimental_panelCalls).toEqual([openCall("cortex-memory")]);
  });

  test("waits for context before showing and unmounts without orphaning a marker", async () => {
    let release!: (context: ThreadContext) => void;
    const slot = contextSurface(handlers(threadState(), {
      threadContext: () => new Promise(resolve => { release = resolve; }),
    }));
    await waitFor(() => expect(calls(slot, "threadContext")).toHaveLength(1));
    expect(slot.getByTestId("context-surface").getAttribute("data-visible")).toBe("false");
    expect(slot.queryByText(/^Memory:/)).toBeNull();
    await act(async () => { release(threadContext()); });
    await slot.findByText("Memory: nothing loaded yet");
    slot.lifecycle.unmount();
    expect(document.querySelector("[title='Memory: nothing loaded yet']")).toBeNull();
  });

  test("hides only the disabled reads and content, including both settings off", async () => {
    for (const threadContextKind of ["banner", "card"] as const) {
      const choices: Array<Record<string, boolean>> = [{ memoryChip: false }, { memoryChip: false, taskChip: false }];
      for (const settings of choices) {
        const slot = contextSurface(handlers(), { settings, threadContextKind });
        await waitFor(() => expect(calls(slot, "threadContext")).toHaveLength(1));
        await act(async () => {});
        expect(slot.queryByText(/^Memory:/)).toBeNull();
        expect(calls(slot, "memory")).toEqual([]);
        if ("taskChip" in settings) {
          expect(calls(slot, "threadState")).toEqual([]);
          expect(slot.getByTestId("context-surface").getAttribute("data-visible")).toBe("false");
        }
        slot.lifecycle.unmount();
        const card = renderSlot(contextCard(), cardProps, { rpc: handlers(), settings, threadContextKind });
        await waitFor(() => expect(calls(card, "threadContext")).toHaveLength(1));
        await act(async () => {});
        expect(card.queryByRole("button", { name: /^Nothing loaded yet/ })).toBeNull();
        expect(calls(card, "memory")).toEqual([]);
        if ("taskChip" in settings) {
          expect(calls(card, "threadState")).toEqual([]);
          expect(card.container.textContent).toBe("");
        } else {
          const task = await card.findByRole("button", { name: /^#1 First task/ });
          expect(task.textContent).toBe("#1 First taskOpen");
          expect(task.getAttribute("data-icon")).toBe("Circle");
        }
        card.lifecycle.unmount();
      }
    }
  });

  test("refetches only matching memory, all-thread memory, all, and reconnect signals", async () => {
    const slot = memoryIcon();
    await slot.findByText("Memory: nothing loaded yet");
    const count = () => calls(slot, "memory").length;
    const before = count();
    await slot.behavior.emitRealtime("memory", { threadId: "thr_zzzzzzzz" });
    await slot.behavior.emitRealtime("thread", { threadId: THREAD });
    await slot.behavior.emitRealtime("task", { taskId: 1 });
    await slot.behavior.emitRealtime("workstreams", { threadId: "thr_zzzzzzzz" });
    expect(count()).toBe(before);
    await slot.behavior.emitRealtime("memory", { threadId: THREAD });
    await waitFor(() => expect(count()).toBe(before + 1));
    await slot.behavior.emitRealtime("memory", null);
    await waitFor(() => expect(count()).toBe(before + 2));
    await slot.behavior.emitRealtime("all", null);
    await waitFor(() => expect(count()).toBe(before + 3));
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    expect(count()).toBe(before + 3);
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(count()).toBe(before + 4));
  });
});

describe("memory summary", () => {
  const summary = (props: Parameters<typeof MemorySummary>[0]) => render(<MemorySummary {...props} />);
  const task = { id: 550, title: "Cortex in bb", status: "review" as const };

  test("shows the mode and lane, the headline, where the streams came from, the work, the totals and the task", () => {
    const view = memoryView({
      lane: "cortex",
      focus: [7, 3],
      inContext: [
        { id: 1, via: "summary" },
        { id: 2, via: "summary" },
        { id: 3, via: "prompt", query: "fix the marker" },
        { id: 4, via: "recall" },
      ],
      stats: { ...memoryView().stats, prompts: 2, lookups: 3, lastMs: 120, chars: 2_948 },
    });
    const card = summary({ memory: memoryState({ view }), error: null, task });
    expect(card.getByText("Look up and save \u00b7 cortex")).toBeTruthy();
    expect(card.getByText("4 streams in context \u00b7 ~737 tokens")).toBeTruthy();
    expect(card.getByRole("img").getAttribute("aria-label")).toBe(
      "2 session summary, 1 matched a message, 1 recalled by the agent",
    );
    expect(card.getByText("Working on #7, #3")).toBeTruthy();
    expect(card.getByText("2 prompts \u00b7 3 lookups, last 120 ms")).toBeTruthy();
    expect(card.getByText("Task #550 \u00b7 In review: Cortex in bb")).toBeTruthy();
    expect(card.queryByRole("button")).toBeNull();
  });

  test("a reader lists no work, and off, a missing view or a failed read show only the headline", () => {
    const reader = summary({
      memory: memoryState({ mode: "read", view: memoryView({ role: "reader", focus: [7] }) }),
      error: null,
      task: null,
    });
    expect(reader.queryByText(/Working on/)).toBeNull();
    expect(reader.queryByRole("img")).toBeNull();
    reader.unmount();
    for (const [memory, error, headline] of [
      [memoryState({ mode: "off", view: memoryView({ role: "off" }) }), null, "Off for this thread"],
      [memoryState({ view: null }), null, /has not started a session since the Cortex plugin loaded/],
      [null, "cortex is down", "Memory could not load: cortex is down"],
    ] as const) {
      const card = summary({ memory, error, task: null });
      expect(card.getByText(headline)).toBeTruthy();
      expect(card.queryByText(/prompt/)).toBeNull();
      card.unmount();
    }
  });
});

describe("public context placement and lifecycle", () => {
  test("the host's banner and card slots keep context in their own container and clean up on unmount", async () => {
    const slot = contextSurface();
    const marker = await slot.findByText("Memory: nothing loaded yet");
    expect(slot.container.contains(marker)).toBe(true);
    expect(slot.container.querySelectorAll("[data-tone]")).toHaveLength(1);
    slot.lifecycle.unmount();
    expect(document.querySelector("[title='Memory: nothing loaded yet']")).toBeNull();
    const card = renderSlot(contextCard(), cardProps, { rpc: handlers(), threadContextKind: "card" });
    const row = await card.findByRole("button", { name: /^Nothing loaded yet/ });
    expect(card.container.contains(row)).toBe(true);
    card.lifecycle.unmount();
    expect(document.body.textContent).not.toContain("Nothing loaded yet");
  });

  test("a remounted context row restores one marker and leaves neighboring controls untouched", async () => {
    const neighbor = document.createElement("button");
    neighbor.textContent = "Context window 49% used";
    document.body.appendChild(neighbor);
    try {
      const slot = contextSurface();
      await slot.findByText("Memory: nothing loaded yet");
      expect(document.querySelectorAll("[title='Memory: nothing loaded yet']")).toHaveLength(1);
      fireEvent.click(slot.getByRole("button", { name: "Cortex memory. Not connected to a workstream. Memory: nothing loaded yet. Task #1: First task, Open. Show details" }));
      await slot.findByRole("button", { name: "Open Memory tab" });
      expect(document.querySelectorAll("[title='Memory: nothing loaded yet']")).toHaveLength(1);
      expect(neighbor.parentElement).toBe(document.body);
      slot.lifecycle.unmount();
      const next = contextSurface();
      await next.findByText("Memory: nothing loaded yet");
      expect(document.querySelectorAll("[title='Memory: nothing loaded yet']")).toHaveLength(1);
      expect(neighbor.parentElement).toBe(document.body);
      expect(neighbor.textContent).toBe("Context window 49% used");
    } finally {
      neighbor.remove();
    }
  });

  test("collapse and re-expansion keep one summary, without dismissing or moving it", async () => {
    const slot = contextSurface();
    const summary = await slot.findByRole("button", { name: "Cortex memory. Not connected to a workstream. Memory: nothing loaded yet. Task #1: First task, Open. Show details" });
    const parent = summary.parentElement;
    for (let i = 0; i < 2; i++) {
      fireEvent.click(summary);
      expect(await slot.findByRole("button", { name: "Open Memory tab" })).toBeTruthy();
      fireEvent.click(summary);
      expect(slot.queryByRole("button", { name: "Open Memory tab" })).toBeNull();
      expect(summary.parentElement).toBe(parent);
      expect(slot.container.querySelectorAll("[data-tone]")).toHaveLength(1);
    }
    expect(calls(slot, "setContextDismissed")).toEqual([]);
  });
});

describe("Memory tab", () => {
  const tab = (rpc: Handlers = handlers()) =>
    renderSlot(memoryTab(), tabProps, { rpc, experimental_panel: { openTab: () => true } });
  const busy = memoryState({
    view: memoryView({
      focus: [7],
      inContext: [
        { id: 9, via: "recall" },
        { id: 8, via: "prompt", query: "fix the wheel" },
        { id: 7, via: "summary" },
      ],
      stats: { prompts: 2, lookups: 1, lastMs: 12, chars: 400, checkpoints: 1, breadcrumbs: 0, silentRuns: 0 },
    }),
  });
  const rows = (ids: number[]) => ({
    tasks: ids.map(id => ({ id, title: `Stream ${id}`, lane: id === 9 ? "infra" : "cortex", status: "open" as const })),
  });

  test("an unbound thread defaults to Task memory; a bound thread defaults to Next context and can switch to tasks and history", async () => {
    const unbound = tab();
    await waitFor(() => expect(calls(unbound, "threadContext")).toHaveLength(1));
    await waitFor(() => expect(unbound.getByRole("tab", { name: "Task memory" }).getAttribute("aria-selected")).toBe("true"));
    unbound.lifecycle.unmount();
    const bound = tab(handlers(threadState(), {
      threadContext: () => boundContext(),
      memory: () => busy,
    }));
    await waitFor(() => expect(bound.getByRole("tab", { name: "Next context" }).getAttribute("aria-selected")).toBe("true"));
    expect(bound.queryByRole("region", { name: "In context" })).toBeNull();
    fireEvent.mouseDown(bound.getByRole("tab", { name: "Task memory" }));
    expect(await within(bound.getByRole("region", { name: "Working on" })).findByRole("button", { name: "Open #7 Stream 7 in the Cortex tab" })).toBeTruthy();
    fireEvent.mouseDown(bound.getByRole("tab", { name: "Context history" }));
    await waitFor(() => expect(calls(bound, "deliveryReceipts")).toEqual([{ threadId: THREAD, limit: 20, offset: 0 }]));
    expect(bound.getByRole("tab", { name: "Context history" }).getAttribute("aria-selected")).toBe("true");
  });

  test("shows the health line, Working on, In context with titles and reasons, the totals and the legend", async () => {
    const slot = tab(handlers(threadState(), { memory: () => busy, taskRows: ({ ids }) => rows(ids) }));
    expect(await slot.findByText("working \u2014 1 lookup, last 12 ms \u00b7 ~100 tokens of memory added")).toBeTruthy();
    expect(slot.getByText("Look up and save \u00b7 lane cortex")).toBeTruthy();
    const working = within(slot.getByRole("region", { name: "Working on" }));
    await waitFor(() => expect(working.getByText("Stream 7")).toBeTruthy());
    const context = slot.getByRole("region", { name: "In context" });
    expect(within(context).getByText("In context (3)")).toBeTruthy();
    const items = within(context).getAllByRole("listitem").map(item => item.textContent);
    expect(items).toEqual([
      "#9Stream 9infra \u00b7 recalled by the agent",
      "#8Stream 8matched \u201cfix the wheel\u201d",
      "#7Stream 7session summary",
    ]);
    expect(within(slot.getByRole("region", { name: "This session" })).getByText("2 prompts \u00b7 1 checkpoint")).toBeTruthy();
    // Testing Library collapses the legend's two-space gaps.
    expect(slot.getByText("\u25cf loaded \u25cb nothing loaded \u25dc saving \u25d0 stale \u2298 error")).toBeTruthy();
    expect(calls(slot, "taskRows")).toEqual([{ ids: [7, 9, 8] }]);
  });

  test("rows show ids only until titles arrive, and a row opens its task in the Cortex tab", async () => {
    const slot = tab(handlers(threadState(), { memory: () => busy, taskRows: () => new Promise(() => {}) }));
    const row = await slot.findByRole("button", { name: "Open #9 in the Cortex tab" });
    expect(row.textContent).toBe("#9recalled by the agent");
    fireEvent.click(row);
    expect(slot.inspection.experimental_panelCalls).toEqual([openCall()]);
  });

  test("failed task title reads retain ids and reasons rather than inventing rows", async () => {
    const slot = tab(handlers(threadState(), {
      memory: () => busy,
      taskRows: () => { throw new Error("task titles unavailable"); },
    }));
    const row = await slot.findByRole("button", { name: "Open #9 in the Cortex tab" });
    await waitFor(() => expect(calls(slot, "taskRows")).toEqual([{ ids: [7, 9, 8] }]));
    await act(async () => {});
    expect(row.textContent).toBe("#9recalled by the agent");
    expect(slot.queryByText("Stream 9")).toBeNull();
    expect(within(slot.getByRole("region", { name: "In context" })).getAllByRole("listitem")).toHaveLength(3);
  });

  test("look up only has its own health line and no Working on", async () => {
    const reader = memoryView({ role: "reader", inContext: [{ id: 4, via: "prompt", query: "x" }] });
    const slot = tab(handlers(threadState(), { memory: () => memoryState({ mode: "read", view: reader }) }));
    expect(await slot.findByText("Look up only: no memory summary; the agent can still recall")).toBeTruthy();
    expect(slot.getByText("Look up only \u00b7 lane cortex")).toBeTruthy();
    expect(slot.queryByRole("region", { name: "Working on" })).toBeNull();
  });

  test("choosing Look up only saves the thread's choice and notes when it applies", async () => {
    const slot = tab(
      handlers(threadState(), { setMemoryMode: ({ mode }) => memoryState({ override: mode, mode: mode ?? "write" }) }),
    );
    await openMenu(await slot.findByRole("button", { name: /Memory for this thread: Follow the setting \(Look up and save\)/ }));
    const menu = await slot.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map(item => item.textContent)).toEqual([
      "Follow the setting (Look up and save)",
      "Look up and save",
      "Look up only",
      "Off",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Look up only" }));
    await waitFor(() => expect(calls(slot, "setMemoryMode")).toEqual([{ threadId: THREAD, mode: "read" }]));
    expect(await slot.findByRole("button", { name: /Memory for this thread: Look up only/ })).toBeTruthy();
    expect(slot.getByText("A change applies when bb next starts this thread's agent.")).toBeTruthy();
    expect(toast).toHaveBeenCalledWith("Applies when bb next starts this thread's agent");
  });

  test("a child thread's menu follows look up only; a failed change shows an error", async () => {
    const slot = tab(
      handlers(threadState(), {
        memory: () => memoryState({ child: true, mode: "read", view: memoryView({ role: "reader" }) }),
        setMemoryMode: () => {
          throw new Error("metadata is read-only");
        },
      }),
    );
    await openMenu(await slot.findByRole("button", { name: /Follow the setting \(Look up only\)/ }));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Off" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not change memory: metadata is read-only"));
  });

  test("explains a missing view, and shows a failed read with Retry", async () => {
    const missing = tab(handlers(threadState(), { memory: () => memoryState({ view: null }) }));
    expect(
      await missing.findByText("This thread's agent has not started a session since the Cortex plugin loaded."),
    ).toBeTruthy();
    missing.lifecycle.unmount();
    let fail = true;
    const failing = tab(
      handlers(threadState(), {
        memory: () => {
          if (fail) throw new Error("cortex is down");
          return memoryState();
        },
      }),
    );
    expect((await failing.findByRole("alert")).textContent).toContain("cortex is down");
    fail = false;
    fireEvent.click(failing.getByRole("button", { name: "Retry" }));
    expect(await failing.findByText("ready \u2014 nothing loaded yet")).toBeTruthy();
  });
});

describe("::cortex card", () => {
  const card = (attributes: Record<string, string>, openTab?: () => boolean) =>
    renderSlot(
      app.messageDirectives[0]!,
      {
        attributes,
        source: `::cortex{id="${attributes.id ?? ""}"}`,
        message: { id: "msg_1", threadId: THREAD, turnId: null, projectId: "proj_1" },
        openWorkspaceFile: null,
      },
      { rpc: handlers(), ...(openTab ? { experimental_panel: { openTab } } : {}) },
    );

  test("shows the task with its status dot and opens it in the Cortex tab", async () => {
    const slot = card({ id: "4" }, () => true);
    expect(await slot.findByText("Title 4")).toBeTruthy();
    expect(slot.getByText("Open · cortex")).toBeTruthy();
    expect(slot.container.querySelector("[data-status=open]")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Open" }));
    expect(slot.inspection.experimental_panelCalls).toEqual([openCall()]);
    expect(slot.queryByText(/could not open/)).toBeNull();
  });

  test("reports a declined open", async () => {
    for (const openTab of [undefined, () => false]) {
      const slot = card({ id: "4" }, openTab);
      await slot.findByText("Title 4");
      fireEvent.click(slot.getByRole("button", { name: "Open" }));
      expect(await slot.findByText(/could not open the Cortex tab/)).toBeTruthy();
      expect(slot.inspection.experimental_panelCalls).toEqual([openCall()]);
      slot.lifecycle.unmount();
    }
  });

  test("rejects an invalid id without calling the server", async () => {
    for (const id of ["abc", "0", "-1", "1e3", ""]) {
      const slot = card({ id });
      expect(await slot.findByText(/the id must be a task number/)).toBeTruthy();
      expect(slot.inspection.rpcCalls).toEqual([]);
      slot.lifecycle.unmount();
    }
  });
});

describe("one Cortex tab", () => {
  const card = (taskId: number, openTab: () => boolean = () => true) =>
    renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { id: String(taskId) },
        source: `::cortex{id="${taskId}"}`,
        message: { id: `msg_${taskId}`, threadId: THREAD, turnId: null, projectId: "proj_1" },
        openWorkspaceFile: null,
      },
      { rpc: handlers(), experimental_panel: { openTab } },
    );
  const memory = () =>
    renderSlot(
      memoryTab(),
      tabProps,
      {
        rpc: handlers(threadState(), {
          memory: () => memoryState({ view: memoryView({ inContext: [{ id: 9, via: "recall" }] }) }),
        }),
        experimental_panel: { openTab: () => true },
      },
    );
  const opens = (...slots: Array<{ inspection: { experimental_panelCalls: Array<{ method: string }> } }>) =>
    slots.flatMap(slot => slot.inspection.experimental_panelCalls.filter(call => call.method === "openTab"));

  test("a card, a Memory stream and the chip switch the open tab instead of opening another", async () => {
    const tab = panel();
    expect(await tab.findByRole("heading", { name: "Title 1" })).toBeTruthy();

    const fromCard = card(4);
    fireEvent.click(await fromCard.findByRole("button", { name: "Open" }));
    expect(await tab.findByRole("heading", { name: "Title 4" })).toBeTruthy();

    const fromMemory = memory();
    fireEvent.click(await fromMemory.findByRole("button", { name: "Open #9 in the Cortex tab" }));
    expect(await tab.findByRole("heading", { name: "Title 9" })).toBeTruthy();

    // The header action names the focus task, so it brings the tab back to following it.
    const fromChip = headerAction();
    await waitFor(() => expect(fromChip.item()?.label).toBe("#1 · Open"));
    await act(async () => { await fromChip.item()!.run({ requestRename: vi.fn() }); });
    expect(await tab.findByRole("heading", { name: "Title 1" })).toBeTruthy();

    // bb keys a tab by its params and title, so every open must be the same paramless request.
    const all = opens(fromCard, fromMemory, fromChip);
    expect(all).toHaveLength(3);
    for (const call of all) expect(call).toEqual(openCall());
  });

  test("a tab bb opens for the click shows the chosen task", async () => {
    fireEvent.click(await card(4).findByRole("button", { name: "Open" }));
    const tab = panel();
    expect(await tab.findByRole("heading", { name: "Title 4" })).toBeTruthy();
  });

  test("reopening a task after switching away in the tab shows it again", async () => {
    const tab = panel();
    await tab.findByRole("heading", { name: "Title 1" });
    const fromCard = card(4);
    fireEvent.click(await fromCard.findByRole("button", { name: "Open" }));
    await tab.findByRole("heading", { name: "Title 4" });
    await openMenu(tab.getByRole("button", { name: "Thread tasks (2)" }));
    fireEvent.click(within(await tab.findByRole("menu")).getByText("Second task"));
    expect(await tab.findByRole("heading", { name: "Title 2" })).toBeTruthy();
    fireEvent.click(fromCard.getByRole("button", { name: "Open" }));
    expect(await tab.findByRole("heading", { name: "Title 4" })).toBeTruthy();
  });

  test("a declined open leaves the tab's task alone", async () => {
    const tab = panel();
    await tab.findByRole("heading", { name: "Title 1" });
    fireEvent.click(await card(4, () => false).findByRole("button", { name: "Open" }));
    await act(async () => {});
    expect(tab.getByRole("heading", { name: "Title 1" })).toBeTruthy();
  });
});

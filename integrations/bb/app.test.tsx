// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { loadPluginApp, type PluginRpcTestHandlers, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { MemoryState, MemoryView } from "./memory";
import { FOOTER_SELECTOR, placeInFooter, useFooterMount } from "./panel/footer";
import { MemorySummary } from "./panel/memory";
import { selectTask } from "./panel/selection";
import type { rpcContract } from "./server";
import type { CortexTaskDetail, CortexThreadState } from "./state";

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
    pi: true,
    setting: "auto",
    override: null,
    mode: "write",
    child: false,
    view: memoryView(),
    reportedAt: 1,
    refreshAt: 0,
    ...overrides,
  };
}

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;

function handlers(state: CortexThreadState = threadState(), overrides: Partial<Handlers> = {}): Handlers {
  const details = new Map<number, CortexTaskDetail>();
  const get = (id: number) => details.get(id) ?? detail(id);
  return {
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
    refreshMemory: () => memoryState({ refreshAt: 2 }),
    ...overrides,
  };
}

/** bb's composer footer: a left group, then the right-hand group ending with the context circle. */
const COMPOSER_FOOTER =
  '<div data-follow-up-composer-footer><div>branch</div><div><button aria-label="Context window 49% used">49%</button></div></div>';
/** Makes the body a thread pane, so a slot rendered into it finds bb's composer footer once it is added. */
const asPane = () => document.body.setAttribute("data-split-pane-id", "pane-1");
const addFooter = () => {
  document.body.insertAdjacentHTML("beforeend", COMPOSER_FOOTER);
  return document.querySelector(`${FOOTER_SELECTOR} > :last-child`) as HTMLElement;
};
const leavePane = () => {
  document.body.removeAttribute("data-split-pane-id");
  document.querySelector(FOOTER_SELECTOR)?.remove();
};

const calls = (slot: { inspection: { rpcCalls: Array<{ method: string; input: unknown }> } }, method: string) =>
  slot.inspection.rpcCalls.filter(call => call.method === method).map(call => call.input);

const panel = (rpc: Handlers = handlers(), params: unknown = null) =>
  renderSlot(app.threadPanelActions[0]!, { threadId: THREAD, params: params as never }, { rpc });

/** Radix menus open from the keyboard in jsdom (no pointer events). */
async function openMenu(trigger: HTMLElement) {
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
}

test("registers the Cortex and Memory tabs, the header chip, the memory icon and the message directive", () => {
  expect(app.threadPanelActions.map(action => [action.id, action.layout])).toEqual([
    ["cortex", "flush"],
    ["cortex-memory", "flush"],
  ]);
  expect(app.threadHeaderActions.map(action => action.id)).toEqual(["cortex-chip", "cortex-memory"]);
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
    expect(slot.getByRole("button", { name: "Fresh" })).toBeTruthy();
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
    await slot.findByRole("button", { name: "Fresh" });
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
    fireEvent.click(await slot.findByRole("menuitem", { name: "Exclude from memory" }));
    await waitFor(() => expect(calls(slot, "setMemoryExcluded")).toEqual([{ threadId: THREAD, taskId: 1, excluded: true }]));
    expect(await slot.findByText("excluded from memory")).toBeTruthy();
    expect(toast).toHaveBeenCalledWith("#1 is out of agent memory; reading it by id still works");
    await openMenu(slot.getByRole("button", { name: "More" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Include in memory" }));
    await waitFor(() => expect(calls(slot, "setMemoryExcluded")).toHaveLength(2));
    expect(calls(slot, "setMemoryExcluded")[1]).toEqual({ threadId: THREAD, taskId: 1, excluded: false });
    await waitFor(() => expect(slot.queryByText("excluded from memory")).toBeNull());
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
      app.threadPanelActions[0]!,
      { threadId: THREAD, params: null as never },
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

  test("opens the task named in valid params, offers to link it, and ignores invalid params", async () => {
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

describe("header chip", () => {
  type Options = { settings?: Record<string, boolean>; compact?: boolean };
  const header = (index: number, state: CortexThreadState, options: Options) =>
    renderSlot(
      app.threadHeaderActions[index]!,
      { threadId: THREAD, projectId: "proj_1", isCompactViewport: options.compact ?? false },
      { rpc: handlers(state), ...(options.settings ? { settings: options.settings } : {}) },
    );
  const chip = (state: CortexThreadState = threadState(), options: Options = {}) => header(0, state, options);
  /** The buttons left in the thread header, by accessible name; the memory icon's footer portal is not among them. */
  const headerButtons = (...slots: Array<ReturnType<typeof chip>>) =>
    slots.flatMap(slot => within(slot.container).queryAllByRole("button").map(node => node.getAttribute("aria-label")));
  beforeEach(asPane);
  afterEach(leavePane);

  test("names the focus task with its status dot and opens the Cortex tab", async () => {
    addFooter();
    const slot = chip(threadState());
    const button = await slot.findByRole("button", { name: /#1 · open/ });
    expect(button.textContent).toBe("#1 \u00b7 open");
    expect(button.getAttribute("data-tone")).toBe("ok");
    expect(button.querySelector("[data-status=open]")).toBeTruthy();
    fireEvent.click(button);
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "openThreadPanel", options: { actionId: "cortex" } });
  });

  test("is muted without a task and warns for blocked or stale focus", async () => {
    addFooter();
    const empty = chip(threadState({ links: [], focusTaskId: null }));
    expect((await empty.findByRole("button", { name: /Cortex: cortex\./ })).getAttribute("data-tone")).toBe("muted");
    const blocked = chip(threadState({ focusTaskId: 2, health: { kind: "blocked", message: "#2 is blocked" } }));
    const blockedButton = await blocked.findByRole("button", { name: /#2 · blocked/ });
    expect(blockedButton.getAttribute("data-tone")).toBe("blocked");
    expect(blockedButton.querySelector("[data-status=blocked]")).toBeTruthy();
    const stale = chip(threadState({ health: { kind: "stale", message: "changed: x" } }));
    expect((await stale.findByRole("button", { name: /changed: x/ })).getAttribute("data-tone")).toBe("stale");
  });

  test("steps aside for the memory icon while the footer is missing, and comes back with the footer", async () => {
    const task = chip();
    const memory = header(1, threadState(), {});
    await memory.findByRole("button", { name: /^Cortex memory:/ });
    expect(headerButtons(task, memory)).toEqual([expect.stringMatching(/^Cortex memory:/)]);
    expect(task.container.querySelector("span")).toBeTruthy();
    expect(calls(task, "threadState")).toEqual([]);
    addFooter();
    await waitFor(() => expect(headerButtons(task, memory)).toEqual([expect.stringMatching(/^Cortex: #1 · open/)]));
    document.querySelector(FOOTER_SELECTOR)!.remove();
    await waitFor(() => expect(headerButtons(task, memory)).toEqual([expect.stringMatching(/^Cortex memory:/)]));
  });

  test("stays without the footer when the memoryChip setting hides the memory icon", async () => {
    const settings = { memoryChip: false };
    const task = chip(threadState(), { settings });
    const memory = header(1, threadState(), { settings });
    await task.findByRole("button", { name: /#1 · open/ });
    expect(headerButtons(task, memory)).toEqual([expect.stringMatching(/^Cortex: #1 · open/)]);
  });

  test("is absent on compact viewports, where the Cortex tab stays in the right panel", async () => {
    for (const footer of [false, true]) {
      if (footer) addFooter();
      const slot = chip(threadState(), { compact: true });
      await act(async () => {});
      expect(headerButtons(slot)).toEqual([]);
      expect(slot.inspection.rpcCalls).toEqual([]);
      slot.lifecycle.unmount();
    }
  });

  test("is absent when the taskChip setting is off", async () => {
    addFooter();
    const slot = chip(threadState(), { settings: { taskChip: false } });
    await act(async () => {});
    expect(headerButtons(slot)).toEqual([]);
    expect(slot.inspection.rpcCalls).toEqual([]);
  });
});

describe("memory icon", () => {
  const icon = (rpc: Handlers = handlers(), options: { settings?: Record<string, boolean>; compact?: boolean } = {}) =>
    renderSlot(
      app.threadHeaderActions[1]!,
      { threadId: THREAD, projectId: "proj_1", isCompactViewport: options.compact ?? false },
      { rpc, ...(options.settings ? { settings: options.settings } : {}) },
    );
  afterEach(leavePane);
  const withMemory = (memory: MemoryState) => handlers(threadState(), { memory: () => memory });
  const stale = { id: 421, detail: "changed: a.ts" };
  const button = (slot: ReturnType<typeof icon>) => slot.getByRole("button", { name: /^Cortex memory:/ });

  test("its tone follows pi's footer states in the footer's priority, with no text", async () => {
    const cases: Array<[MemoryState, string, RegExp]> = [
      [memoryState({ view: memoryView({ inContext: [{ id: 1, via: "summary" }] }) }), "info", /1 stream in context/],
      [memoryState(), "info", /nothing loaded yet/],
      [memoryState({ view: memoryView({ stale }) }), "warning", /@421 is stale: changed: a\.ts/],
      [memoryState({ view: memoryView({ saving: true }) }), "info", /automatic save turn/],
      [memoryState({ view: memoryView({ error: "boom", stale, saving: true }) }), "error", /error: boom/],
      [memoryState({ view: memoryView({ stale, saving: true }) }), "warning", /@421 is stale/],
      [memoryState({ view: memoryView({ role: "off" }) }), "muted", /off for this thread/],
      [memoryState({ mode: "off", view: null }), "muted", /off for this thread/],
      [memoryState({ view: null }), "muted", /no report from this thread's pi session yet/],
      [memoryState({ pi: false, view: null }), "muted", /no agent session since the Cortex plugin loaded/],
    ];
    for (const [memory, tone, name] of cases) {
      const slot = icon(withMemory(memory));
      await waitFor(() => expect(button(slot).getAttribute("aria-label")).toMatch(name));
      expect(button(slot).getAttribute("data-tone")).toBe(tone);
      expect(button(slot).textContent).toBe("");
      slot.lifecycle.unmount();
    }
  });

  test("opens the Memory tab; without the composer footer it stays in the header", async () => {
    const slot = icon(withMemory(memoryState({ view: null })));
    const trigger = await slot.findByRole("button", {
      name: "Cortex memory: no report from this thread's pi session yet. Open the Memory tab.",
    });
    expect(trigger.getAttribute("data-placement")).toBe("header");
    expect(slot.container.contains(trigger)).toBe(true);
    fireEvent.click(trigger);
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "openThreadPanel",
      options: { actionId: "cortex-memory" },
    });
  });

  test("a failed read is an error, and loading is muted", async () => {
    const failing = icon(
      handlers(threadState(), {
        memory: () => {
          throw new Error("cortex is down");
        },
      }),
    );
    expect(await failing.findByRole("button", { name: /Cortex memory: error: cortex is down/ })).toBeTruthy();
    expect(button(failing).getAttribute("data-tone")).toBe("error");
    failing.lifecycle.unmount();
    const loading = icon(handlers(threadState(), { memory: () => new Promise(() => {}) }));
    expect((await loading.findByRole("button", { name: /loading/ })).getAttribute("data-tone")).toBe("muted");
  });

  test("with the composer footer it sits beside the context circle, on any viewport", async () => {
    for (const compact of [false, true]) {
      asPane();
      const group = addFooter();
      const slot = icon(handlers(), { compact });
      await waitFor(() => expect(group.querySelector("[data-cortex-memory-icon] button")).toBeTruthy());
      expect(button(slot).getAttribute("data-placement")).toBe("footer");
      expect(within(slot.container).queryByRole("button")).toBeNull();
      slot.lifecycle.unmount();
      group.parentElement!.remove();
    }
  });

  test("on a compact viewport it leaves the header empty and moves into the footer once it appears", async () => {
    asPane();
    const slot = icon(handlers(), { compact: true });
    await act(async () => {});
    expect(slot.queryByRole("button", { name: /^Cortex memory:/ })).toBeNull();
    expect(slot.container.querySelector("span")).toBeTruthy();
    const group = addFooter();
    await waitFor(() => expect(group.querySelector("[data-cortex-memory-icon] button")).toBeTruthy());
    expect(button(slot).getAttribute("data-placement")).toBe("footer");
    group.parentElement!.remove();
    await waitFor(() => expect(slot.queryByRole("button", { name: /^Cortex memory:/ })).toBeNull());
    expect(within(slot.container).queryByRole("button")).toBeNull();
  });

  test("is absent with the memoryChip setting off", async () => {
    const slot = icon(handlers(), { settings: { memoryChip: false } });
    await act(async () => {});
    expect(slot.queryByRole("button")).toBeNull();
    expect(slot.inspection.rpcCalls).toEqual([]);
  });

  test("refetches on its own thread's memory signal, a signal for every thread, and reconnects", async () => {
    const slot = icon();
    await slot.findByRole("button", { name: /Cortex memory/ });
    const count = () => calls(slot, "memory").length;
    const before = count();
    await slot.behavior.emitRealtime("memory", { threadId: "thr_zzzzzzzz" });
    await slot.behavior.emitRealtime("thread", { threadId: THREAD });
    expect(count()).toBe(before);
    await slot.behavior.emitRealtime("memory", { threadId: THREAD });
    await waitFor(() => expect(count()).toBe(before + 1));
    await slot.behavior.emitRealtime("memory", null);
    await waitFor(() => expect(count()).toBe(before + 2));
    await slot.behavior.emitRealtime("all", null);
    await waitFor(() => expect(count()).toBe(before + 3));
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
    expect(card.getByText("Click to open the Memory tab")).toBeTruthy();
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
      [memoryState({ view: null }), null, /No report from this thread's pi session yet/],
      [null, "cortex is down", "Memory could not load: cortex is down"],
    ] as const) {
      const card = summary({ memory, error, task: null });
      expect(card.getByText(headline)).toBeTruthy();
      expect(card.queryByText(/prompt/)).toBeNull();
      card.unmount();
    }
  });
});

describe("footer placement", () => {
  /** A thread pane with bb's composer footer, its context circle, and a header slot to render into. */
  function pane(withFooter = true) {
    const root = document.createElement("div");
    root.setAttribute("data-split-pane-id", "pane-1");
    root.innerHTML = withFooter ? `<header></header>${COMPOSER_FOOTER}` : "<header></header>";
    document.body.appendChild(root);
    const header = root.querySelector("header") as HTMLElement;
    const group = root.querySelector(`${FOOTER_SELECTOR} > :last-child`) as HTMLElement | null;
    return { root, header, group };
  }
  function Probe() {
    const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
    const mount = useFooterMount(anchor);
    const icon = <b data-testid="icon">icon</b>;
    return <span ref={setAnchor}>{mount === null ? icon : createPortal(icon, mount)}</span>;
  }
  /** The group's children by test id (the icon sits inside its mount node), else tag. */
  const order = (group: HTMLElement) =>
    Array.from(group.children, child => {
      const id = child.getAttribute("data-testid") ?? child.firstElementChild?.getAttribute("data-testid");
      return id ?? child.tagName.toLowerCase();
    });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("the icon moves next to the context circle and stays in the header without a footer", async () => {
    const withFooter = pane();
    render(<Probe />, { container: withFooter.header });
    await waitFor(() => expect(order(withFooter.group!)).toEqual(["icon", "button"]));
    expect(withFooter.header.querySelector("[data-testid=icon]")).toBeNull();
    cleanup();
    expect(withFooter.group!.querySelector("[data-cortex-memory-icon]")).toBeNull();
    const without = pane(false);
    render(<Probe />, { container: without.header });
    expect(without.header.querySelector("[data-testid=icon]")).toBeTruthy();
  });

  test("a re-rendered footer gets the icon back; a neighbour beside the circle never starts a loop", async () => {
    const { root, header, group } = pane();
    render(<Probe />, { container: header });
    await waitFor(() => expect(order(group!)).toEqual(["icon", "button"]));
    // Thread Spend keeps its pill right before the circle; the icon stays put, so both settle.
    const spend = document.createElement("span");
    spend.setAttribute("data-testid", "spend");
    group!.insertBefore(spend, group!.lastElementChild);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(order(group!)).toEqual(["icon", "spend", "button"]);
    // bb replaces the footer: the icon follows into the new one.
    root.querySelector(FOOTER_SELECTOR)!.remove();
    root.insertAdjacentHTML(
      "beforeend",
      '<div data-follow-up-composer-footer><div></div><div><button aria-label="Context window 50% used">50%</button></div></div>',
    );
    const next = root.querySelector(`${FOOTER_SELECTOR} > :last-child`) as HTMLElement;
    await waitFor(() => expect(order(next)).toEqual(["icon", "button"]));
  });

  test("placeInFooter only moves a node that is not already in the footer", () => {
    const { root, group } = pane();
    const node = document.createElement("span");
    expect(placeInFooter(node, root)).toBe(true);
    expect(group!.firstElementChild).toBe(node);
    group!.appendChild(node);
    expect(placeInFooter(node, root)).toBe(true);
    expect(group!.lastElementChild).toBe(node);
    root.querySelector(FOOTER_SELECTOR)!.remove();
    expect(placeInFooter(node, root)).toBe(false);
    expect(node.isConnected).toBe(false);
  });
});

describe("Memory tab", () => {
  const tab = (rpc: Handlers = handlers()) =>
    renderSlot(app.threadPanelActions[1]!, { threadId: THREAD, params: null as never }, { rpc });
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
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "openThreadPanel", options: { actionId: "cortex" } });
  });

  test("look up only has its own health line, for pi and for other providers, and no Working on", async () => {
    const reader = memoryView({ role: "reader", inContext: [{ id: 4, via: "prompt", query: "x" }] });
    const pi = tab(handlers(threadState(), { memory: () => memoryState({ mode: "read", view: reader }) }));
    expect(
      await pi.findByText(
        "Look up only: matching tasks arrive with messages and the agent can recall; nothing is saved automatically",
      ),
    ).toBeTruthy();
    expect(pi.getByText("Look up only \u00b7 lane cortex")).toBeTruthy();
    expect(pi.queryByRole("region", { name: "Working on" })).toBeNull();
    pi.lifecycle.unmount();
    const other = tab(handlers(threadState(), { memory: () => memoryState({ pi: false, mode: "read", view: reader }) }));
    expect(await other.findByText("Look up only: no memory summary; the agent can still recall")).toBeTruthy();
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
    expect(await slot.findByText("Look up only applies from this thread's next message.")).toBeTruthy();
    expect(slot.getByRole("button", { name: /Memory for this thread: Look up only/ })).toBeTruthy();
    expect(toast).toHaveBeenCalledWith("Applies from this thread's next message");
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

  test("Re-read is offered only for pi threads that use memory, and stays requested until the next report", async () => {
    const slot = tab();
    fireEvent.click(await slot.findByRole("button", { name: "Re-read memory" }));
    await waitFor(() => expect(calls(slot, "refreshMemory")).toEqual([{ threadId: THREAD }]));
    expect(((await slot.findByRole("button", { name: "Re-read requested" })) as HTMLButtonElement).disabled).toBe(true);
    slot.lifecycle.unmount();

    const other = tab(handlers(threadState(), { memory: () => memoryState({ pi: false }) }));
    expect(await other.findByText("A change applies when bb next starts this thread's agent.")).toBeTruthy();
    expect(other.queryByRole("button", { name: "Re-read memory" })).toBeNull();
    other.lifecycle.unmount();
    const off = tab(handlers(threadState(), { memory: () => memoryState({ mode: "off", override: "off" }) }));
    await off.findByRole("button", { name: /Memory for this thread: Off/ });
    expect(off.queryByRole("button", { name: "Re-read memory" })).toBeNull();
  });

  test("explains a missing view for pi and for other providers, and shows a failed read with Retry", async () => {
    const pi = tab(handlers(threadState(), { memory: () => memoryState({ view: null }) }));
    expect(await pi.findByText(/No memory report from this thread's pi session yet/)).toBeTruthy();
    expect(pi.getByText(/run `cortex agents install`/)).toBeTruthy();
    pi.lifecycle.unmount();
    const other = tab(handlers(threadState(), { memory: () => memoryState({ pi: false, view: null }) }));
    expect(
      await other.findByText("This thread's agent has not started a session since the Cortex plugin loaded."),
    ).toBeTruthy();
    other.lifecycle.unmount();
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
  const card = (attributes: Record<string, string>, openThreadPanel?: () => boolean) =>
    renderSlot(
      app.messageDirectives[0]!,
      {
        attributes,
        source: `::cortex{id="${attributes.id ?? ""}"}`,
        message: { id: "msg_1", threadId: THREAD, turnId: null, projectId: "proj_1" },
        openWorkspaceFile: null,
      },
      { rpc: handlers(), ...(openThreadPanel ? { openThreadPanel } : {}) },
    );

  test("shows the task with its status dot and opens it in the Cortex tab", async () => {
    const slot = card({ id: "4" }, () => true);
    expect(await slot.findByText("Title 4")).toBeTruthy();
    expect(slot.getByText("Open · cortex")).toBeTruthy();
    expect(slot.container.querySelector("[data-status=open]")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Open" }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "openThreadPanel", options: { actionId: "cortex" } });
    expect(slot.queryByText(/could not open/)).toBeNull();
  });

  test("reports a declined open", async () => {
    const slot = card({ id: "4" }, () => false);
    await slot.findByText("Title 4");
    fireEvent.click(slot.getByRole("button", { name: "Open" }));
    expect(await slot.findByText(/could not open the Cortex tab/)).toBeTruthy();
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
  const card = (taskId: number, openThreadPanel: () => boolean = () => true) =>
    renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { id: String(taskId) },
        source: `::cortex{id="${taskId}"}`,
        message: { id: `msg_${taskId}`, threadId: THREAD, turnId: null, projectId: "proj_1" },
        openWorkspaceFile: null,
      },
      { rpc: handlers(), openThreadPanel },
    );
  const memoryTab = () =>
    renderSlot(
      app.threadPanelActions[1]!,
      { threadId: THREAD, params: null as never },
      {
        rpc: handlers(threadState(), {
          memory: () => memoryState({ view: memoryView({ inContext: [{ id: 9, via: "recall" }] }) }),
        }),
        openThreadPanel: () => true,
      },
    );
  /** In a pane with the composer footer, the chip's usual place. */
  const chip = () => {
    asPane();
    addFooter();
    return renderSlot(
      app.threadHeaderActions[0]!,
      { threadId: THREAD, projectId: "proj_1", isCompactViewport: false },
      { rpc: handlers(), openThreadPanel: () => true },
    );
  };
  afterEach(leavePane);
  const opens = (...slots: Array<{ inspection: { navigateCalls: Array<{ method: string }> } }>) =>
    slots.flatMap(slot => slot.inspection.navigateCalls.filter(call => call.method === "openThreadPanel"));

  test("a card, a Memory stream and the chip switch the open tab instead of opening another", async () => {
    const tab = panel();
    expect(await tab.findByRole("heading", { name: "Title 1" })).toBeTruthy();

    const fromCard = card(4);
    fireEvent.click(await fromCard.findByRole("button", { name: "Open" }));
    expect(await tab.findByRole("heading", { name: "Title 4" })).toBeTruthy();

    const fromMemory = memoryTab();
    fireEvent.click(await fromMemory.findByRole("button", { name: "Open #9 in the Cortex tab" }));
    expect(await tab.findByRole("heading", { name: "Title 9" })).toBeTruthy();

    // The chip names the focus task, so it brings the tab back to following it.
    const fromChip = chip();
    fireEvent.click(await fromChip.findByRole("button", { name: /#1 · open/ }));
    expect(await tab.findByRole("heading", { name: "Title 1" })).toBeTruthy();

    // bb keys a tab by its params and title, so every open must be the same paramless request.
    const all = opens(fromCard, fromMemory, fromChip);
    expect(all).toHaveLength(3);
    for (const call of all) expect(call).toEqual({ method: "openThreadPanel", options: { actionId: "cortex" } });
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

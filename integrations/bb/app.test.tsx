// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, type PluginRpcTestHandlers, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
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
    ...overrides,
  };
}

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

test("registers a flush tab, the header chip and the message directive", () => {
  expect(app.threadPanelActions.map(action => [action.id, action.layout])).toEqual([["cortex", "flush"]]);
  expect(app.threadHeaderActions.map(action => action.id)).toEqual(["cortex-chip"]);
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

  test("the status menu lists every status with the TUI's keys and checks the current one; a key picks", async () => {
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

  test("more: pin, copy the TUI command, and unlink only a linked task", async () => {
    const slot = panel();
    await openMenu(await slot.findByRole("button", { name: "More" }));
    const unlink = await slot.findByRole("menuitem", { name: /Unlink/ });
    expect(unlink.getAttribute("aria-disabled")).toBe("true");
    expect(unlink.textContent).toContain("posted here");
    fireEvent.click(slot.getByRole("menuitem", { name: /Copy/ }));
    await waitFor(() => expect(slot.inspection.experimental_clipboardWrites).toEqual([{ text: "cortex tui 1" }]));
    await openMenu(slot.getByRole("button", { name: "More" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: /Pin as focus/ }));
    await waitFor(() => expect(calls(slot, "pin")).toEqual([{ threadId: THREAD, taskId: 1 }]));
    expect(await slot.findByRole("button", { name: /Pinned as this thread's focus/ })).toBeTruthy();
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
  const chip = (state: CortexThreadState, isCompactViewport = false) =>
    renderSlot(
      app.threadHeaderActions[0]!,
      { threadId: THREAD, projectId: "proj_1", isCompactViewport },
      { rpc: handlers(state) },
    );

  test("names the focus task with its status dot and opens the Cortex tab", async () => {
    const slot = chip(threadState());
    const button = await slot.findByRole("button", { name: /#1 · open/ });
    expect(button.getAttribute("data-tone")).toBe("ok");
    expect(button.querySelector("[data-status=open]")).toBeTruthy();
    fireEvent.click(button);
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "openThreadPanel", options: { actionId: "cortex" } });
  });

  test("is muted without a task and warns for blocked or stale focus", async () => {
    const empty = chip(threadState({ links: [], focusTaskId: null }));
    expect((await empty.findByRole("button", { name: /Cortex: cortex\./ })).getAttribute("data-tone")).toBe("muted");
    const blocked = chip(threadState({ focusTaskId: 2, health: { kind: "blocked", message: "#2 is blocked" } }));
    const blockedButton = await blocked.findByRole("button", { name: /#2 · blocked/ });
    expect(blockedButton.getAttribute("data-tone")).toBe("blocked");
    expect(blockedButton.querySelector("[data-status=blocked]")).toBeTruthy();
    const stale = chip(threadState({ health: { kind: "stale", message: "changed: x" } }));
    expect((await stale.findByRole("button", { name: /changed: x/ })).getAttribute("data-tone")).toBe("stale");
  });

  test("collapses to an icon on compact viewports", async () => {
    const slot = chip(threadState(), true);
    const button = await slot.findByRole("button", { name: /#1 · open/ });
    expect(button.textContent).toBe("");
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
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "openThreadPanel",
      options: { actionId: "cortex", title: "Cortex #4", params: { taskId: 4 } },
    });
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

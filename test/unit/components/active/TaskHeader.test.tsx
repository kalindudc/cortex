// TaskHeader — title-led document header (task 330, H1/H2): task id once,
// large wrapping title with an explicit Edit-title affordance, one quiet
// property row (lane / priority / actual tag names / Add tags), status
// dropdown + next-status as distinct trailing actions, Delete inside a
// labeled task-actions menu, and draft save/conflict feedback.

import { describe, test, expect, mock, beforeEach } from "bun:test";

const setStatMock = mock(() => Promise.resolve({}));
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    addTask: mock(() => Promise.resolve({})),
    editTask: mock(() => Promise.resolve({})),
    setStat: setStatMock,
    moveLane: mock(() => Promise.resolve({})),
    delTask: mock(() => Promise.resolve(undefined)),
    postUpd: mock(() => Promise.resolve({})),
    addLane: mock(() => Promise.resolve({})),
    editLane: mock(() => Promise.resolve({})),
    delLane: mock(() => Promise.resolve(undefined)),
    setTags: mock(() => Promise.resolve({})),
    addTag: mock(() => Promise.resolve({})),
    editTag: mock(() => Promise.resolve({})),
    delTag: mock(() => Promise.resolve(undefined)),
  },
}));

import { cleanup, render, fireEvent } from "@testing-library/preact";
import {
  TaskHeader,
  TITLE_CLAMP_LINES,
  TITLE_REVEAL_INTENT_MS,
} from "../../../../src/ui/components/active/TaskHeader.tsx";
import { TaskToolbar } from "../../../../src/ui/components/active/TaskToolbar.tsx";
import type { TaskDraft, DraftField } from "../../../../src/ui/lib/useTaskDraft.ts";
import { closeAllPopovers } from "../../../../src/ui/state/popovers.ts";
import { filters, modal, pendingTitleFocus, workspaceQuery, lanes, tags } from "../../../../src/ui/state/signals.ts";
import type { Task } from "../../../../src/ui/api/types.ts";

function task(over: Partial<Task> = {}): Task {
  return {
    id: 7,
    lane: "cortex",
    title: "Ship the document workspace",
    body: "body",
    status: "open",
    priority: 1,
    created: 0,
    updated: 0,
    tags: [],
    ...over,
  };
}

interface FakeDraftOpts {
  title?: string;
  saveState?: TaskDraft["saveState"];
  externalTitle?: string | null;
  ready?: boolean;
  loadError?: string | null;
}
function fakeDraft(opts: FakeDraftOpts = {}): TaskDraft & {
  calls: {
    set: Array<[DraftField, string]>;
    flush: number;
    retry: number;
    apply: DraftField[];
    keep: DraftField[];
    reload: number;
  };
  /** Settle the atomic baseline (the test re-renders afterwards). */
  becomeReady(): void;
} {
  const calls = {
    set: [] as Array<[DraftField, string]>,
    flush: 0,
    retry: 0,
    apply: [] as DraftField[],
    keep: [] as DraftField[],
    reload: 0,
  };
  let title = opts.title ?? "Ship the document workspace";
  let ready = opts.ready ?? true;
  let loadError = opts.loadError ?? null;
  return {
    calls,
    becomeReady() {
      ready = true;
      loadError = null;
    },
    get title() {
      return title;
    },
    body: "body",
    bodyEpoch: 0,
    saveState: opts.saveState ?? "saved",
    external: { title: opts.externalTitle ?? null, body: null },
    get ready() {
      return ready;
    },
    get loadError() {
      return loadError;
    },
    reload() {
      calls.reload++;
    },
    set(field: DraftField, value: string) {
      calls.set.push([field, value]);
      if (field === "title") title = value;
    },
    flush() {
      calls.flush++;
    },
    retry() {
      calls.retry++;
    },
    apply(field: DraftField) {
      calls.apply.push(field);
    },
    keep(field: DraftField) {
      calls.keep.push(field);
    },
  };
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 5));
const pastIntent = (): Promise<void> => new Promise(r => setTimeout(r, TITLE_REVEAL_INTENT_MS + 40));

// happy-dom has no layout: scrollHeight is 0 and line-height is "normal", so
// the clamp measurement in TaskHeader always reads "fits". These stubs give
// the title text a fixed line-height and a chosen full text height; the
// real geometry is certified in test/e2e/document-workspace.spec.ts.
const TITLE_LINE_HEIGHT = 37.5;
function stubTitleMetrics(scrollHeight: number): () => void {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scrollHeight });
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (() =>
    ({ lineHeight: `${TITLE_LINE_HEIGHT}px` }) as CSSStyleDeclaration) as typeof getComputedStyle;
  return () => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    globalThis.getComputedStyle = originalGetComputedStyle;
  };
}

describe("TaskHeader", () => {
  beforeEach(() => {
    filters.value = { status: null, lane: null, tag: [] };
    workspaceQuery.value = "";
    modal.value = null;
    pendingTitleFocus.value = null;
    lanes.value = [{ name: "cortex", color: null, sort: 0 }];
    tags.value = [];
    setStatMock.mockClear();
  });

  test("the title itself is a keyboard-accessible edit trigger; no separate Edit title button", () => {
    const { container } = render(<TaskHeader task={task()} draft={fakeDraft()} />);
    const ids = Array.from(container.querySelectorAll(".task-id"));
    expect(ids.length).toBe(1);
    expect(ids[0].textContent).toContain("7");
    expect(container.querySelector(".task-title-display")?.textContent).toBe("Ship the document workspace");
    expect(container.querySelector(".task-title-display > button.task-title-trigger")?.textContent).toBe(
      "Ship the document workspace",
    );
    expect(container.querySelector(".task-title-edit")).toBeNull();
  });

  test("property row: lane, priority and tag slots — no 'tags: N' proxy anywhere", () => {
    const { container } = render(<TaskHeader task={task({ tags: ["bug", "ui"] })} draft={fakeDraft()} />);
    const props = container.querySelector(".task-props");
    if (!props) throw new Error("expected property row");
    expect(props.textContent).toContain("cortex");
    expect(props.textContent).toContain("P1");
    expect(props.textContent).toContain("bug");
    expect(props.textContent).toContain("ui");
    expect(container.textContent).not.toContain("tags:");
  });

  test("clicking the title reveals its textarea; Enter flushes and returns focus to the title", async () => {
    const draft = fakeDraft();
    const { container } = render(<TaskHeader task={task()} draft={draft} />);
    fireEvent.click(container.querySelector("button.task-title-trigger") as HTMLButtonElement);
    await tick();
    const input = container.querySelector<HTMLTextAreaElement>("textarea.title-input");
    if (!input) throw new Error("expected title textarea");
    input.value = "New name";
    fireEvent.input(input);
    expect(draft.calls.set).toEqual([["title", "New name"]]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(draft.calls.flush).toBe(1);
    await tick();
    // Back to display mode.
    expect(container.querySelector("textarea.title-input")).toBeNull();
    expect(container.querySelector(".task-title-display")).not.toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".task-title-trigger"));
  });

  test("title IME Enter does not commit an unfinished composition", async () => {
    const draft = fakeDraft();
    const { container } = render(<TaskHeader task={task()} draft={draft} />);
    fireEvent.click(container.querySelector(".task-title-trigger") as HTMLElement);
    await tick();
    const input = container.querySelector(".title-input") as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(draft.calls.flush).toBe(0);
    expect(container.querySelector(".title-input")).toBe(input);
  });

  test("title blur flushes without taking focus back from the clicked control", async () => {
    const draft = fakeDraft();
    const { container } = render(
      <>
        <TaskHeader task={task()} draft={draft} />
        <button type="button" class="outside">
          Other control
        </button>
      </>,
    );
    fireEvent.click(container.querySelector(".task-title-trigger") as HTMLElement);
    await tick();
    const input = container.querySelector(".title-input") as HTMLTextAreaElement;
    const outside = container.querySelector(".outside") as HTMLButtonElement;
    outside.focus();
    fireEvent.blur(input);
    await tick();
    expect(draft.calls.flush).toBeGreaterThan(0);
    expect(container.querySelector(".title-input")).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  test("consumes pendingTitleFocus: enters editing and clears the signal (D4)", async () => {
    pendingTitleFocus.value = 7;
    const { container } = render(<TaskHeader task={task()} draft={fakeDraft()} />);
    await tick();
    expect(container.querySelector("textarea.title-input")).not.toBeNull();
    expect(pendingTitleFocus.value).toBeNull();
  });

  test("pendingTitleFocus for a DIFFERENT task is left alone", async () => {
    pendingTitleFocus.value = 99;
    const { container } = render(<TaskHeader task={task()} draft={fakeDraft()} />);
    await tick();
    expect(container.querySelector("textarea.title-input")).toBeNull();
    expect(pendingTitleFocus.value).toBe(99);
  });

  test("next-status action PATCHes the status transition", async () => {
    const { container } = render(<TaskToolbar task={task({ status: "open" })} />);
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(b =>
      (b.textContent ?? "").includes("review"),
    );
    if (!btn) throw new Error("expected next-status action");
    fireEvent.click(btn);
    await tick();
    expect(setStatMock).toHaveBeenCalledWith(7, "review");
  });

  test("Delete task lives in a labeled task-actions menu and dispatches the confirm modal", async () => {
    const { container } = render(<TaskToolbar task={task()} />);
    const menuBtn = container.querySelector<HTMLButtonElement>("button[aria-label='Task actions']");
    if (!menuBtn) throw new Error("expected task-actions menu trigger");
    // Delete is NOT reachable before opening the menu.
    expect(container.querySelector("button[aria-label='Delete task']")).toBeNull();
    fireEvent.click(menuBtn);
    await tick();
    const del = container.querySelector<HTMLButtonElement>("button[aria-label='Delete task']");
    if (!del) throw new Error("expected Delete inside the menu");
    fireEvent.click(del);
    expect(modal.value).toEqual({ kind: "confirm-delete", id: 7 });
  });

  test("metadata editing never changes workspace filters (H1)", async () => {
    filters.value = { status: "open", lane: "cortex", tag: ["bug"] };
    workspaceQuery.value = "needle";
    const { container } = render(<TaskHeader task={task({ tags: ["bug"] })} draft={fakeDraft()} />);
    // Open each metadata trigger in turn.
    for (const label of ["Task actions", "Add tags"]) {
      const btn = container.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`);
      if (btn) fireEvent.click(btn);
      await tick();
    }
    expect(filters.value).toEqual({ status: "open", lane: "cortex", tag: ["bug"] });
    expect(workspaceQuery.value).toBe("needle");
  });

  test("title conflict renders the banner: Apply adopts, 'Keep my changes' keeps (D3)", () => {
    const draft = fakeDraft({ externalTitle: "external rename" });
    const { container } = render(<TaskHeader task={task()} draft={draft} />);
    const banner = container.querySelector(".external-change-banner");
    if (!banner) throw new Error("expected conflict banner");
    const apply = Array.from(banner.querySelectorAll("button")).find(b => b.textContent?.trim() === "Apply");
    const keep = Array.from(banner.querySelectorAll("button")).find(b => b.textContent?.trim() === "Keep my changes");
    if (!apply || !keep) throw new Error("expected Apply and Keep my changes actions");
    fireEvent.click(apply);
    expect(draft.calls.apply).toEqual(["title"]);
    fireEvent.click(keep);
    expect(draft.calls.keep).toEqual(["title"]);
  });

  test("save feedback: error state is visible with a retry that calls draft.retry", () => {
    const draft = fakeDraft({ saveState: "error" });
    const { container } = render(<TaskHeader task={task()} draft={draft} />);
    const state = container.querySelector(".draft-state");
    expect(state?.textContent ?? "").toContain("failed");
    const retry = container.querySelector<HTMLButtonElement>("button.draft-retry");
    if (!retry) throw new Error("expected retry affordance");
    fireEvent.click(retry);
    expect(draft.calls.retry).toBe(1);
  });

  test("an empty title remains an editable placeholder without changing the draft", () => {
    const draft = fakeDraft({ title: "" });
    const view = render(<TaskHeader task={task()} draft={draft} />);
    expect(view.getByRole("button", { name: "Untitled task", exact: true })).toBeTruthy();
    expect(draft.title).toBe("");
    expect(draft.calls.set).toEqual([]);
  });

  test("long titles keep the full text in the DOM; the clamp is CSS-only and its line count is published", () => {
    const long = "word ".repeat(60).trim();
    const { container } = render(<TaskHeader task={task()} draft={fakeDraft({ title: long })} />);
    const heading = container.querySelector<HTMLElement>(".task-title-display");
    if (!heading) throw new Error("expected title heading");
    // The accessible name of the edit trigger is the COMPLETE title.
    expect(heading.textContent).toBe(long);
    expect(container.querySelector("button.task-title-trigger > .task-title-text")?.textContent).toBe(long);
    expect(heading.style.getPropertyValue("--title-clamp-lines")).toBe(String(TITLE_CLAMP_LINES));
    // Without layout nothing overflows, so no overlay behavior is armed.
    expect(heading.classList.contains("is-clamped")).toBe(false);
  });

  test("a title that overflows the clamp marks the heading .is-clamped and records its full height", async () => {
    const restore = stubTitleMetrics(TITLE_LINE_HEIGHT * 4);
    try {
      const { container } = render(<TaskHeader task={task()} draft={fakeDraft({ title: "four lines of title" })} />);
      await tick();
      const heading = container.querySelector<HTMLElement>(".task-title-display");
      const text = container.querySelector<HTMLElement>(".task-title-text");
      if (!heading || !text) throw new Error("expected clamped title");
      expect(heading.classList.contains("is-clamped")).toBe(true);
      expect(text.style.getPropertyValue("--title-full-height")).toBe(`${TITLE_LINE_HEIGHT * 4}px`);
      // Still the full text: the clamp never rewrites the title.
      expect(text.textContent).toBe("four lines of title");
    } finally {
      restore();
    }
  });

  test("a title that fits within the clamp lines is never marked .is-clamped", async () => {
    const restore = stubTitleMetrics(TITLE_LINE_HEIGHT * TITLE_CLAMP_LINES);
    try {
      const { container } = render(<TaskHeader task={task()} draft={fakeDraft({ title: "exactly two lines" })} />);
      await tick();
      expect(container.querySelector(".task-title-display")?.classList.contains("is-clamped")).toBe(false);
    } finally {
      restore();
    }
  });

  test("reveal arms only after the pointer RESTS on the title; passing through never reveals", async () => {
    const { container } = render(<TaskHeader task={task()} draft={fakeDraft()} />);
    const header = container.querySelector(".task-header") as HTMLElement;
    const heading = container.querySelector(".task-title-display") as HTMLElement;
    fireEvent.mouseEnter(heading);
    await tick();
    expect(header.classList.contains("is-title-revealed")).toBe(false);
    // Leaving the title before the intent window cancels the pending reveal.
    fireEvent.mouseLeave(heading);
    await pastIntent();
    expect(header.classList.contains("is-title-revealed")).toBe(false);
    // Resting on it reveals.
    fireEvent.mouseEnter(heading);
    await pastIntent();
    expect(header.classList.contains("is-title-revealed")).toBe(true);
  });

  test("a reveal follows the pointer across the header and ends only when it leaves the header", async () => {
    const { container } = render(<TaskHeader task={task()} draft={fakeDraft()} />);
    const header = container.querySelector(".task-header") as HTMLElement;
    const heading = container.querySelector(".task-title-display") as HTMLElement;
    fireEvent.mouseEnter(heading);
    await pastIntent();
    expect(header.classList.contains("is-title-revealed")).toBe(true);
    // Down onto the metadata row: still inside the header, still revealed.
    fireEvent.mouseLeave(heading);
    await tick();
    expect(header.classList.contains("is-title-revealed")).toBe(true);
    fireEvent.mouseLeave(header);
    await tick();
    expect(header.classList.contains("is-title-revealed")).toBe(false);
  });

  test("starting to edit or navigating to another task drops the reveal", async () => {
    const draft = fakeDraft();
    const view = render(<TaskHeader task={task()} draft={draft} />);
    const header = view.container.querySelector(".task-header") as HTMLElement;
    const reveal = async (): Promise<void> => {
      fireEvent.mouseEnter(view.container.querySelector(".task-title-display") as HTMLElement);
      await pastIntent();
      expect(header.classList.contains("is-title-revealed")).toBe(true);
    };
    await reveal();
    fireEvent.click(view.container.querySelector("button.task-title-trigger") as HTMLButtonElement);
    await tick();
    expect(header.classList.contains("is-title-revealed")).toBe(false);
    fireEvent.keyDown(view.container.querySelector("textarea.title-input") as HTMLTextAreaElement, { key: "Enter" });
    await tick();
    expect(header.classList.contains("is-title-revealed")).toBe(false);
    await reveal();
    view.rerender(<TaskHeader task={task({ id: 8 })} draft={draft} />);
    await tick();
    expect(header.classList.contains("is-title-revealed")).toBe(false);
  });

  test("title editing waits for the atomic baseline: a click while loading says so, then edits once ready", async () => {
    // Earlier tests leave mounted headers and open metadata popovers whose
    // pickers take focus on mount; these tests are about focus.
    cleanup();
    closeAllPopovers();
    const draft = fakeDraft({ ready: false });
    const view = render(<TaskHeader task={task()} draft={draft} />);
    const trigger = view.container.querySelector("button.task-title-trigger") as HTMLButtonElement;
    trigger.focus();
    fireEvent.click(trigger);
    await tick();
    expect(view.container.querySelector("textarea.title-input")).toBeNull(); // editing disabled
    const state = view.container.querySelector(".draft-state");
    expect(state?.getAttribute("role")).toBe("status");
    expect(state?.textContent ?? "").toContain("Loading");
    draft.becomeReady();
    view.rerender(<TaskHeader task={task()} draft={draft} />);
    await tick();
    expect(view.container.querySelector("textarea.title-input")).not.toBeNull();
    expect(view.container.querySelector(".draft-state")).toBeNull();
  });

  test("a baseline that arrives after focus moved elsewhere never steals it: the queued edit is dropped", async () => {
    // Earlier tests leave mounted headers and open metadata popovers whose
    // pickers take focus on mount; these tests are about focus.
    cleanup();
    closeAllPopovers();
    const draft = fakeDraft({ ready: false });
    const view = render(
      <>
        <TaskHeader task={task()} draft={draft} />
        <button type="button" class="outside">
          Other control
        </button>
      </>,
    );
    const trigger = view.container.querySelector("button.task-title-trigger") as HTMLButtonElement;
    trigger.focus();
    fireEvent.click(trigger);
    const outside = view.container.querySelector(".outside") as HTMLButtonElement;
    outside.focus();
    draft.becomeReady();
    view.rerender(
      <>
        <TaskHeader task={task()} draft={draft} />
        <button type="button" class="outside">
          Other control
        </button>
      </>,
    );
    await tick();
    expect(view.container.querySelector("textarea.title-input")).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  test("pendingTitleFocus waits for the baseline before entering editing", async () => {
    // Earlier tests leave mounted headers and open metadata popovers whose
    // pickers take focus on mount; these tests are about focus.
    cleanup();
    closeAllPopovers();
    pendingTitleFocus.value = 7;
    const draft = fakeDraft({ ready: false });
    const view = render(<TaskHeader task={task()} draft={draft} />);
    await tick();
    expect(view.container.querySelector("textarea.title-input")).toBeNull();
    expect(pendingTitleFocus.value).toBe(7);
    draft.becomeReady();
    view.rerender(<TaskHeader task={task()} draft={draft} />);
    await tick();
    expect(view.container.querySelector("textarea.title-input")).not.toBeNull();
    expect(pendingTitleFocus.value).toBeNull();
  });

  test("a failed baseline is explained once editing is requested; the request and Retry both reload", async () => {
    // Earlier tests leave mounted headers and open metadata popovers whose
    // pickers take focus on mount; these tests are about focus.
    cleanup();
    closeAllPopovers();
    const draft = fakeDraft({ ready: false, loadError: "daemon unreachable" });
    const { container } = render(<TaskHeader task={task()} draft={draft} />);
    expect(container.querySelector(".draft-state")).toBeNull(); // reading needs no baseline: no noise
    fireEvent.click(container.querySelector("button.task-title-trigger") as HTMLButtonElement);
    await tick();
    expect(draft.calls.reload).toBe(1);
    const state = container.querySelector(".draft-state");
    expect(state?.getAttribute("role")).toBe("alert");
    expect(state?.textContent ?? "").toContain("daemon unreachable");
    const retry = container.querySelector<HTMLButtonElement>("button.draft-retry");
    if (!retry) throw new Error("expected Retry");
    fireEvent.click(retry);
    expect(draft.calls.reload).toBe(2);
    expect(container.querySelector("textarea.title-input")).toBeNull();
  });

  test("editing a clamped title shows the whole title in the textarea with no clamp in the DOM", async () => {
    const restore = stubTitleMetrics(TITLE_LINE_HEIGHT * 5);
    try {
      const long = "a very long title ".repeat(12).trim();
      const { container } = render(<TaskHeader task={task()} draft={fakeDraft({ title: long })} />);
      await tick();
      expect(container.querySelector(".task-title-display.is-clamped")).not.toBeNull();
      fireEvent.click(container.querySelector("button.task-title-trigger") as HTMLButtonElement);
      await tick();
      const input = container.querySelector<HTMLTextAreaElement>("textarea.title-input");
      if (!input) throw new Error("expected title textarea");
      expect(input.value).toBe(long);
      // The autosizing mirror receives the complete value, so the field grows to every line.
      expect(container.querySelector(".title-input-wrap")?.getAttribute("data-replicated-value")).toBe(`${long} `);
      expect(container.querySelector(".is-clamped")).toBeNull();
      expect(container.querySelector(".task-title-text")).toBeNull();
    } finally {
      restore();
    }
  });
});

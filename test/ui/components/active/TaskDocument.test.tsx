// TaskDocument — the assembled document workspace:
// one draft owner feeding header/editor/reader, a single content tablist,
// lazy-mounted CodeMirror that HIDES instead of unmounting across
// mode/panel switches, split preview debounce, reading-position memory and
// zero task writes from simply reading.

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
// ESM hooks instance for the stub factory — require("preact/hooks") inside
// the factory would load the CJS build, a SECOND hooks runtime that is not
// wired to the running preact core (options), and crash on first use.
import { useEffect as stubUseEffect } from "preact/hooks";

const editTaskMock = mock(() => Promise.resolve({}));
const postUpdMock = mock(() => Promise.resolve({}));

// The daemon's copy of each task, with per-field version tokens: the draft
// reads its atomic baseline (and every incoming change) from here, and every
// task() this file builds is written to it first, like a live snapshot that
// follows a real write.
const SCOPES = ["entity", "title", "body", "priority", "lane", "status"] as const;
const serverTasks = new Map<number, { task: Task; versions: Versions }>();
let tokenSeq = 0;
function serverWrite(t: Task): void {
  const prev = serverTasks.get(t.id);
  const versions: Versions = { ...prev?.versions };
  for (const scope of SCOPES) {
    const moved = scope === "entity" || JSON.stringify(prev?.task[scope]) !== JSON.stringify(t[scope]);
    if (prev === undefined || moved) versions[scope] = `${scope}-${++tokenSeq}`;
  }
  serverTasks.set(t.id, { task: structuredClone(t), versions });
}
const taskStateMock = mock((id: number): Promise<TaskStateSnapshot> => {
  const s = serverTasks.get(id);
  if (!s) return Promise.reject(new Error(`no task ${id}`));
  return Promise.resolve({ task: structuredClone(s.task), updates: [], versions: { ...s.versions }, cursor: "e1:1" });
});
const versionedEditMock = mock((id: number, patch: EditTaskRequest): Promise<TaskWriteResult> => {
  const s = serverTasks.get(id);
  if (!s) return Promise.reject(new Error(`no task ${id}`));
  const next: Task = { ...s.task };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.body !== undefined) next.body = patch.body;
  serverWrite(next);
  const written = serverTasks.get(id) as { task: Task; versions: Versions };
  return Promise.resolve({ task: structuredClone(written.task), versions: { ...written.versions }, replayed: false });
});
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    taskState: taskStateMock,
    versioned: { editTask: versionedEditMock, setStatus: mock(() => Promise.resolve({})) },
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    related: mock(() => Promise.resolve({ referencedBy: [], references: [], shared: [] })),
    addTask: mock(() => Promise.resolve({})),
    editTask: editTaskMock,
    moveLane: mock(() => Promise.resolve({})),
    delTask: mock(() => Promise.resolve(undefined)),
    postUpd: postUpdMock,
    addLane: mock(() => Promise.resolve({})),
    editLane: mock(() => Promise.resolve({})),
    delLane: mock(() => Promise.resolve(undefined)),
    setTags: mock(() => Promise.resolve({})),
    addTag: mock(() => Promise.resolve({})),
    editTag: mock(() => Promise.resolve({})),
    delTag: mock(() => Promise.resolve(undefined)),
  },
}));

// DOMPurify is broken under happy-dom — passthrough for structural tests
// (Chromium e2e certifies scrubbing).
mock.module("dompurify", () => ({
  default: {
    isSupported: true,
    sanitize: (html: string) => html,
    addHook: () => {},
    removeHook: () => {},
  },
}));

// MdEditor stub mirroring the real contract (CodeMirror can't be asserted
// in happy-dom): stable host node, hidden wiring, onReady handle, and
// probe buttons that drive onChange/onSubmit.
mock.module("../../../../src/ui/components/active/MdEditor.tsx", () => {
  const useEffect = stubUseEffect;
  return {
    MdEditor: ({
      value,
      visible,
      onChange,
      onSubmit,
      onReady,
    }: {
      value: string;
      visible?: boolean;
      onChange: (v: string) => void;
      onSubmit?: () => void;
      onReady?: (h: { focus(): void; requestMeasure(): void } | null) => void;
    }) => {
      useEffect(() => {
        onReady?.({ focus: () => {}, requestMeasure: () => {} });
        return () => onReady?.(null);
      }, []);
      return (
        <div class="md-editor" hidden={visible === false} data-value={value}>
          <button
            type="button"
            class="stub-type"
            onClick={(e: MouseEvent) => onChange(((e.currentTarget as HTMLElement).dataset.text ?? "typed") as string)}
          />
          <button type="button" class="stub-submit" onClick={() => onSubmit?.()} />
        </div>
      );
    },
  };
});

import { render, fireEvent, waitFor } from "@testing-library/preact";
import { TaskDocument } from "../../../../src/ui/components/active/TaskDocument.tsx";
import { pruneTaskDrafts } from "../../../../src/ui/lib/useTaskDraft.ts";
import {
  tasks,
  selectedId,
  filters,
  workspaceQuery,
  tab,
  readerMode,
  preferredReaderMode,
  lanes,
  tags,
  updates,
  pendingTitleFocus,
  pendingHeadingFragment,
  narrowViewport,
} from "../../../../src/ui/state/signals.ts";
import { docOutline } from "../../../../src/ui/state/context.ts";
import type { Task } from "../../../../src/ui/api/types.ts";
import type { EditTaskRequest, TaskStateSnapshot, TaskWriteResult, Versions } from "../../../../src/contracts.ts";

/** A task copy, as the daemon now holds it (see serverWrite above). */
function task(over: Partial<Task> = {}): Task {
  const t: Task = {
    id: 5,
    lane: "now",
    title: "Document me",
    body: "# Alpha\n\nSome prose.\n\n## Beta\n\nMore prose.",
    status: "open",
    priority: null,
    created: 0,
    updated: 0,
    tags: [],
    memory_excluded: false,
    ...over,
  };
  serverWrite(t);
  return t;
}

const tick = (ms = 0): Promise<void> => new Promise(r => setTimeout(r, ms));

function modeButton(root: ParentNode, label: string): HTMLButtonElement {
  const btn = Array.from(root.querySelectorAll<HTMLButtonElement>(".doc-mode-switch button")).find(
    b => b.getAttribute("aria-label") === label,
  );
  if (!btn) throw new Error(`expected ${label} mode button`);
  return btn;
}

describe("TaskDocument", () => {
  afterEach(() => {
    preferredReaderMode.value = "read";
  });
  beforeEach(async () => {
    preferredReaderMode.value = "read";
    // Let any prior unmount-flush PATCH acks land, then drop the module-
    // level draft memory — tests reuse task id 5 and a recovered snapshot
    // would leak the previous test's body into the next draft seed.
    await new Promise(r => setTimeout(r, 0));
    pruneTaskDrafts([]);
    serverTasks.clear();
    tasks.value = [task()];
    selectedId.value = 5;
    filters.value = { status: null, lane: null, tag: [] };
    workspaceQuery.value = "";
    tab.value = "document";
    readerMode.value = "read";
    lanes.value = [{ name: "now", color: null, sort: 0 }];
    tags.value = [];
    updates.value = {};
    pendingTitleFocus.value = null;
    pendingHeadingFragment.value = null;
    narrowViewport.value = false;
    editTaskMock.mockClear();
    versionedEditMock.mockClear();
    taskStateMock.mockClear();
    postUpdMock.mockClear();
  });

  test("default is Document/Read: rendered prose, NO editor mounted, zero writes", async () => {
    const { container } = render(<TaskDocument task={task()} />);
    await tick();
    expect(container.querySelector(".doc-reader .markdown-view h1")?.textContent).toBe("Alpha");
    expect(container.querySelector(".md-editor")).toBeNull(); // lazy: no CodeMirror cost for reading
    expect(editTaskMock).toHaveBeenCalledTimes(0);
    expect(versionedEditMock).toHaveBeenCalledTimes(0);
    expect(postUpdMock).toHaveBeenCalledTimes(0);
  });

  test("one content tablist: Document / Activity", () => {
    const { container } = render(<TaskDocument task={task()} />);
    const tabs = Array.from(container.querySelectorAll("[role='tablist'] [role='tab']")).map(t =>
      t.textContent?.trim(),
    );
    expect(tabs).toEqual(["Document", "Activity"]);
  });

  test("Edit mounts the editor; returning to Read HIDES it without unmounting", async () => {
    const { container } = render(<TaskDocument task={task()} />);
    await tick();
    fireEvent.click(modeButton(container, "Edit"));
    await tick();
    const editor = container.querySelector(".md-editor");
    if (!editor) throw new Error("expected editor after Edit");
    expect(editor.hasAttribute("hidden")).toBe(false);

    fireEvent.click(modeButton(container, "Read"));
    await tick();
    expect(container.querySelector(".md-editor")).toBe(editor); // SAME instance
    expect(editor.hasAttribute("hidden")).toBe(true); // hidden, not unmounted
  });

  test("switching content tabs keeps the editor mounted+hidden", async () => {
    const { container } = render(<TaskDocument task={task()} />);
    fireEvent.click(modeButton(container, "Edit"));
    await tick();
    const editor = container.querySelector(".md-editor");
    if (!editor) throw new Error("expected editor");

    const activityTab = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='tab']")).find(
      b => b.textContent?.trim() === "Activity",
    );
    if (!activityTab) throw new Error("expected Activity tab");
    fireEvent.click(activityTab);
    await tick();
    expect(container.querySelector(".md-editor")).toBe(editor); // still mounted
    expect(editor.hasAttribute("hidden")).toBe(true); // hidden while off-panel
  });

  test("split mode shows editor and debounced preview (150ms)", async () => {
    const { container } = render(<TaskDocument task={task({ body: "start" })} />);
    fireEvent.click(modeButton(container, "Split"));
    await tick();
    const editor = container.querySelector(".md-editor");
    expect(editor?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector(".doc-reader")).not.toBeNull();

    // Type through the stub: the preview must NOT update immediately…
    const typeBtn = container.querySelector<HTMLButtonElement>(".stub-type");
    if (!typeBtn) throw new Error("expected stub type button");
    typeBtn.dataset.text = "changed text";
    fireEvent.click(typeBtn);
    await tick();
    expect(container.querySelector(".doc-reader")?.textContent ?? "").toContain("start");
    // …but after the 150ms debounce it shows the current local draft (polled: a loaded runner fires timers late).
    await waitFor(() => expect(container.querySelector(".doc-reader")?.textContent ?? "").toContain("changed text"), {
      timeout: 2_000,
    });
  });

  test("Read entry immediately shows the latest draft (no debounce wait)", async () => {
    const { container } = render(<TaskDocument task={task({ body: "start" })} />);
    fireEvent.click(modeButton(container, "Edit"));
    await tick();
    const typeBtn = container.querySelector<HTMLButtonElement>(".stub-type");
    if (!typeBtn) throw new Error("expected stub");
    typeBtn.dataset.text = "fresh local edit";
    fireEvent.click(typeBtn);
    fireEvent.click(modeButton(container, "Read"));
    await tick();
    expect(container.querySelector(".doc-reader")?.textContent ?? "").toContain("fresh local edit");
    expect(editTaskMock).toHaveBeenCalledTimes(0); // mode switching never writes
    expect(versionedEditMock).toHaveBeenCalledTimes(0);
  });

  test("empty body shows the add-description affordance instead of an empty reader", async () => {
    const { container } = render(<TaskDocument task={task({ body: null })} />);
    await tick();
    const empty = container.querySelector(".doc-empty-body");
    if (!empty) throw new Error("expected empty-body affordance");
    expect(empty.textContent).toContain("No description");
    const add = empty.querySelector("button");
    if (!add) throw new Error("expected Add description action");
    fireEvent.click(add);
    await tick();
    // Switches into edit mode with the editor mounted.
    expect(readerMode.value).toBe("edit");
    expect(container.querySelector(".md-editor")).not.toBeNull();
  });

  test("Read publishes the task's headings to docOutline", async () => {
    render(<TaskDocument task={task()} />);
    // Two settles: MarkdownView's effect reports headings, then the
    // publishing effect runs on the new headings.
    await tick();
    await tick();
    const outline = docOutline.value;
    expect(outline?.taskId).toBe(5);
    expect(outline?.headings.map(h => [h.id, h.text, h.level])).toEqual([
      ["task-5-alpha", "Alpha", 1],
      ["task-5-beta", "Beta", 2],
    ]);
    expect(outline?.active).toBe("task-5-alpha");
  });

  test("a task-keyed URL fragment scrolls the rendered heading then is consumed", async () => {
    const scrolls: string[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolls.push(this.id);
    };
    try {
      pendingHeadingFragment.value = { taskId: 5, id: "task-5-beta" };
      render(<TaskDocument task={task()} />);
      await tick();
      await tick();
      expect(scrolls).toContain("task-5-beta");
      expect(pendingHeadingFragment.value).toBeNull();
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  test("a bare-slug fragment resolves to the namespaced heading, as cortex app --heading does", async () => {
    const scrolls: string[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolls.push(this.id);
    };
    try {
      pendingHeadingFragment.value = { taskId: 5, id: "beta" };
      render(<TaskDocument task={task()} />);
      await tick();
      await tick();
      expect(scrolls).toContain("task-5-beta");
      expect(pendingHeadingFragment.value).toBeNull();
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  test("a deleted/missing heading target is consumed without scrolling or crashing", async () => {
    const scrolls: string[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolls.push(this.id);
    };
    try {
      pendingHeadingFragment.value = { taskId: 5, id: "task-5-deleted-heading" };
      render(<TaskDocument task={task()} />);
      await tick();
      await tick();
      expect(scrolls).toEqual([]);
      expect(pendingHeadingFragment.value).toBeNull();
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  test("Edit before the atomic baseline arrives: an honest loading state, then ONE editor seeded from it", async () => {
    let answer: (snap: TaskStateSnapshot) => void = () => {};
    taskStateMock.mockImplementationOnce(
      () =>
        new Promise<TaskStateSnapshot>(resolve => {
          answer = resolve;
        }),
    );
    const t = task({ body: "copy from the list" });
    const { container } = render(<TaskDocument task={t} />);
    fireEvent.click(modeButton(container, "Edit"));
    await tick();
    expect(container.querySelector(".md-editor")).toBeNull(); // nothing to type into yet
    expect(container.querySelector(".editor-baseline")?.textContent ?? "").toContain("Loading");
    task({ body: "newer on the daemon" });
    const s = serverTasks.get(5) as { task: Task; versions: Versions };
    answer({ task: structuredClone(s.task), updates: [], versions: { ...s.versions }, cursor: "e1:2" });
    await tick();
    expect(container.querySelector(".editor-baseline")).toBeNull();
    expect(container.querySelector(".md-editor")?.getAttribute("data-value")).toBe("newer on the daemon");
    expect(versionedEditMock).toHaveBeenCalledTimes(0);
  });

  test("body conflict banner stays visible in Read mode (outside the hidden editor)", async () => {
    const t = task({ body: "mine" });
    const { container, rerender } = render(<TaskDocument task={t} />);
    fireEvent.click(modeButton(container, "Edit"));
    await tick();
    const typeBtn = container.querySelector<HTMLButtonElement>(".stub-type");
    if (!typeBtn) throw new Error("expected stub");
    typeBtn.dataset.text = "local dirty edit";
    fireEvent.click(typeBtn);
    // External conflicting write arrives.
    rerender(<TaskDocument task={task({ body: "external version" })} />);
    fireEvent.click(modeButton(container, "Read"));
    await tick();
    const banner = container.querySelector(".external-change-banner");
    if (!banner) throw new Error("expected body conflict banner in read mode");
    expect(banner.textContent).toContain("Body updated externally");
  });

  test("reading position is remembered per task/panel and restored", async () => {
    const { container } = render(<TaskDocument task={task()} />);
    await tick();
    const reader = container.querySelector<HTMLElement>(".doc-reader");
    if (!reader) throw new Error("expected reader");
    reader.scrollTop = 123;
    fireEvent.scroll(reader);
    // Leave the document panel and come back.
    const activityTab = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='tab']")).find(
      b => b.textContent?.trim() === "Activity",
    );
    if (!activityTab) throw new Error("expected Activity tab");
    fireEvent.click(activityTab);
    await tick();
    const docTab = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='tab']")).find(
      b => b.textContent?.trim() === "Document",
    );
    if (!docTab) throw new Error("expected Document tab");
    fireEvent.click(docTab);
    await tick();
    const restored = container.querySelector<HTMLElement>(".doc-reader");
    if (!restored) throw new Error("expected reader after return");
    expect(restored.scrollTop).toBe(123);
  });

  test("tablist keyboard: Left/Right/Home/End move focus (roving), Enter/Space activate", async () => {
    const { container } = render(<TaskDocument task={task()} />);
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='tablist'] [role='tab']"));
    const [doc, activity] = tabs;
    expect(tabs.length).toBe(2);
    const currentTab = (): string => tab.value;
    doc.focus();
    fireEvent.keyDown(doc, { key: "ArrowRight" });
    expect(document.activeElement).toBe(activity);
    expect(currentTab()).toBe("document"); // manual activation: focus only
    fireEvent.keyDown(activity, { key: "ArrowRight" }); // wraps
    expect(document.activeElement).toBe(doc);
    fireEvent.keyDown(doc, { key: "ArrowLeft" }); // wraps back
    expect(document.activeElement).toBe(activity);
    fireEvent.keyDown(activity, { key: "Home" });
    expect(document.activeElement).toBe(doc);
    fireEvent.keyDown(doc, { key: "End" });
    expect(document.activeElement).toBe(activity);
    fireEvent.keyDown(activity, { key: "Enter" });
    await tick();
    expect(currentTab()).toBe("updates");
    fireEvent.keyDown(doc, { key: " " });
    await tick();
    expect(currentTab()).toBe("document");
    // Roving tabindex: only the selected tab is in the Tab sequence.
    const inSequence = Array.from(container.querySelectorAll("[role='tab']")).filter(
      t => t.getAttribute("tabindex") === "0",
    );
    expect(inSequence.length).toBe(1);
  });

  test("hidden panels are excluded from the tab sequence (hidden attribute, not CSS-only)", async () => {
    const { container } = render(<TaskDocument task={task()} />);
    fireEvent.click(modeButton(container, "Edit"));
    await tick();
    const activityTab = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='tab']")).find(
      b => b.textContent?.trim() === "Activity",
    );
    if (!activityTab) throw new Error("expected Activity tab");
    fireEvent.click(activityTab);
    await tick();
    const docPanel = container.querySelector("#doc-panel-document");
    expect(docPanel?.hasAttribute("hidden")).toBe(true);
    expect(container.querySelector(".md-editor")?.hasAttribute("hidden")).toBe(true);
  });

  test("Edit publishes none, and the document renders no outline of its own", async () => {
    const { container } = render(<TaskDocument task={task()} />);
    await tick();
    await tick();
    expect(docOutline.value?.headings.length).toBe(2);
    fireEvent.click(modeButton(container, "Edit"));
    await tick();
    expect(docOutline.value).toEqual({ taskId: 5, headings: [], active: "task-5-alpha" });
    expect(container.querySelector(".doc-outline")).toBeNull();
    expect(container.querySelector(".has-outline")).toBeNull();
  });

  test("mode buttons expose pressed state(buttons, not a second tablist)", () => {
    const { container } = render(<TaskDocument task={task()} />);
    const group = container.querySelector(".doc-mode-switch");
    if (!group) throw new Error("expected mode switch group");
    expect(group.getAttribute("role")).not.toBe("tablist");
    expect(modeButton(container, "Read").getAttribute("aria-pressed")).toBe("true");
    expect(modeButton(container, "Edit").getAttribute("aria-pressed")).toBe("false");
  });
});

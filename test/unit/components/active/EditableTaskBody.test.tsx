// EditableTaskBody — after task 330 it is a THIN body-editor wrapper: the
// TaskDraft owns all reconciliation (useTaskDraft.test.tsx covers that),
// TaskHeader owns the title, and this component just binds MdEditor to the
// draft: value/epoch keying, visibility (hide-not-unmount), Mod-S flush and
// the typed editor handle passthrough.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/preact";
// ESM hooks instance for the stub factory — require("preact/hooks") inside
// the factory would load the CJS build, a SECOND hooks runtime that is not
// wired to the running preact core (options), and crash on first use.
import { useEffect as stubUseEffect } from "preact/hooks";

mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    editTask: mock(() => Promise.resolve({})),
    postUpd: mock(() => Promise.resolve({})),
    setStat: mock(() => Promise.resolve({})),
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
  },
}));

// MdEditor stub (CodeMirror does heavy DOM measurement on mount): mirrors
// the real initial-only contract plus visible/onReady, with probe buttons
// to drive onChange/onSubmit.
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
          <button type="button" class="stub-type" onClick={() => onChange("typed body")} />
          <button type="button" class="stub-submit" onClick={() => onSubmit?.()} />
        </div>
      );
    },
  };
});

import { EditableTaskBody } from "../../../../src/ui/components/active/EditableTaskBody.tsx";
import type { TaskDraft, DraftField } from "../../../../src/ui/lib/useTaskDraft.ts";

function fakeDraft(
  over: Partial<{ body: string; bodyEpoch: number; ready: boolean; loadError: string | null }> = {},
): TaskDraft & {
  calls: { set: Array<[DraftField, string]>; flush: number; reload: number };
} {
  const calls = { set: [] as Array<[DraftField, string]>, flush: 0, reload: 0 };
  return {
    calls,
    title: "t",
    body: over.body ?? "body text",
    bodyEpoch: over.bodyEpoch ?? 0,
    saveState: "saved",
    external: { title: null, body: null },
    ready: over.ready ?? true,
    loadError: over.loadError ?? null,
    set(field: DraftField, value: string) {
      calls.set.push([field, value]);
    },
    flush() {
      calls.flush++;
    },
    retry() {},
    apply() {},
    keep() {},
    reload() {
      calls.reload++;
    },
  };
}

describe("EditableTaskBody", () => {
  beforeEach(() => {});

  test("renders the body editor seeded from the draft", () => {
    const { container } = render(<EditableTaskBody draft={fakeDraft({ body: "hello" })} visible={true} />);
    const editor = container.querySelector(".md-editor");
    expect(editor?.getAttribute("data-value")).toBe("hello");
    expect(editor?.hasAttribute("hidden")).toBe(false);
  });

  test("visible={false} hides the editor without unmounting (D4)", () => {
    const draft = fakeDraft();
    const { container, rerender } = render(<EditableTaskBody draft={draft} visible={true} />);
    const editor = container.querySelector(".md-editor");
    rerender(<EditableTaskBody draft={draft} visible={false} />);
    expect(container.querySelector(".md-editor")).toBe(editor); // same node
    expect(editor?.hasAttribute("hidden")).toBe(true);
    // The wrapper leaves the layout too (its CSS `[hidden]` rule is what
    // actually removes the column in Read mode — Chromium e2e caught a
    // display:block author rule beating the UA [hidden] style).
    expect(container.querySelector(".editable-task-body")?.hasAttribute("hidden")).toBe(true);
    rerender(<EditableTaskBody draft={draft} visible={true} />);
    expect(container.querySelector(".editable-task-body")?.hasAttribute("hidden")).toBe(false);
  });

  test("editor input routes through draft.set('body', …)", () => {
    const draft = fakeDraft();
    const { container } = render(<EditableTaskBody draft={draft} visible={true} />);
    fireEvent.click(container.querySelector(".stub-type") as HTMLButtonElement);
    expect(draft.calls.set).toEqual([["body", "typed body"]]);
  });

  test("Mod-S (editor onSubmit) flushes the draft", () => {
    const draft = fakeDraft();
    const { container } = render(<EditableTaskBody draft={draft} visible={true} />);
    fireEvent.click(container.querySelector(".stub-submit") as HTMLButtonElement);
    expect(draft.calls.flush).toBe(1);
  });

  test("bodyEpoch change remounts the editor with the new draft text (external replacement)", () => {
    const { container, rerender } = render(
      <EditableTaskBody draft={fakeDraft({ body: "v1", bodyEpoch: 0 })} visible={true} />,
    );
    const before = container.querySelector(".md-editor");
    rerender(<EditableTaskBody draft={fakeDraft({ body: "v2 external", bodyEpoch: 1 })} visible={true} />);
    const after = container.querySelector(".md-editor");
    expect(after).not.toBe(before); // key change → fresh mount
    expect(after?.getAttribute("data-value")).toBe("v2 external");
  });

  test("no editor until the atomic baseline is known: an honest loading status holds its place", () => {
    const seen: Array<unknown> = [];
    const { container, rerender } = render(
      <EditableTaskBody draft={fakeDraft({ ready: false })} visible={true} onReady={h => seen.push(h)} />,
    );
    expect(container.querySelector(".md-editor")).toBeNull(); // nothing can be typed yet
    const status = container.querySelector(".editor-baseline");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent ?? "").toContain("Loading");
    expect(seen).toEqual([]);
    // The baseline arrives: the editor mounts ONCE with the seeded text.
    rerender(<EditableTaskBody draft={fakeDraft({ ready: true, body: "seeded" })} visible={true} />);
    expect(container.querySelector(".editor-baseline")).toBeNull();
    expect(container.querySelector(".md-editor")?.getAttribute("data-value")).toBe("seeded");
  });

  test("a failed baseline says why and offers a Retry that reloads it", () => {
    const draft = fakeDraft({ ready: false, loadError: "daemon unreachable" });
    const { container } = render(<EditableTaskBody draft={draft} visible={true} />);
    expect(container.querySelector(".md-editor")).toBeNull();
    const status = container.querySelector(".editor-baseline");
    expect(status?.getAttribute("role")).toBe("alert");
    expect(status?.textContent ?? "").toContain("daemon unreachable");
    const retry = status?.querySelector("button");
    if (!retry) throw new Error("expected Retry");
    fireEvent.click(retry);
    expect(draft.calls.reload).toBe(1);
  });

  test("forwards the typed editor handle through onReady", () => {
    const seen: Array<unknown> = [];
    render(<EditableTaskBody draft={fakeDraft()} visible={true} onReady={h => seen.push(h)} />);
    expect(seen.length).toBe(1);
    expect(typeof (seen[0] as { focus(): void }).focus).toBe("function");
  });
});

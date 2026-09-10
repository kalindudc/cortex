// CONTRACT-STUB ONLY: CodeMirror's real measurement/focus behavior cannot be
// asserted meaningfully in happy-dom, and bun's process-global mock.module
// (registered by EditableTaskBody.test.tsx, which runs earlier) already
// replaces this specifier. This file re-registers a stub that mirrors the
// REAL MdEditor contract — initial-only value/placeholder plus the task-330
// additions: `visible` (hide-not-unmount) and `onReady` (typed
// MdEditorHandle on mount, null on unmount). Real editor behavior (cursor,
// undo, Mod-S, Tab, focus, measure-after-reveal) is exercised in Chromium
// by the task-10 e2e specs, not here.

import { describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/preact";
import { useEffect } from "preact/hooks";
import type { MdEditorHandle } from "../../../../src/ui/components/active/MdEditor.tsx";

mock.module("../../../../src/ui/components/active/MdEditor.tsx", () => ({
  MdEditor: ({
    value,
    placeholder,
    visible,
    onReady,
  }: {
    value: string;
    placeholder?: string;
    visible?: boolean;
    onReady?: (handle: MdEditorHandle | null) => void;
  }) => {
    // Mirror the real component: hand out a stable handle on mount and
    // null it on unmount.
    useEffect(() => {
      const handle: MdEditorHandle = { focus: () => {}, requestMeasure: () => {} };
      onReady?.(handle);
      return () => onReady?.(null);
    }, []);
    return <div class="md-editor" hidden={visible === false} data-value={value} data-placeholder={placeholder} />;
  },
}));

import { MdEditor } from "../../../../src/ui/components/active/MdEditor.tsx";

describe("MdEditor (contract stub)", () => {
  test("mounts a .md-editor host element", () => {
    const { container } = render(<MdEditor value="hello" onChange={() => {}} />);
    expect(container.querySelector(".md-editor")).toBeTruthy();
  });

  test("visible={false} hides the host WITHOUT unmounting it (D4)", () => {
    const { container, rerender } = render(<MdEditor value="x" onChange={() => {}} visible={true} />);
    const host = container.querySelector(".md-editor");
    expect(host?.hasAttribute("hidden")).toBe(false);
    rerender(<MdEditor value="x" onChange={() => {}} visible={false} />);
    expect(container.querySelector(".md-editor")).toBe(host); // same node — no remount
    expect(host?.hasAttribute("hidden")).toBe(true);
  });

  test("onReady receives a typed handle on mount and null on unmount (D4)", () => {
    const seen: Array<MdEditorHandle | null> = [];
    const { unmount } = render(<MdEditor value="x" onChange={() => {}} onReady={h => seen.push(h)} />);
    expect(seen.length).toBe(1);
    expect(typeof seen[0]?.focus).toBe("function");
    expect(typeof seen[0]?.requestMeasure).toBe("function");
    unmount();
    expect(seen.length).toBe(2);
    expect(seen[1]).toBeNull();
  });
});

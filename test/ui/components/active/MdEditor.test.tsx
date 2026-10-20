// CONTRACT-STUB ONLY: CodeMirror's real measurement/focus behavior cannot be
// asserted meaningfully in happy-dom, and bun's process-global mock.module
// (registered by EditableTaskBody.test.tsx, which runs earlier) already
// replaces this specifier. This file re-registers a stub that mirrors the
// REAL MdEditor contract — initial-only value/placeholder, `visible`
// (hide-not-unmount) and `onReady` (typed MdEditorHandle on mount, null on
// unmount). Real editor behavior (typing, autosave, growth) is exercised in
// Chromium by integrations/desktop/test/document-surface.test.ts, not here.
//
// The reference decorations (refsExtension.ts) are real CodeMirror and are
// pinned below: `@id` and `#tag` text is marked `.cm-cortex-ref` and
// Mod+click follows it. There is no `@`-completion in the editor.

import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
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
import { cortexRefs } from "../../../../src/ui/components/active/refsExtension.ts";
import { REF_RE } from "../../../../src/lib/refGrammar.ts";

describe("MdEditor (contract stub)", () => {
  test("mounts a .md-editor host element", () => {
    const { container } = render(<MdEditor value="hello" onChange={() => {}} />);
    expect(container.querySelector(".md-editor")).toBeTruthy();
  });

  test("visible={false} hides the host WITHOUT unmounting it", () => {
    const { container, rerender } = render(<MdEditor value="x" onChange={() => {}} visible={true} />);
    const host = container.querySelector(".md-editor");
    expect(host?.hasAttribute("hidden")).toBe(false);
    rerender(<MdEditor value="x" onChange={() => {}} visible={false} />);
    expect(container.querySelector(".md-editor")).toBe(host); // same node — no remount
    expect(host?.hasAttribute("hidden")).toBe(true);
  });

  test("onReady receives a typed handle on mount and null on unmount", () => {
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

describe("cortexRefs (editor reference decorations)", () => {
  test("keeps its own regex literal identical to REF_RE (a g regex is never shared)", () => {
    const src = readFileSync(new URL("../../../../src/ui/components/active/refsExtension.ts", import.meta.url), "utf8");
    const literal = /regexp:\s*\/(.+)\/([a-z]*),/.exec(src);
    expect(literal).not.toBeNull();
    expect(literal?.[1]).toBe(REF_RE.source);
    expect(literal?.[2]).toBe(REF_RE.flags);
  });

  test("decorates @id and #tag text as .cm-cortex-ref", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({ state: EditorState.create({ doc: "", extensions: cortexRefs() }), parent });
    try {
      view.dispatch({ changes: { from: 0, insert: "see @12 and #plan" } });
      const refs = [...parent.querySelectorAll<HTMLElement>(".cm-cortex-ref")];
      expect(refs.map(r => r.textContent)).toEqual(["@12", "#plan"]);
      expect(refs.map(r => r.dataset.refKind)).toEqual(["task", "tag"]);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

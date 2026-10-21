// CONTRACT STUB, plus the real editor's paper look. CodeMirror's real
// measurement/focus behavior cannot be asserted meaningfully in happy-dom,
// so this file registers a stub that mirrors the
// REAL MdEditor contract — initial-only value/placeholder, `visible`
// (hide-not-unmount) and `onReady` (typed MdEditorHandle on mount, null on
// unmount). Real editor behavior (typing, autosave, growth) is exercised in
// Chromium by integrations/desktop/test/document-surface.test.ts, not here.
//
// The real component is rendered too, for what happy-dom CAN show: the
// line-number gutter, the theme CodeMirror mounts as a <style> element, and
// the highlight classes on the Markdown marks.
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
import { MdEditor, type MdEditorHandle } from "../../../../src/ui/components/active/MdEditor.tsx";
import { cortexRefs } from "../../../../src/ui/components/active/refsExtension.ts";
import { REF_RE } from "../../../../src/lib/refGrammar.ts";

// Imports are evaluated before this file's body, so this still holds the
// real component: mock.module below rebinds the `MdEditor` import itself to
// the stub, not this constant. Each test:ui file runs isolated, so no other
// file's mock of this module is in place yet.
const RealMdEditor = MdEditor;

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

// The rules CodeMirror mounted as <style> text (happy-dom applies none of
// them), in stylesheet order, one entry per selector of a selector list.
function mountedRules(): Array<{ selector: string; decls: Map<string, string> }> {
  const css = [...document.querySelectorAll("style")].map(s => s.textContent ?? "").join("\n");
  const rules: Array<{ selector: string; decls: Map<string, string> }> = [];
  for (const [, selectors = "", body = ""] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map<string, string>();
    for (const decl of body.split(";")) {
      const colon = decl.indexOf(":");
      if (colon > 0) decls.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
    }
    for (const selector of selectors.split(",")) rules.push({ selector: selector.trim(), decls });
  }
  return rules;
}

// The style-mod classes CodeMirror scopes its themes and highlights with.
const scopeClasses = (el: Element) => [...el.classList].filter(c => !c.startsWith("cm-"));

// Every value of `prop` that a theme on `editor` sets for `.<scope> <target>`
// (or for the root itself when target is empty), in stylesheet order. The
// last one wins: CodeMirror mounts its base theme before the cortex theme,
// and both use one scope class.
function themed(editor: Element, target: string, prop: string): string[] {
  const selectors = new Set(scopeClasses(editor).map(c => (target ? `.${c} ${target}` : `.${c}`)));
  return mountedRules().flatMap(r => {
    const value = r.decls.get(prop);
    return selectors.has(r.selector) && value !== undefined ? [value] : [];
  });
}

// The colour a highlighted span ends up with: highlight rules are one class
// each, so the last matching rule in the stylesheet wins.
function spanColor(span: Element): string | undefined {
  const selectors = new Set(scopeClasses(span).map(c => `.${c}`));
  return mountedRules()
    .filter(r => selectors.has(r.selector) && r.decls.has("color"))
    .at(-1)
    ?.decls.get("color");
}

function renderReal(doc: string): HTMLElement {
  const { container } = render(<RealMdEditor value={doc} onChange={() => {}} />);
  const editor = container.querySelector<HTMLElement>(".cm-editor");
  if (!editor) throw new Error("expected the real CodeMirror editor");
  return editor;
}

describe("MdEditor on paper (the real editor)", () => {
  test("renders a faint line-number gutter with no divider, the active number one step darker", () => {
    const editor = renderReal("## Goal\n\ntext");
    const numbers = [...editor.querySelectorAll<HTMLElement>(".cm-gutters .cm-lineNumbers .cm-gutterElement")]
      .filter(el => el.style.visibility !== "hidden")
      .map(el => el.textContent);
    expect(numbers).toEqual(["1", "2", "3"]);
    expect(editor.querySelector(".cm-activeLineGutter")?.textContent).toBe("1");

    expect(themed(editor, ".cm-gutters", "background-color").at(-1)).toBe("transparent");
    expect(themed(editor, ".cm-gutters", "border").at(-1)).toBe("none");
    expect(themed(editor, ".cm-gutters", "color").at(-1)).toBe("var(--text-4)");
    expect(themed(editor, ".cm-lineNumbers .cm-gutterElement", "font-size").at(-1)).toBe("12px");
    expect(themed(editor, ".cm-activeLineGutter", "color").at(-1)).toBe("var(--text-3)");
  });

  test("sets the write font on .cm-content and the gutter, and paints no background of its own", () => {
    const editor = renderReal("text");
    expect(themed(editor, ".cm-content", "font-family")).toEqual(["var(--font-write)"]);
    expect(themed(editor, ".cm-gutters", "font-family").at(-1)).toBe("var(--font-write)");
    expect(themed(editor, ".cm-scroller", "font-family").at(-1)).toBe("var(--font-write)");
    expect(themed(editor, "", "font-size").at(-1)).toBe("14.5px");
    expect(themed(editor, ".cm-scroller", "line-height").at(-1)).toBe("1.8");
    expect(themed(editor, "", "background-color").at(-1)).toBe("transparent");
    expect(themed(editor, ".cm-content", "background-color").at(-1)).toBe("transparent");
    const scoped = mountedRules().filter(r => scopeClasses(editor).some(c => r.selector.startsWith(`.${c}`)));
    expect(scoped.some(r => [...r.decls.values()].some(v => v.includes("--font-mono")))).toBe(false);
  });

  test("draws the Markdown marks in --text-4 and the words in ink", () => {
    const editor = renderReal("## Goal\n\n- [ ] todo **bold** `code` [link](u)");
    const spans = [...editor.querySelectorAll(".cm-line span")];
    const colorOf = (text: string) => {
      const span = spans.find(s => s.textContent?.trim() === text);
      if (!span) throw new Error(`no span for ${text}`);
      return spanColor(span);
    };
    for (const mark of ["##", "-", "[ ]", "**", "`", "["]) expect(colorOf(mark), mark).toBe("var(--text-4)");
    expect(colorOf("Goal")).toBe("var(--text)");
    expect(colorOf("bold")).toBe("var(--text)");
    expect(colorOf("code")).toBe("var(--code-accent)");
    expect(colorOf("link")).toBe("var(--code-accent)");
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

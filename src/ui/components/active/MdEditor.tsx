// MdEditor — CodeMirror-backed description view.
//
// Always-editable. The editor is the source of truth for in-flight edits;
// callers feed the initial doc via `value` and observe edits via onChange.
// We never push `value` back into the editor after mount — SSE echoes are
// handled at a higher level (EditableTaskBody owns local signals, and a
// `key={task.id}` on the wrapper re-mounts on task switch so each task
// gets a fresh editor with the new document).
//
// Props:
//   value       — string, INITIAL document only. Not re-applied after mount.
//   onChange    — (newDoc:string) => void; called on every doc edit.
//   onSubmit    — () => void; called on Cmd/Ctrl+S inside the editor.
//   placeholder — string shown by CM6's placeholder extension when the
//                 document is empty (hides on focus, per CM6 default).
//
// Theme: a single EditorView.theme() pulls every color/font from cortex CSS
// variables (var(--bg), var(--text-content), var(--accent-tint), etc.), so
// the editor automatically follows light/dark mode and any future palette
// retune. Markdown source highlighting maps lezer tags to the same tokens
// that the old hljs-based .md-source view used.

import type { VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";

import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  placeholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { cortexRefs } from "./refsExtension.ts";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const cortexHighlight = HighlightStyle.define([
  {
    tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6],
    color: "var(--text)",
    fontWeight: "700",
  },
  { tag: t.strong, color: "var(--text)", fontWeight: "700" },
  { tag: t.emphasis, color: "var(--text)", fontStyle: "italic" },
  { tag: t.list, color: "var(--code-accent)", fontWeight: "600" },
  { tag: t.monospace, color: "var(--code-accent)" },
  { tag: [t.link, t.url], color: "var(--info)", textDecoration: "underline", textUnderlineOffset: "2px" },
  { tag: t.quote, color: "var(--text-3)", fontStyle: "italic" },
  { tag: t.comment, color: "var(--text-3)", fontStyle: "italic" },
  { tag: t.meta, color: "var(--info)" },
  { tag: t.number, color: "var(--warn)" },
  // NOTE: @lezer/highlight does NOT export a `title` tag (verified against
  // its .d.ts — only `heading`, `heading1`..`heading6` cover header content).
  // Referencing `t.title` here would resolve to undefined and crash
  // HighlightStyle.define on first import. Headings are already styled above.
]);

const cortexCmTheme = EditorView.theme({
  // Editor root is fully transparent so the page's paper-dot pattern (set
  // on .pane-active above) shows through both display and edit modes. Any
  // backgroundColor here would paint a flat "slab" over the dots and make
  // the editor look bolted on. Highlights (.cm-activeLine, selection) are
  // the only painted surfaces — those use --accent-tint intentionally.
  "&": {
    color: "var(--text-content)",
    backgroundColor: "transparent",
    fontSize: "var(--fs-3)",
    fontFamily: "var(--font-mono)",
    height: "100%",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    padding: "6px 0",
    caretColor: "var(--accent)",
    color: "var(--text-content)",
    backgroundColor: "transparent",
  },
  ".cm-line": { padding: "0 8px" },
  ".cm-gutters": {
    // Transparent so the active-body's own background shows through; we
    // intentionally do NOT paint a panel surface here — the gutter is meant
    // to feel like part of the page, not a separate chrome strip. The
    // border-right alone provides enough visual separation from content.
    backgroundColor: "transparent",
    color: "var(--text-3)",
    border: "0",
    borderRight: "1px solid var(--border)",
    fontFamily: "var(--font-mono)",
    userSelect: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 8px 0 10px",
    minWidth: "2.5ch",
    color: "var(--text-3)",
  },
  // Active line uses --active-line, NOT --accent-tint. CM6 paints the
  // selection layer (.cm-selectionLayer) at z-index: -1 — behind the
  // text so glyphs aren't masked — which means it's ALSO behind any
  // background painted on .cm-line. An opaque background here would hide
  // the selection on the active line. --active-line is rgba with low
  // alpha so the cool --selection shows through where they overlap.
  // (Confirmed by Marijn on https://discuss.codemirror.net/t/7157.)
  // The gutter has no selection layer to worry about, but we keep both
  // tokens in sync so the visual stays unified.
  ".cm-activeLineGutter": {
    backgroundColor: "var(--active-line)",
    color: "var(--text)",
  },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  // Selection styling. CM6's bundled view default theme ships rules that
  // BEAT naive overrides on both specificity AND !important — we have to
  // match both. The exact CM6 defaults (from @codemirror/view 6.42 source):
  //
  //   &light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground { background: #d7d4f0 }
  //   &dark.cm-focused  > .cm-scroller > .cm-selectionLayer .cm-selectionBackground { background: #233 }
  //   & ::selection, &::selection { background-color: transparent !important }
  //   &::selection, & ::selection { background-color: Highlight !important }
  //
  // We do NOT pass `{ dark: true }` to EditorView.theme below — our theme
  // is variable-driven (CSS custom properties from html[data-theme]) so a
  // single rule serves both modes. But CM's selector defaults to the
  // `&light` branch in that case, which is why the light-purple #d7d4f0
  // bleeds through in dark mode (the bug this block fixes).
  //
  // Two modes:
  //   1. Edit mode — drawSelection() paints <div .cm-selectionBackground>
  //      BEHIND the text. Selector below matches CM's exact 5-class form
  //      so we beat it on tie (we load last) AND adds !important for belt
  //      and suspenders. Text color is unchanged in this mode (the layer
  //      has no text), so contrast = --selection vs --text-content.
  //   2. Display/readonly mode — no drawSelection; native ::selection.
  //      CM defaults use !important so we MUST too, or the system
  //      Highlight color wins.
  //
  // Selection uses --selection (cool blue-grey). The active line above
  // uses --active-line (translucent warm wash). They MUST be different
  // tokens AND --active-line must be translucent — see the comment on
  // .cm-activeLine for why opacity matters (CM's selection layer is
  // painted behind text).
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, & > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
    {
      backgroundColor: "var(--selection) !important",
    },
  "& ::selection, &::selection": {
    backgroundColor: "var(--selection) !important",
    color: "var(--text) !important",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.5",
    overflow: "auto",
    scrollbarWidth: "thin",
    scrollbarColor: "var(--border-strong) transparent",
  },
  ".cm-scroller::-webkit-scrollbar": { width: "8px", height: "8px" },
  ".cm-scroller::-webkit-scrollbar-track": { background: "transparent" },
  ".cm-scroller::-webkit-scrollbar-thumb": { background: "var(--border-strong)", borderRadius: "4px" },
  ".cm-scroller::-webkit-scrollbar-thumb:hover": { background: "var(--text-3)" },
  "&.cm-focused": { outline: "none" },
});

// Static keymap entries shared by every MdEditor instance — only the
// `Mod-s` entry above is closure-bound (per-instance onSubmit). Exported
// so the unit test can assert that Tab indent + Mod-z undo are wired
// without spawning a real CodeMirror inside happy-dom.
//
// Order is load-bearing:
//   defaultKeymap   — baseline editing
//   historyKeymap   — Mod-Z / Mod-Shift-Z / Mod-Y undo+redo
//   indentWithTab   — MUST come AFTER defaultKeymap so plain Tab still
//                     moves keyboard focus when the editor is unfocused.
export const staticMdKeymap = [...defaultKeymap, ...historyKeymap, indentWithTab];

// Narrow typed imperative surface handed to the owner via onReady:
// focus the editor, or ask CodeMirror to re-measure after the host is
// revealed from `hidden` (CM cannot measure display:none content).
export interface MdEditorHandle {
  focus(): void;
  requestMeasure(): void;
}

export interface MdEditorProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  // Read-only mounts the editor without contentEditable AND with state-level
  // readOnly. Both are required: editable.of(false) blocks caret/IME, readOnly
  // blocks programmatic dispatches. Fixed for the lifetime of this instance.
  readOnly?: boolean;
  // Hide WITHOUT unmounting: the same EditorView instance (cursor,
  // undo history, pending edits) survives Read/Activity/Related passes.
  // `hidden` removes the host from layout AND the a11y/tab order, so
  // hidden editors are never keyboard-focusable. Default: visible.
  visible?: boolean;
  // Receives the typed handle once the EditorView exists; null on unmount.
  onReady?: (handle: MdEditorHandle | null) => void;
}

export function MdEditor({
  value,
  onChange,
  onSubmit,
  placeholder: phText,
  readOnly,
  visible,
  onReady,
}: MdEditorProps): VNode {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Refs for callbacks so the editor (mounted once) always sees the latest
  // closure even though the parent re-renders and passes fresh function
  // identities every time.
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const onReadyRef = useRef(onReady);
  onChangeRef.current = onChange;
  onSubmitRef.current = onSubmit;
  onReadyRef.current = onReady;

  useEffect(() => {
    const exts = [
      lineNumbers(),
      markdown(),
      syntaxHighlighting(cortexHighlight),
      cortexCmTheme,
      EditorView.lineWrapping,
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      history(),
      keymap.of(
        readOnly
          ? staticMdKeymap
          : [
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  onSubmitRef.current?.();
                  return true;
                },
              },
              ...staticMdKeymap,
            ],
      ),
      EditorView.updateListener.of(u => {
        if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
      }),
      ...cortexRefs(),
    ];
    if (readOnly) {
      // Both flags are required to make the editor truly read-only:
      //   EditorState.readOnly.of(true) blocks doc-mutating dispatches.
      //   EditorView.editable.of(false) removes contentEditable so the
      //   user cannot place a caret, select, or open the IME.
      // Fixed per instance — modal mounts a fresh MdEditor each open.
      exts.push(EditorState.readOnly.of(true));
      exts.push(EditorView.editable.of(false));
    }
    // CodeMirror's placeholder hides on focus, not on non-empty content —
    // acceptable since focus is the moment the user is committing to edit.
    if (phText) exts.push(placeholder(phText));

    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({ doc: value || "", extensions: exts }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    onReadyRef.current?.({
      focus: () => view.focus(),
      requestMeasure: () => view.requestMeasure(),
    });
    return () => {
      onReadyRef.current?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount once; the editor is the source of truth for in-flight edits.

  return <div class="md-editor" hidden={visible === false} ref={hostRef}></div>;
}

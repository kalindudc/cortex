// refsExtension.ts — CodeMirror 6 wiring for `@id` / `#tag` references
// inside the Markdown body editor.
//
// Three extensions, returned together so callers can spread the array
// into the editor's extension list:
//   1. A ViewPlugin built on MatchDecorator that wraps every match in a
//      `Decoration.mark` (NOT replace) so the source remains editable
//      and selectable. The class + `data-*` attributes drive both the
//      styling and the click handler.
//   2. EditorView.domEventHandlers({ mousedown }) implements Mod+click
//      navigation. Plain clicks fall through to CM's caret placement;
//      only `metaKey || ctrlKey` clicks on a `.cm-cortex-ref` trigger
//      `navigateRef` and swallow the event.
//   3. A modKeyTracker ViewPlugin that toggles a `cm-mod-down` class on
//      the editor root while Meta/Control is held — the CSS rule
//      `.md-editor .cm-mod-down .cm-cortex-ref { cursor: pointer; }`
//      gives the user a clickable-link affordance without breaking
//      caret editing the rest of the time.
//
// The regex is a fresh instance — MatchDecorator's contract is that it
// owns and mutates `lastIndex`, so refs.ts's REF_RE MUST NOT be reused
// here. The grammar must stay byte-for-byte identical between the two.

import type { Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import { navigateRef } from "../../lib/refs.ts";

/**
 * Walk up `node`'s parent chain looking for an element carrying the
 * `data-ref-kind` attribute set by the decorator below. CM may split a
 * single mark across nested spans (e.g. when the lezer markdown highlight
 * wraps the same range), so a direct `event.target` check is not enough.
 */
function findRefEl(node: Node | null): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur.nodeType !== 1) cur = cur.parentNode;
  let el = cur as HTMLElement | null;
  while (el && !el.dataset.refKind) el = el.parentElement;
  return el;
}

export function cortexRefs(): Extension[] {
  const refDecorator = new MatchDecorator({
    // Fresh regex per call — MatchDecorator mutates lastIndex internally.
    regexp: /(?<![A-Za-z0-9_])@(\d+)(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])#([a-z0-9_@-]{1,32})(?![A-Za-z0-9_])/g,
    decoration: m => {
      if (m[1] !== undefined) {
        return Decoration.mark({
          class: "cm-cortex-ref cm-cortex-ref-task",
          attributes: { "data-ref-kind": "task", "data-ref-id": m[1] },
        });
      }
      // m[2] !== undefined by exhaustion of the alternation.
      return Decoration.mark({
        class: "cm-cortex-ref cm-cortex-ref-tag",
        attributes: { "data-ref-kind": "tag", "data-ref-id": m[2] },
      });
    },
  });

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = refDecorator.createDeco(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) {
          this.decorations = refDecorator.updateDeco(u, this.decorations);
        }
      }
    },
    { decorations: v => v.decorations },
  );

  const clickHandler = EditorView.domEventHandlers({
    mousedown(event) {
      // Left-click only; plain click stays a caret placement.
      if (event.button !== 0) return false;
      if (!(event.metaKey || event.ctrlKey)) return false;
      const el = findRefEl(event.target as Node | null);
      if (!el) return false;
      const kind = el.dataset.refKind;
      const id = el.dataset.refId;
      if ((kind !== "task" && kind !== "tag") || id === undefined) return false;
      event.preventDefault();
      navigateRef(kind, id);
      return true;
    },
  });

  // Track Meta/Control state at the window level so the affordance
  // survives focus changes and lives across multiple editors mounted on
  // the same page. Class is toggled on the EditorView's scrollable root
  // (`view.dom`) so the CSS selector `.md-editor .cm-mod-down ...` works
  // even though the .md-editor wrapper is owned by the React component.
  const modTracker = ViewPlugin.fromClass(
    class {
      private down = false;
      private readonly onKeyDown: (e: KeyboardEvent) => void;
      private readonly onKeyUp: (e: KeyboardEvent) => void;
      private readonly onBlur: () => void;
      constructor(private readonly view: EditorView) {
        this.onKeyDown = e => {
          if ((e.key === "Meta" || e.key === "Control") && !this.down) {
            this.down = true;
            this.view.dom.classList.add("cm-mod-down");
          }
        };
        this.onKeyUp = e => {
          if (e.key === "Meta" || e.key === "Control") this.clear();
        };
        this.onBlur = () => this.clear();
        window.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("keyup", this.onKeyUp);
        window.addEventListener("blur", this.onBlur);
      }
      private clear() {
        if (!this.down) return;
        this.down = false;
        this.view.dom.classList.remove("cm-mod-down");
      }
      destroy() {
        window.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("keyup", this.onKeyUp);
        window.removeEventListener("blur", this.onBlur);
        this.clear();
      }
    },
  );

  return [plugin, clickHandler, modTracker];
}

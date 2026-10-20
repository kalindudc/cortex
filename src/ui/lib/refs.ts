// ui/lib/refs.ts — Single source of truth for in-text `@id` / `#tag`
// references inside task bodies and update summaries.
//
// Three render surfaces consume references:
//   1. Plain-text update bubbles → RefText.tsx walks parseRefs() output.
//   2. CodeMirror body editor    → refsExtension.ts decorates matches.
//   3. Server-side related scan  → store.ts owns its own REF_RE instance
//      to keep this module zero-dep on the store.
//
// The grammar itself (REF_RE, parseRefs) lives in refGrammar.ts, which has
// no runtime imports so the daemon's store can share it without loading
// the browser's signals; it is re-exported here unchanged.

import { clearAllFilters, selectedId, setFilter, tasks } from "../state/signals.ts";

export { parseRefs, REF_RE, type RefSegment } from "../../lib/refGrammar.ts";

/**
 * Activate a reference: clicking a task ref selects the target (only if
 * the task exists — non-existent ids are no-op'd with a console.warn so
 * a typo'd ref doesn't silently navigate to the wrong active task via
 * the activeTask fallback). Clicking a tag ref REPLACES the tag filter
 * with a single entry — predictable navigation over the toggle semantics
 * used elsewhere.
 *
 * `value` is the raw captured string (so the caller doesn't need to
 * `Number()` it).
 */
export function navigateRef(kind: "task" | "tag", value: string): void {
  if (kind === "task") {
    const id = Number(value);
    if (!Number.isFinite(id)) return;
    // Guard against silent fallback: activeTask falls through to the
    // first visible task when selectedId doesn't resolve. Skip the nav
    // entirely if the target isn't loaded (typo'd or deleted ref).
    const exists = tasks.value.some(t => t.id === id);
    if (!exists) {
      console.warn(`cortex: reference to task @${id} skipped — task not found`);
      return;
    }
    clearAllFilters();
    selectedId.value = id;
  } else {
    setFilter("tag", [value]);
  }
}

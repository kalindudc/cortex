// ui/lib/refs.ts — Single source of truth for in-text `@id` / `#tag`
// references inside task bodies and update summaries.
//
// Three render surfaces consume references:
//   1. Plain-text update bubbles → RefText.tsx walks parseRefs() output.
//   2. CodeMirror body editor    → refsExtension.ts decorates matches.
//   3. Server-side related scan  → store.ts owns its own REF_RE instance
//      to keep this module zero-dep on the store.
//
// Each consumer holds its OWN RegExp instance because the `g` flag means
// `lastIndex` mutates per match. NEVER share a stateful regex across
// callers. The tag char class is intentionally identical to TAG_NAME_RE
// in store.ts so an in-text ref cannot validate as a ref but fail to
// match a real tag.

import { clearAllFilters, selectedId, setFilter, tasks } from "../state/signals.ts";

/**
 * Bracketless ref grammar with word-boundary guards so refs inside
 * identifiers / URLs / emails don't spuriously match. Two alternations:
 *   - `@<digits>`         (task ref; group 1 = id)
 *   - `#<a-z0-9_@->{1,32}` (tag ref;  group 2 = name)
 *
 * Lookbehind `(?<![A-Za-z0-9_])` keeps `path@123` from matching;
 * lookahead `(?![A-Za-z0-9_])` keeps `@123abc` from matching.
 * Markdown headings like `# Heading` don't match because the space
 * after `#` isn't in the tag char class so the {1,32} length fails.
 */
export const REF_RE = /(?<![A-Za-z0-9_])@(\d+)(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])#([a-z0-9_@-]{1,32})(?![A-Za-z0-9_])/g;

export type RefSegment = { kind: "text"; text: string } | { kind: "task"; id: number } | { kind: "tag"; name: string };

/**
 * Split `text` into interleaved plain-text and ref segments. Empty input
 * yields `[]` so callers can short-circuit. Consecutive refs produce zero
 * intervening text segments.
 */
export function parseRefs(text: string): RefSegment[] {
  if (text.length === 0) return [];
  const out: RefSegment[] = [];
  // Fresh regex — REF_RE has `g` and mutates lastIndex across calls.
  const re = new RegExp(REF_RE.source, REF_RE.flags);
  let cursor = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > cursor) out.push({ kind: "text", text: text.slice(cursor, start) });
    if (m[1] !== undefined) {
      out.push({ kind: "task", id: Number(m[1]) });
    } else if (m[2] !== undefined) {
      out.push({ kind: "tag", name: m[2] });
    }
    cursor = start + m[0].length;
  }
  if (cursor < text.length) out.push({ kind: "text", text: text.slice(cursor) });
  return out;
}

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

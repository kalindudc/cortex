// ui/lib/refGrammar.ts — the in-text `@id` / `#tag` reference grammar, with
// NO runtime imports, so every renderer can share it: the browser (through
// refs.ts, which re-exports it beside its signal-driven navigateRef) and the
// terminal reader (src/tui/reader.ts), which must not load the browser's
// singleton signals (plan @400 N15).
//
// Each consumer holds its OWN RegExp instance because the `g` flag means
// `lastIndex` mutates per match. NEVER share a stateful regex across
// callers. The tag char class is intentionally identical to TAG_NAME_RE
// in store.ts so an in-text ref cannot validate as a ref but fail to
// match a real tag.

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

// lib/highlight.tsx — a search result's matched ranges as <mark class="search-hit">
// runs, shared by the palette's task search and the Search panel.

import type { VNode } from "preact";

export function renderHighlightedText(
  text: string,
  ranges: Array<{ start: number; end: number }> = [],
): Array<string | VNode> {
  if (ranges.length === 0) return [text];
  const chunks: Array<string | VNode> = [];
  let cursor = 0;
  ranges.forEach((range, i) => {
    if (range.start > cursor) chunks.push(text.slice(cursor, range.start));
    chunks.push(
      <mark class="search-hit" key={`${range.start}-${range.end}-${i}`}>
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) chunks.push(text.slice(cursor));
  return chunks;
}

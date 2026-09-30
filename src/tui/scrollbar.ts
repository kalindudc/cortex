/**
 * The document body's scrollbar: one column at a body pane's right edge
 * (Read, Edit, each Split half) that says whether there is more text above
 * or below, and roughly where the view is.
 *
 * Thumb only, no track glyph: the track is a blank cell. `│` is already the
 * list/document divider and Split's halves' rule (and the PTY safety checks
 * align columns on it), so a `│` track would be ambiguous and would double
 * the Split rule. The thumb `┃` carries the meaning without color.
 *
 * End rules: while there is text above, the thumb never touches the first
 * row; while there is text below, never the last. At the very top it starts
 * on the first row, and at the end it reaches the last one.
 *
 * The shell paints it ONLY from `Shell.#readerRows` / `Shell.#editorRows`
 * (src/tui/app.ts): the body renders at `width - 1` and this column is
 * appended, always reserved so the wrap width never depends on overflow.
 */
import { type ResolvedTheme, style } from "./theme.ts";

/** A body's scroll position: its first shown row and its content rows. */
export interface ScrollPosition {
  readonly top: number;
  readonly total: number;
}

export const SCROLL_THUMB = "┃";

/** The thumb's rows [from, to) in a track of `height` rows, or null when the body fits (or there is no track). */
export function scrollThumb(
  position: ScrollPosition,
  height: number,
): { readonly from: number; readonly to: number } | null {
  const top = Math.max(0, position.top);
  if (height <= 0 || (top === 0 && position.total <= height)) return null;
  // The reader may scroll past the natural end (its last heading on the top row).
  const end = Math.max(position.total, top + height);
  // At most height - 2 rows, so both end rules always have room.
  const size = Math.max(1, Math.min(height - 2, Math.round((height * height) / end)));
  const range = height - size;
  const maxTop = end - height;
  let from = Math.round((top / maxTop) * range);
  if (top > 0) from = Math.max(from, 1);
  if (top < maxTop) from = Math.min(from, range - 1);
  from = Math.max(0, Math.min(from, range));
  return { from, to: from + size };
}

/** `lines` (one track row each) with the scrollbar cell appended: the thumb inside its range, a blank elsewhere. */
export function withScrollbar(theme: ResolvedTheme, lines: readonly string[], position: ScrollPosition): string[] {
  const thumb = scrollThumb(position, lines.length);
  const on = style(theme, "muted@bg", SCROLL_THUMB);
  const off = style(theme, "text@bg", " ");
  return lines.map((line, i) => line + (thumb !== null && i >= thumb.from && i < thumb.to ? on : off));
}

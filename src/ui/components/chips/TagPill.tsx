// TagPill — single tag rendered as a Primer-IssueLabelToken-style pill.
//
// Pill shape, per-tag background color derived from a hex via the GitHub
// luminance algorithm in styles/tag-pill.css (see .tag-pill). Inline style
// sets --label-r/g/b + --label-h/s/l from the hex; CSS derives perceived-
// lightness, text color (black/white), and border from those. When `color`
// is missing the inline style is empty and the pill falls through to the
// neutral CSS rule.
//
// `interactive` adds hover affordance + cursor when the pill is itself a
// button (TagsPane rows). Default is non-interactive (popover preview).

import type { VNode } from "preact";

import { tagColor, tagPillStyleFromHex } from "../../lib/color.ts";

export interface TagPillProps {
  name: string;
  color?: string | null;
  interactive?: boolean;
}

export function TagPill({ name, color, interactive = false }: TagPillProps): VNode {
  const c = color !== undefined ? color : tagColor(name);
  const style = tagPillStyleFromHex(c);
  const cls = "tag-pill" + (c ? " tag-pill-colored" : "") + (interactive ? " tag-pill-interactive" : "");
  return (
    <span class={cls} style={style}>
      {name}
    </span>
  );
}

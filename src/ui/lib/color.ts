// lib/color.ts — Color parsing + lookup helpers.
//
// `parseHex` / `rgbToHsl` / `tagPillStyleFromHex` mirror the GitHub
// IssueLabelToken algorithm: one hex → readable pill in BOTH themes, no
// per-pill text-color tuning. The CSS-side rules in styles/tag-pill.css
// consume the six custom properties this returns.
//
// `laneColor` and `tagColor` read live from the lanes/tags signals — they
// belong here (not in state/) because they're pure read-helpers, not state
// mutations. Importing from "../state/signals.ts" is acyclic: signals.ts
// does NOT import from this file.

import { lanes, tags } from "../state/signals.ts";

// One hex → pill style. Returns null when input is missing/malformed; callers
// fall through to the neutral .tag-pill background.
export function parseHex(hex: string | null | undefined): { r: number; g: number; b: number } | null {
  if (!hex || typeof hex !== "string" || hex[0] !== "#") return null;
  let h = hex.slice(1);
  // Accept #rgb shorthand by doubling each nibble (#abc → #aabbcc).
  if (h.length === 3)
    h = h
      .split("")
      .map(c => c + c)
      .join("");
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some(n => Number.isNaN(n))) return null;
  return { r, g, b };
}

// Standard RGB → HSL conversion (W3C / colorjs). Inputs in 0-255, outputs
// h: 0-360, s: 0-100, l: 0-100 — matching Primer's expected variable units.
export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max === min) {
    h = 0;
    s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

// Build the inline style object a TagPill applies when a color is present.
// Returns {} when hex is null/invalid so the pill cleanly falls through to
// the neutral CSS rule. The CSS-side rules in styles/tag-pill.css consume
// these six custom properties and derive perceived-lightness / text-color /
// border.
export function tagPillStyleFromHex(hex: string | null | undefined): Record<string, string> {
  const rgb = parseHex(hex);
  if (!rgb) return {};
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  return {
    "--label-r": String(rgb.r),
    "--label-g": String(rgb.g),
    "--label-b": String(rgb.b),
    "--label-h": String(hsl.h),
    "--label-s": String(hsl.s),
    "--label-l": String(hsl.l),
  };
}

// Lookup a lane's color (or null). Used by lane chip + color dot in lists.
export const laneColor = (name: string): string | null => lanes.value.find(l => l.name === name)?.color || null;

// Lookup a tag's color (or null). Used by TagPill in the active-task popover
// and TagsPane rows. Returns null when the tag has no color OR is not yet
// present in the rollup (e.g. just-created via SSE round-trip) — the pill
// falls back to the neutral .tag-pill background defined in styles/tag-pill.css.
export const tagColor = (name: string): string | null => tags.value.find(t => t.name === name)?.color || null;

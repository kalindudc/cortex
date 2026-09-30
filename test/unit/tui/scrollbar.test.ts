import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../../../src/tui/config.ts";
import { SCROLL_THUMB, scrollThumb, withScrollbar } from "../../../src/tui/scrollbar.ts";
import { resolveTheme } from "../../../src/tui/theme.ts";

// Plan @424 (Part A): the document body's scrollbar is a thumb only (no track
// glyph) in the pane's right-most column. Its length is the share of the body
// on screen; it leaves the first row clear while there is text above and the
// last row clear while there is text below, for any document length.

const plainTheme = resolveTheme({ config: DEFAULT_CONFIG, env: { NO_COLOR: "1" } });
const SGR = /\x1b\[[0-9;]*m/g;
const strip = (line: string): string => line.replace(SGR, "");

describe("the document scrollbar: thumb geometry and paint", () => {
  test("no thumb when the body fits (or there is no track)", () => {
    expect(scrollThumb({ top: 0, total: 10 }, 10)).toBeNull();
    expect(scrollThumb({ top: 0, total: 5 }, 10)).toBeNull();
    expect(scrollThumb({ top: 0, total: 100 }, 0)).toBeNull();
    expect(scrollThumb({ top: 4, total: 100 }, 0)).toBeNull();
  });

  test("exact thumbs: the length is the share on screen; the ends are clear while there is more", () => {
    expect(scrollThumb({ top: 0, total: 100 }, 10)).toEqual({ from: 0, to: 1 });
    expect(scrollThumb({ top: 1, total: 100 }, 10)?.from).toBe(1);
    expect(scrollThumb({ top: 89, total: 100 }, 10)?.to).toBe(9);
    expect(scrollThumb({ top: 90, total: 100 }, 10)).toEqual({ from: 9, to: 10 });
    expect(scrollThumb({ top: 5, total: 20 }, 10)).toEqual({ from: 3, to: 8 });
  });

  test("past the natural end (the reader's last heading on top): the thumb reaches the last row, the first stays clear", () => {
    const pastEnd = scrollThumb({ top: 8, total: 12 }, 10);
    expect(pastEnd?.to).toBe(10);
    expect(pastEnd?.from ?? 0).toBeGreaterThanOrEqual(1);
    const short = scrollThumb({ top: 3, total: 5 }, 10);
    expect(short).not.toBeNull();
    expect(short?.from ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("a sweep over heights and lengths: bounds, the end rules and a monotonic thumb", () => {
    let violations = 0;
    for (let height = 3; height <= 40; height++) {
      for (let total = height + 1; total <= 300; total++) {
        const maxTop = total - height;
        let previous = -1;
        for (let top = 0; top <= maxTop; top++) {
          const thumb = scrollThumb({ top, total }, height);
          if (thumb === null) {
            violations++;
            continue;
          }
          const { from, to } = thumb;
          if (from < 0 || from >= to || to > height) violations++;
          if (top > 0 && from < 1) violations++;
          if (top < maxTop && to > height - 1) violations++;
          if (top === 0 && from !== 0) violations++;
          if (top === maxTop && to !== height) violations++;
          if (from < previous) violations++;
          previous = from;
        }
      }
    }
    expect(violations).toBe(0);
  });

  test("withScrollbar appends one cell to every row: the thumb inside its range, a blank elsewhere", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `row ${i}`.padEnd(12));
    const out = withScrollbar(plainTheme, lines, { top: 5, total: 20 });
    expect(out.length).toBe(lines.length);
    for (const [i, line] of out.entries()) {
      expect(visibleWidth(line)).toBe(visibleWidth(lines[i] ?? "") + 1);
      expect(strip(line).endsWith(i >= 3 && i < 8 ? SCROLL_THUMB : " ")).toBe(true);
    }
    const fits = withScrollbar(plainTheme, lines, { top: 0, total: 4 });
    expect(fits.length).toBe(lines.length);
    for (const [i, line] of fits.entries()) {
      expect(visibleWidth(line)).toBe(visibleWidth(lines[i] ?? "") + 1);
      expect(strip(line).endsWith(" ")).toBe(true);
      expect(line.includes(SCROLL_THUMB)).toBe(false);
    }
  });
});

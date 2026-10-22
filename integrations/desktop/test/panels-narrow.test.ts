// The full panels on a narrow window: in each of Settings, Lanes, Tags,
// Backup and Agent tools, every control (the Lanes and Tags colour swatches
// included) owns a target at least 44px square, and neither the page nor
// the panel's sheet scrolls sideways, also after each control scrolls into
// view.

import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setViewportWidth } from "./chrome.ts";
import { type DesktopApp, launchDesktop, waitForDashboard } from "./harness.ts";
import { waitForLive } from "./live.ts";

let desktop: DesktopApp;

beforeEach(async () => {
  desktop = await launchDesktop();
  await waitForDashboard(desktop.page);
  await waitForLive(desktop.page);
});

afterEach(async () => {
  await desktop?.close();
});

const WIDTHS = [900, 390, 320];

const PANELS = [
  { rail: "Settings", panel: ".settings-panel", ready: ".settings-panel #setting-appearance" },
  { rail: "Lanes", panel: ".lane-panel", ready: ".lane-panel .color-swatch" },
  { rail: "Tags", panel: ".tag-panel", ready: ".tag-panel .color-swatch" },
  { rail: "Backup", panel: ".backup-panel", ready: ".backup-panel #setting-backup" },
  { rail: "Agent tools", panel: ".agents-panel", ready: ".agents-panel [data-agent-tool]" },
] as const;

type Measured = { controls: number; swatches: number[]; small: string[]; overflow: string[] };

/**
 * Scroll each control of `panel` into view and probe its target: the
 * centre, edges and corners of a box of at least 44px around its centre
 * must hit the control itself. Returns the controls that fail, the drawn swatch widths, and any
 * sideways overflow or scroll of the page, the panel or its sheet.
 */
function measure(page: Page, panel: string): Promise<Measured> {
  return page.evaluate(selector => {
    const view = document.querySelector<HTMLElement>(selector);
    const body = view?.querySelector<HTMLElement>(".panel-sheet > .panel-body");
    if (!view || !body) throw new Error(`no sheet in ${selector}`);
    const out: Measured = { controls: 0, swatches: [], small: [], overflow: [] };
    const sideways = (when: string): void => {
      const root = document.documentElement;
      if (root.scrollWidth > window.innerWidth) out.overflow.push(`${when}: page ${root.scrollWidth}`);
      if (body.scrollWidth > body.clientWidth) out.overflow.push(`${when}: sheet ${body.scrollWidth}/${body.clientWidth}`);
      for (const el of [root, view, body]) {
        if (el.scrollLeft !== 0) out.overflow.push(`${when}: ${el.className || el.tagName} scrollLeft ${el.scrollLeft}`);
      }
    };
    sideways("at rest");
    const controls = view.querySelectorAll<HTMLElement>('button, select, input:not([type="radio"]), .seg-option');
    for (const el of Array.from(controls)) {
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      out.controls++;
      const name = `${el.tagName.toLowerCase()}.${el.className} "${el.getAttribute("aria-label") ?? el.textContent?.trim() ?? ""}"`;
      if (el.classList.contains("color-swatch")) out.swatches.push(Math.round(r.width));
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const dx = Math.max(r.width, 44) / 2;
      const dy = Math.max(r.height, 44) / 2;
      // Edge midpoints 1px inside the box; corners 3px inside, since a
      // rounded corner takes no clicks.
      const points = [-1, 0, 1].flatMap(i =>
        [-1, 0, 1].map(j => {
          const inset = i !== 0 && j !== 0 ? 3 : 1;
          return [x + i * (dx - inset), y + j * (dy - inset)] as const;
        }),
      );
      const own = points.every(([px, py]) => {
        const hit = document.elementFromPoint(px, py);
        return hit !== null && (hit === el || el.contains(hit));
      });
      if (!own) out.small.push(`${name} ${Math.round(r.width)}x${Math.round(r.height)}`);
      sideways(`after ${name}`);
    }
    return out;
  }, panel);
}

describe("full panels on a narrow window", () => {
  test("every control owns a 44 px target, swatches keep their drawn size, and no sheet scrolls sideways", async () => {
    const { page } = desktop;
    await desktop.cortex(["tag", "add", "release", "--color", "#16a34a"]);
    for (const { rail, panel, ready } of PANELS) {
      await setViewportWidth(page, 1280);
      await page.locator(`.nav-rail button[aria-label="${rail}"]`).click();
      await page.locator(ready).first().waitFor();
      for (const width of WIDTHS) {
        await setViewportWidth(page, width);
        const m = await measure(page, panel);
        expect(m.controls, `${rail} at ${width}px: controls`).toBeGreaterThan(0);
        expect(m.small, `${rail} at ${width}px: targets under 44px`).toEqual([]);
        expect(m.overflow, `${rail} at ${width}px: sideways scroll`).toEqual([]);
        if (rail === "Lanes" || rail === "Tags") {
          expect(m.swatches, `${rail} at ${width}px: swatches`).toEqual(Array(16).fill(32));
        }
      }
    }
  });
});

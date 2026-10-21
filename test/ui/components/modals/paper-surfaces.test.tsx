// The floating surfaces on paper, read from the real stylesheet: dialogs are
// sheets (DialogFrame paints the paper, so their own boxes paint nothing),
// and popovers, menus, pickers and tooltips are small straight-edged cards.
// The uneven edge, the backdrop and the geometry need a real browser; this
// file pins the declared fonts, sizes and surfaces.

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { render } from "@testing-library/preact";
import { DialogFrame } from "../../../../src/ui/components/modals/DialogFrame.tsx";
import { mountStyles, rootToken } from "./styles.ts";

type Viewport = { setViewport(size: { width: number; height: number }): void };
const happyDOM = (globalThis as unknown as { happyDOM: Viewport }).happyDOM;
const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 900, height: 800 };

const style = (el: Element | null): CSSStyleDeclaration => {
  if (!el) throw new Error("expected an element");
  return getComputedStyle(el);
};
/** The first family of a font-family list, without quotes. */
const family = (list: string): string => (list.split(",")[0] ?? "").replace(/["']/g, "").trim();
/** True when the box declares no fill, outline or shadow of its own. */
const paintsNothing = (s: CSSStyleDeclaration): boolean =>
  ["", "transparent", "none", "initial"].includes(s.backgroundColor) &&
  ["", "0px", "initial"].includes(s.borderTopWidth) &&
  ["", "none", "initial"].includes(s.boxShadow);

let unmountStyles: () => void;
beforeAll(() => {
  happyDOM.setViewport(WIDE);
  unmountStyles = mountStyles();
});
afterAll(() => unmountStyles());
afterEach(() => {
  happyDOM.setViewport(WIDE);
  document.body.innerHTML = "";
});

describe("dialogs are sheets", () => {
  test("the modal box paints nothing, so DialogFrame's paper is its surface", () => {
    const { container } = render(
      <DialogFrame label="Delete task" onClose={() => {}}>
        <div class="modal">
          <h2>Delete task?</h2>
        </div>
      </DialogFrame>,
    );
    expect(paintsNothing(style(container.querySelector(".modal")))).toBe(true);
    expect(paintsNothing(style(container.querySelector(".dialog-paper")))).toBe(true);
    expect(container.querySelector(".dialog-paper > .paper-layer")).not.toBeNull();
  });

  test("a dialog title is the serif at 20px, weight 600", () => {
    const { container } = render(
      <DialogFrame label="New lane" onClose={() => {}}>
        <div class="modal modal--narrow">
          <h2>New lane</h2>
          <input />
        </div>
      </DialogFrame>,
    );
    const title = style(container.querySelector("h2"));
    expect(family(title.fontFamily)).toBe(family(rootToken("--font-serif")));
    expect(title.fontSize).toBe("20px");
    expect(title.fontWeight).toBe("600");
    expect(family(style(container.querySelector("input")).fontFamily)).toBe(family(rootToken("--font-sans")));
  });

  test("the side panel sheet is transparent over the paper and keeps its 44px close button at 900px", () => {
    happyDOM.setViewport(NARROW);
    const { container } = render(
      <DialogFrame label="Side panel" className="ctx-sheet dialog-frame--sheet" onClose={() => {}}>
        <div class="ctx-sheet-body">
          <button type="button" class="btn-icon ctx-sheet-close" aria-label="Close the side panel" />
          <aside class="context-panel">
            <div class="ctx-head" />
          </aside>
        </div>
      </DialogFrame>,
    );
    expect(paintsNothing(style(container.querySelector(".ctx-sheet-body")))).toBe(true);
    expect(style(container.querySelector(".context-panel")).backgroundColor).toBe("transparent");
    const close = style(container.querySelector(".ctx-sheet-close"));
    expect([close.width, close.height]).toEqual(["44px", "44px"]);
    expect(style(container.querySelector(".ctx-head")).height).toBe("44px");
  });
});

describe("popovers, menus, pickers and tooltips are straight-edged cards", () => {
  const CARDS = ["#status-menu", ".task-actions-menu", ".lane-picker", ".tag-picker", ".tooltip"];
  const mountCards = (): void => {
    document.body.innerHTML = `
      <main>
        <div class="popover" id="status-menu"><button class="popover-row">Open</button></div>
        <div class="popover task-actions-menu" role="menu"><button class="popover-row">Delete task</button></div>
        <div class="popover picker lane-picker">
          <div class="picker-search"><input type="search" /></div>
          <div class="picker-list"><button class="picker-row"><span>now</span></button></div>
        </div>
        <div class="popover tag-picker">
          <div class="tag-picker-search"><input type="search" /></div>
          <div class="tag-picker-list">
            <button class="tag-picker-row"><span class="tag-pill">bug</span><span class="tag-picker-count meta">3</span></button>
            <button class="tag-picker-row tag-picker-create-row"><span class="tag-picker-create-label">Create</span><span class="tag-pill">new</span></button>
          </div>
        </div>
      </main>
      <div class="tooltip tooltip-visible" role="tooltip">Copy</div>`;
  };

  for (const viewport of [WIDE, NARROW]) {
    test(`a 6px card on the sheet with a rule outline, the pop shadow and no grain (${viewport.width}px)`, () => {
      happyDOM.setViewport(viewport);
      mountCards();
      for (const selector of CARDS) {
        const card = style(document.querySelector(selector));
        expect(card.borderRadius, selector).toBe("6px");
        expect([card.borderTopWidth, card.borderTopStyle], selector).toEqual(["1px", "solid"]);
        expect(card.boxShadow, selector).toBe(rootToken("--shadow-pop"));
        expect(card.backgroundImage, selector).not.toMatch(/url\(|gradient/);
        expect(card.clipPath, selector).not.toMatch(/polygon/);
      }
    });
  }

  test("a tooltip is --text-2 on the sheet, not an inverted chip", () => {
    mountCards();
    const tip = style(document.querySelector(".tooltip"));
    expect(tip.color).toBe(rootToken("--text-2"));
    expect(tip.backgroundColor).toBe(style(document.querySelector(".popover")).backgroundColor);
  });

  test("picker rows set user-written names in the serif; search fields and labels stay sans-serif", () => {
    mountCards();
    const serif = family(rootToken("--font-serif"));
    const sans = family(rootToken("--font-sans"));
    const fontOf = (selector: string): string => family(style(document.querySelector(selector)).fontFamily);
    expect(fontOf(".picker-row")).toBe(serif);
    expect(fontOf(".tag-picker-row .tag-pill")).toBe(serif);
    expect(fontOf(".tag-picker-create-row .tag-pill")).toBe(serif);
    expect(fontOf(".tag-picker-create-label")).toBe(sans);
    expect(fontOf(".picker-search input")).toBe(sans);
    expect(fontOf(".tag-picker-search input")).toBe(sans);
    expect(fontOf(".popover-row")).toBe(sans);
  });
});

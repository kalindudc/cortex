// Reads the side panel's paper look from the real stylesheet (see
// ../modals/styles.ts for what happy-dom can and cannot compute): declared
// fonts, sizes, borders and token values, never geometry.

import { afterAll, beforeAll } from "bun:test";
import { mountStyles, rootToken } from "../modals/styles.ts";

export { rootToken };

/** Mounts the bundled stylesheet for the calling describe block. */
export function withStyles(): void {
  let unmount: () => void = () => {};
  beforeAll(() => {
    unmount = mountStyles();
  });
  afterAll(() => unmount());
}

export const style = (el: Element | null | undefined): CSSStyleDeclaration => {
  if (!el) throw new Error("expected an element");
  return getComputedStyle(el);
};

/** The first family of a font-family list, without quotes. */
export const family = (list: string): string => (list.split(",")[0] ?? "").replace(/["']/g, "").trim();
export const SERIF = (): string => family(rootToken("--font-serif"));
export const SANS = (): string => family(rootToken("--font-sans"));
export const MONO = (): string => family(rootToken("--font-mono"));

const NONE = ["", "none", "initial"];
const ZERO = ["", "0px", "initial"];
const CLEAR = ["", "transparent", "none", "initial"];

/** True when the box declares no fill, border or shadow of its own. */
export const paintsNothing = (s: CSSStyleDeclaration): boolean =>
  CLEAR.includes(s.backgroundColor) && ZERO.includes(s.borderTopWidth) && NONE.includes(s.boxShadow);
export const noFill = (s: CSSStyleDeclaration): boolean => CLEAR.includes(s.backgroundColor);
export const noShadow = (s: CSSStyleDeclaration): boolean => NONE.includes(s.boxShadow);
export const noBorder = (width: string): boolean => ZERO.includes(width);

/** A declared value of the last top-level rule with exactly this selector,
 *  for what happy-dom cannot cascade: it resolves every root token from the
 *  last token block, and never matches `:root[data-...] .descendant`. */
export function declared(selector: string, property: string): string {
  let value = "";
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      const r = rule as CSSStyleRule;
      const v = r.selectorText === selector ? r.style.getPropertyValue(property) : "";
      if (v) value = v.trim();
    }
  }
  if (!value) throw new Error(`no ${property} declared for ${selector}`);
  return value;
}

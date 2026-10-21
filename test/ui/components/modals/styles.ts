// Puts the renderer's real stylesheet into happy-dom: every slice of
// src/ui/styles, in the order scripts/build-css.sh bundles them. happy-dom
// computes selectors, the cascade, custom properties and width media
// queries, but no layout, and it does not pick the theme blocks of
// tokens.css the way Chromium does, so tests read fonts, sizes and declared
// values, never geometry or colors.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");

function slices(): string[] {
  const script = fs.readFileSync(path.join(ROOT, "scripts", "build-css.sh"), "utf8");
  const list = /SLICES=\(([^)]*)\)/.exec(script)?.[1];
  if (!list) throw new Error("scripts/build-css.sh has no SLICES list");
  return list.trim().split(/\s+/);
}

/** Adds the bundled stylesheet to the document and returns a function that removes it. */
export function mountStyles(): () => void {
  const style = document.createElement("style");
  style.textContent = slices()
    .map(name => fs.readFileSync(path.join(ROOT, "src", "ui", "styles", `${name}.css`), "utf8"))
    .join("\n");
  document.head.appendChild(style);
  return () => style.remove();
}

/** The value a custom property resolves to on the root element. */
export function rootToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

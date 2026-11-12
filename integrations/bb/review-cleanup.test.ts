import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test.each(["review.css", "section.css"])("%s scopes every Cortex class rule under its root attribute", name => {
  const css = readFileSync(new URL(`./ui/${name}`, import.meta.url), "utf8");
  for (const line of css.split("\n").filter(line => line.trim().startsWith(".cortex-"))) {
    expect(line, "Cortex class selectors must have a root attribute").toMatch(/^\s*\[data-cortex/);
  }
});

test("strip CSS has no focus selector for nonfocusable segments", () => {
  const css = readFileSync(new URL("./ui/cortex.css", import.meta.url), "utf8");
  expect(css).not.toContain(".cortex-strip-segment:focus-visible");
});

test("draft result icon has no no-op conditional", () => {
  const source = readFileSync(new URL("./ui/drafting.tsx", import.meta.url), "utf8");
  expect(source).not.toContain('noSave ? "Check" : "Check"');
});

// E2E for the read-only RenderMarkdownModal.
//
// Covered (single spec file, four arms):
//   - opens via the book-open icon button in .active-header (left of .status-pill)
//   - opens via the "View task as markdown" command palette entry
//   - the body wrapper scrolls when the rendered content is taller than the cap
//   - mermaid code fences convert to inline SVG (lazy-loaded /mermaid.js chunk)
//   - Esc closes the modal (relies on the global Esc cascade in src/ui/index.tsx)
//
// Mermaid is loaded lazily on first modal open per browser session via
// `await import(new URL("/mermaid.js", document.baseURI).href)`. The
// `out/mermaid.js` chunk is ~3 MB; over localhost the fetch + parse cost
// is well within Playwright's default actionTimeout (5 s), but the
// mermaid.run() round-trip is still async — we use Playwright auto-waiting
// locators (toBeVisible) for the produced <svg>, NOT a fixed sleep.

import { test, expect } from "./fixtures/cortex-server.ts";

async function seedLane(url: string, name: string): Promise<void> {
  const r = await fetch(`${url}/api/lanes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`failed to seed lane ${name}: ${r.status} ${await r.text()}`);
}

async function seedTask(
  url: string,
  lane: string,
  title: string,
  body: string,
): Promise<{ id: number; title: string }> {
  const r = await fetch(`${url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lane, title, body }),
  });
  if (!r.ok) throw new Error(`failed to seed task: ${r.status} ${await r.text()}`);
  return r.json();
}

// A body that exercises every render path the modal will see in practice:
//   - a level-1 heading (asserts .markdown-rendered h1 hookup)
//   - a paragraph
//   - a mermaid fence (asserts .mermaid → SVG conversion)
//   - ~80 filler lines (asserts .update-body scrollHeight > clientHeight)
const RICH_BODY = [
  "# Title heading",
  "",
  "An intro paragraph with some **emphasis** and a `code span`.",
  "",
  "```mermaid",
  "graph LR",
  "  A-->B",
  "  B-->C",
  "```",
  "",
  ...Array.from({ length: 80 }, (_, i) => `Filler line ${i + 1} — pad pad pad pad pad pad pad pad pad pad pad pad.`),
].join("\n");

test("opens via the book-open icon button in active-header", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "render-target", RICH_BODY);
  await page.goto(url);
  await page.locator(".task-row", { hasText: "render-target" }).click();
  await expect(page.locator(".pane-active")).toBeVisible();

  // Button lives in .active-header immediately left of the .status-pill
  // wrapper. Title attribute is the canonical accessor (matches the JSX
  // in ActiveTaskPane.tsx Task 6 diff).
  await page.locator('.active-header button[title="Render markdown"]').click();
  await expect(page.locator(".modal--wide")).toBeVisible();
  // Heading round-trip proves marked.parse + .markdown-rendered class +
  // dangerouslySetInnerHTML wiring all worked end to end.
  await expect(page.locator(".markdown-rendered h1")).toHaveText("Title heading");
});

test("opens via the View task as markdown palette command", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "palette-render-target", RICH_BODY);
  await page.goto(url);
  await page.locator(".task-row", { hasText: "palette-render-target" }).click();
  // .active-header (vs .pane-active) only renders when ActiveTaskPane has
  // an `at` task — gates the palette open on hydration so the view-markdown
  // command (scoped to `if (at)` in buildCommands.ts) is in the list.
  await expect(page.locator(".active-header")).toBeVisible();

  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+KeyP`);
  // Wait for the palette input to mount + focus before driving it. .fill()
  // (vs .type()) replaces the value ATOMICALLY so the test never depends on
  // racing with the Cmd+P handler's auto-"/" prepend (src/ui/index.tsx:182)
  // — we own the final value end-to-end. Leading "/" forces command mode.
  const input = page.locator(".palette-input");
  await expect(input).toBeFocused();
  await input.fill("/View task");
  await page.locator(".palette-row", { hasText: "View task as markdown" }).first().click();
  await expect(page.locator(".modal--wide")).toBeVisible();
  await expect(page.locator(".markdown-rendered h1")).toHaveText("Title heading");
});

test("scroll body engages when content is taller than the modal cap", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "scroll-target", RICH_BODY);
  await page.goto(url);
  await page.locator(".task-row", { hasText: "scroll-target" }).click();
  await page.locator('.active-header button[title="Render markdown"]').click();
  await expect(page.locator(".modal--wide")).toBeVisible();

  // .update-body is the flex:1; min-height:0; overflow:auto wrapper inside
  // .modal--wide that owns scrolling. With 80 filler lines + heading +
  // mermaid SVG, scrollHeight should exceed clientHeight regardless of
  // viewport size (Playwright defaults to 1280x720; modal cap is 656px).
  const wrapper = page.locator(".modal--wide .update-body");
  const dims = await wrapper.evaluate((el: HTMLElement) => ({
    sh: el.scrollHeight,
    ch: el.clientHeight,
  }));
  expect(dims.sh).toBeGreaterThan(dims.ch);
});

test("mermaid code fence renders to an inline SVG", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "mermaid-target", RICH_BODY);
  await page.goto(url);
  await page.locator(".task-row", { hasText: "mermaid-target" }).click();
  await page.locator('.active-header button[title="Render markdown"]').click();
  await expect(page.locator(".modal--wide")).toBeVisible();

  // mermaid.run() is async (lazy-imports /mermaid.js then runs the parser).
  // Auto-wait via toBeVisible covers fetch + parse + render. The selector
  // matches the canonical post-render shape: <pre class="mermaid"> contains
  // an <svg> after mermaid replaces the verbatim source.
  await expect(page.locator(".markdown-rendered pre.mermaid svg")).toBeVisible({ timeout: 15_000 });
});

test("Esc closes the modal", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "esc-target", RICH_BODY);
  await page.goto(url);
  await page.locator(".task-row", { hasText: "esc-target" }).click();
  await page.locator('.active-header button[title="Render markdown"]').click();
  await expect(page.locator(".modal--wide")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".modal--wide")).toHaveCount(0);
});

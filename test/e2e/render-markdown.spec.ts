// E2E for reading a task as rendered Markdown (task 330: reading is IN PLACE).
//
// A task now opens as a readable document — no preview popup. The five arms
// below preserve the behaviors the old RenderMarkdownModal spec certified,
// against the new surface:
//   - selecting a task renders its body in the Document/Read panel
//   - the palette's reading command lands on Document/Read (no modal)
//   - the reader scrolls internally when content is taller than the pane
//     (page chrome never scrolls two axes)
//   - mermaid code fences convert to inline SVG (lazy-loaded /mermaid.js)
//   - Read/Edit/Split switching keeps the same CodeMirror instance
//
// Mermaid is loaded lazily on first render per browser session via
// `await import(new URL("/mermaid.js", document.baseURI).href)`. The
// `out/mermaid.js` chunk is ~3 MB; over localhost the fetch + parse cost
// is well within Playwright's default actionTimeout (5 s), but the render
// round-trip is still async — we use Playwright auto-waiting locators
// (toBeVisible) for the produced <svg>, NOT a fixed sleep.

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

// A body that exercises every render path the reader will see in practice:
//   - a level-1 heading (asserts .markdown-view h1 hookup + outline)
//   - a paragraph
//   - a mermaid fence (asserts .mermaid → SVG conversion)
//   - ~80 filler lines (asserts .doc-reader scrollHeight > clientHeight)
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
  "## Second section",
  "",
  ...Array.from({ length: 80 }, (_, i) => `Filler line ${i + 1} — pad pad pad pad pad pad pad pad pad pad pad pad.`),
].join("\n");

test("selecting a task renders its body IN PLACE (Document/Read) — no modal", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "render-target", RICH_BODY);
  await page.goto(url);
  await page.locator(".task-row", { hasText: "render-target" }).click();
  await expect(page.locator(".pane-active")).toBeVisible();

  // Default entry state is Document/Read: rendered prose, no editor, no dialog.
  await expect(page.getByRole("tab", { name: "Document" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".doc-mode-switch button", { hasText: "Read" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".doc-reader .markdown-view h1")).toHaveText("Title heading");
  await expect(page.locator(".md-editor")).toHaveCount(0);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  // The outline rail (rendered for 2+ headings) lists the headings — W1:
  // heading navigation only, never lane/tag filtering.
  await expect(page.locator(".doc-outline .doc-outline-link", { hasText: "Title heading" })).toBeVisible();
  await expect(page.locator(".doc-outline .doc-outline-link", { hasText: "Second section" })).toBeVisible();
  await expect(page.locator(".doc-outline select, .doc-outline .lane-row, .doc-outline .tag-pill")).toHaveCount(0);
});

test("the palette reading command lands on Document/Read (the old 'View task as markdown' destination)", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "palette-render-target", RICH_BODY);
  await page.goto(url);
  await page.locator(".task-row", { hasText: "palette-render-target" }).click();
  await expect(page.locator(".task-header")).toBeVisible();
  // Leave Read first so the command has something to change.
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");

  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+KeyP`);
  const input = page.locator(".palette-input");
  await expect(input).toBeFocused();
  // The palette itself is a named native dialog (V3).
  await expect(page.locator('dialog[aria-label="Command palette"][open]')).toHaveCount(1);
  await input.fill("/Read document");
  await page.locator(".palette-row", { hasText: "Read document" }).first().click();
  await expect(page.getByRole("tab", { name: "Document" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".doc-reader .markdown-view h1")).toHaveText("Title heading");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});

test("the reader scrolls internally when content is taller than the pane (no page-level scroll)", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "scroll-target", RICH_BODY);
  await page.goto(url);
  await page.locator(".task-row", { hasText: "scroll-target" }).click();
  await expect(page.locator(".doc-reader .markdown-view h1")).toHaveText("Title heading");

  // .doc-reader owns vertical overflow. With 80 filler lines + heading +
  // mermaid SVG, scrollHeight exceeds clientHeight at the default 1280x720.
  const dims = await page.locator(".doc-reader").evaluate((el: HTMLElement) => ({
    sh: el.scrollHeight,
    ch: el.clientHeight,
  }));
  expect(dims.sh).toBeGreaterThan(dims.ch);
  // The document itself never scrolls horizontally (V1).
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(pageOverflow).toBeLessThanOrEqual(0);
});

test("mermaid code fence renders to an inline SVG in the reader", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "mermaid-target", RICH_BODY);
  await page.goto(url);
  await page.locator(".task-row", { hasText: "mermaid-target" }).click();
  await expect(page.locator(".doc-reader .markdown-view")).toBeVisible();

  // The render is async (lazy-imports /mermaid.js then renders). Auto-wait
  // covers fetch + parse + render. Canonical post-render shape: <pre
  // class="mermaid"> contains a sanitized <svg>.
  const svg = page.locator(".doc-reader pre.mermaid svg");
  await expect(svg).toBeVisible({ timeout: 15_000 });
  // The theme really applied (M3): mermaid scopes its embedded <style> by the
  // root id and draws arrowheads through url(#marker) references — if the
  // sanitizer rewrote ids, nodes would fall back to black fills and edges
  // would lose their markers. Guard both.
  const rootId = await svg.getAttribute("id");
  expect(rootId ?? "").toMatch(/^cortex-mermaid-/);
  const nodeFill = await svg
    .locator(".node rect, .node polygon, .node circle")
    .first()
    .evaluate(el => getComputedStyle(el).fill);
  expect(nodeFill).not.toBe("rgb(0, 0, 0)");
  expect(await svg.locator("marker").count()).toBeGreaterThan(0);
  const edgeMarker = await svg
    .locator("path.flowchart-link")
    .first()
    .evaluate(el => getComputedStyle(el).markerEnd);
  expect(edgeMarker).toContain("url(");
});

test("Read → Edit → Split → Read keeps ONE CodeMirror instance and zero writes from reading", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "lifecycle-target", RICH_BODY);
  await page.goto(url);
  const writes: string[] = [];
  page.on("request", req => {
    if (req.url().includes("/api/tasks") && (req.method() === "PATCH" || req.method() === "POST")) {
      writes.push(`${req.method()} ${req.url()}`);
    }
  });
  await page.locator(".task-row", { hasText: "lifecycle-target" }).click();
  await expect(page.locator(".doc-reader .markdown-view h1")).toHaveText("Title heading");

  // Reading, selecting text and switching content tabs produce ZERO task writes.
  await page.locator(".doc-reader .markdown-view p").first().selectText();
  await page.getByRole("tab", { name: "Related" }).click();
  await page.getByRole("tab", { name: "Document" }).click();
  await expect(page.locator(".doc-reader .markdown-view h1")).toHaveText("Title heading");
  expect(writes).toEqual([]);

  // Edit mounts a REAL CodeMirror instance; Split and Read keep it mounted.
  await page.locator(".doc-mode-switch button", { hasText: "Edit" }).click();
  const editor = page.locator(".md-editor .cm-editor");
  await expect(editor).toBeVisible();
  const id = await editor.evaluate(el => {
    (el as HTMLElement).dataset.e2eIdentity = "cm-1";
    return (el as HTMLElement).dataset.e2eIdentity;
  });
  expect(id).toBe("cm-1");
  await page.locator(".doc-mode-switch button", { hasText: "Split" }).click();
  await expect(page.locator(".doc-reader")).toBeVisible();
  await expect(page.locator(".md-editor .cm-editor")).toHaveAttribute("data-e2e-identity", "cm-1");
  await page.locator(".doc-mode-switch button", { hasText: "Read" }).click();
  // Hidden, not unmounted (D4): the same node survives with its identity.
  await expect(page.locator(".md-editor")).toBeHidden();
  await expect(page.locator(".md-editor .cm-editor")).toHaveAttribute("data-e2e-identity", "cm-1");
  expect(writes).toEqual([]); // mode switching never writes
});

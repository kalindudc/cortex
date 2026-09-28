// E2E — rendering safety probes in a REAL browser (task 330, M1–M3).
//
// happy-dom cannot run DOMPurify, so these probes are the certification of
// the sanitized rendering boundary:
//   - raw <script>, inline event handlers, javascript:/data: URLs, <style>,
//     <form>/<button>/<input>, DOM-clobbering ids, raw <svg>/<math> and a
//     Mermaid fence breakout attempt are neutralized — no execution, no
//     unexpected network side effects, no unsanitized HTML insertion
//   - safe GFM/HTML survives: headings, emphasis, tables, task lists
//     (disabled checkboxes only), http(s)/mailto/relative links, literal
//     <>& in source, code copy controls, internal @id refs
//   - Mermaid: strict security (no HTML labels / no directive override),
//     an invalid diagram fails with a visible error + retry and NEVER
//     replaces a newer render; rapid task switches keep the newest result;
//     source-only documents do not load the mermaid chunk
//
// page.waitForTimeout is BANNED — auto-waiting locators only.

import { test, expect } from "./fixtures/cortex-server.ts";
import { HOSTILE } from "./fixtures/markdown-probes.ts";

async function seedLane(url: string, name: string): Promise<void> {
  const r = await fetch(`${url}/api/lanes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`failed to seed lane ${name}: ${r.status} ${await r.text()}`);
}

async function seedTask(url: string, lane: string, title: string, body: string): Promise<{ id: number }> {
  const r = await fetch(`${url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lane, title, body }),
  });
  if (!r.ok) throw new Error(`failed to seed task: ${r.status} ${await r.text()}`);
  return r.json();
}

test("hostile Markdown/HTML renders with NO execution, NO forbidden elements and NO unexpected requests", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "hostile", HOSTILE);
  const external: string[] = [];
  page.on("request", req => {
    const u = new URL(req.url());
    if (u.origin !== new URL(url).origin) external.push(req.url());
  });
  const pageErrors: string[] = [];
  page.on("pageerror", e => pageErrors.push(String(e)));
  await page.goto(url);
  await page.locator(".task-row", { hasText: "hostile" }).click();
  const view = page.locator(".doc-reader .markdown-view");
  await expect(view.locator("h1")).toHaveText("Hostile document");

  // Nothing executed.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
  // Forbidden surfaces are gone from the rendered DOM. The only <button>s
  // allowed are OUR controls: code copy, @id refs and the mermaid retry.
  for (const sel of [
    "script",
    "style",
    "iframe",
    "form",
    "button:not(.md-copy):not(.md-ref):not(.md-mermaid-retry)",
    "svg",
    "math",
    "input:not([type=checkbox])",
  ]) {
    expect(await view.locator(sel).count(), `forbidden element still present: ${sel}`).toBe(0);
  }
  // Inline handlers are stripped.
  expect(await view.locator("[onerror], [onload], [onclick]").count()).toBe(0);
  // Executable URL schemes are rejected; safe schemes survive.
  expect(await view.locator("a#js[href^='javascript'], a[href^='data:']").count()).toBe(0);
  await expect(view.locator("a[href='https://example.com']")).toHaveText("site");
  await expect(view.locator("a[href='/task/1']")).toHaveText("relative link");
  // DOM clobbering: sanitized named props do not shadow window/document APIs.
  expect(await page.evaluate(() => typeof document.body.appendChild === "function")).toBe(true);
  expect(await page.evaluate(() => typeof window.location.href === "string")).toBe(true);
  // Safe GFM survives: table wrapper, task-list checkboxes (disabled only).
  await expect(view.locator(".md-table-wrap table td", { hasText: "1" })).toBeVisible();
  const boxes = view.locator("input[type=checkbox]");
  await expect(boxes).toHaveCount(2);
  for (const box of await boxes.all()) expect(await box.isDisabled()).toBe(true);
  // Literal <>& in source text; code copy present; internal @id ref decorated.
  await expect(view.locator("code", { hasText: "<>&" })).toBeVisible();
  await expect(view.locator(".md-codeblock .md-copy").first()).toBeVisible();
  await expect(view.locator("code", { hasText: "<b>not html</b>" })).toBeVisible();
  await expect(view.locator("button.md-ref[data-ref-kind='task']").first()).toHaveText("@1");
  // The mermaid fence breakout stays INSIDE its pre as recoverable text or a
  // rendered/errored diagram — never as a live script.
  await expect(view.locator("pre.mermaid")).toHaveCount(1);
  expect(await view.locator("pre.mermaid script").count()).toBe(0);
  // No external network side effects and no page errors.
  expect(external).toEqual([]);
  expect(pageErrors).toEqual([]);
  // The page is still visible (the <style> display:none never applied).
  expect(await page.evaluate(() => getComputedStyle(document.body).display)).not.toBe("none");
});

test("Mermaid strict mode: HTML labels are not rendered as markup and directives cannot lower security", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  const body = [
    "# Strict",
    "",
    "```mermaid",
    "%%{init: {'securityLevel': 'loose', 'htmlLabels': true}}%%",
    "graph LR",
    '  A["<img src=x onerror=window.__pwned=1>label"] --> B',
    "```",
  ].join("\n");
  await seedTask(url, "inbox", "strict-mermaid", body);
  await page.goto(url);
  await page.locator(".task-row", { hasText: "strict-mermaid" }).click();
  const pre = page.locator(".doc-reader pre.mermaid");
  // Either a rendered (sanitized) SVG or an explicit error state — never a
  // live <img onerror>.
  await expect(pre).toHaveAttribute("data-mermaid-state", /done|error/, { timeout: 15_000 });
  expect(await pre.locator("img, script, foreignObject").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
});

test("an invalid diagram fails VISIBLY with retry, keeps its source, and a newer render wins across task switches", async ({
  url,
  page,
}) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "broken-diagram", "# Broken\n\n```mermaid\ngraph LR\n  A --> \n  ((( nonsense\n```\n");
  await seedTask(url, "inbox", "good-diagram", "# Good\n\n```mermaid\ngraph LR\n  GoodProbe --> Done\n```\n");
  await page.goto(url);
  await page.locator(".task-row", { hasText: "broken-diagram" }).click();
  const broken = page.locator(".doc-reader pre.mermaid");
  await expect(broken).toHaveAttribute("data-mermaid-state", "error", { timeout: 15_000 });
  // Explicit error view + retry control; the raw source is preserved.
  await expect(page.locator(".doc-reader .md-mermaid-error .md-mermaid-retry")).toBeVisible();
  await expect(broken).toContainText("nonsense");
  // Rapid switch to a valid diagram: the newest render is what shows.
  await page.locator(".task-row", { hasText: "good-diagram" }).click();
  await expect(page.locator(".doc-reader .markdown-view h1")).toHaveText("Good");
  await expect(page.locator(".doc-reader pre.mermaid svg")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".doc-reader pre.mermaid svg")).toContainText("GoodProbe");
  await expect(page.locator(".doc-reader .md-mermaid-error")).toHaveCount(0);
  // Back to the broken one: still an error state (not the good SVG).
  await page.locator(".task-row", { hasText: "broken-diagram" }).click();
  await expect(page.locator(".doc-reader pre.mermaid")).toHaveAttribute("data-mermaid-state", "error", {
    timeout: 15_000,
  });
  expect(await page.locator(".doc-reader pre.mermaid svg", { hasText: "GoodProbe" }).count()).toBe(0);
});

test("source-only documents never load the mermaid chunk", async ({ url, page }) => {
  await seedLane(url, "inbox");
  await seedTask(url, "inbox", "plain-doc", "# Plain\n\nJust prose and a ```js\ncode block\n``` — no diagrams.\n");
  const mermaidRequests: string[] = [];
  page.on("request", req => {
    if (/mermaid/i.test(new URL(req.url()).pathname)) mermaidRequests.push(req.url());
  });
  await page.goto(url);
  await page.locator(".task-row", { hasText: "plain-doc" }).click();
  await expect(page.locator(".doc-reader .markdown-view h1")).toHaveText("Plain");
  // Give the reader a full round-trip (a related fetch) before asserting —
  // this is a negative assertion, so it waits on an unrelated positive one.
  await page.getByRole("tab", { name: "Related" }).click();
  await expect(page.locator(".related-section").first()).toBeVisible();
  expect(mermaidRequests).toEqual([]);
});

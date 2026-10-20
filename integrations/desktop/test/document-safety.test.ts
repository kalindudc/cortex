// Rendering safety in the real window. This file is the certification of the
// sanitized Markdown boundary: it runs the built renderer over cortex:// with
// the production preload and the strict content security policy, where
// DOMPurify really scrubs. happy-dom cannot certify it (its DOMPurify leaves
// scripts and handlers in place), so the test/ui tier only pins the pipeline.
//
//   - hostile Markdown and HTML executes nothing, leaves no forbidden element,
//     handler or executable URL, and sends no request outside cortex:
//   - safe GFM survives, as do http(s), mailto and relative links
//   - Mermaid runs in strict mode, fails visibly with Retry, keeps the newest
//     render across task switches, renders every diagram type of the matrix
//     without a policy violation, and is never loaded for source-only documents

import type { ConsoleMessage, Page, Request } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildBody, CASES, HOSTILE } from "./fixtures/markdown-probes.ts";
import { type DesktopApp, launchDesktop, waitForDashboard } from "./harness.ts";
import { waitForLive, waitForRow } from "./live.ts";

let desktop: DesktopApp;
const requests: string[] = [];
const pageErrors: string[] = [];
const cspViolations: string[] = [];

const VIEW = ".doc-reader .markdown-view";
const MERMAID_TIMEOUT = 20_000;

async function addTask(title: string, body: string): Promise<number> {
  const task = JSON.parse(await desktop.cortex(["add", title, `--body=${body}`, "--json"])) as { id: number };
  return task.id;
}

/** Open a task by its address, the way a reload or a deep link does. */
async function openTask(page: Page, id: number, heading: string): Promise<void> {
  await page.goto(`cortex://app/task/${id}`);
  await waitForDashboard(page);
  await page.locator(`${VIEW} h1`, { hasText: heading }).waitFor();
}

async function openRow(page: Page, title: string, heading: string): Promise<void> {
  await waitForRow(page, title);
  await page.locator(".task-row", { hasText: title }).click();
  await page.locator(`${VIEW} h1`, { hasText: heading }).waitFor();
}

const pwned = (page: Page): Promise<unknown> =>
  page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned);

beforeAll(async () => {
  desktop = await launchDesktop();
  const { page } = desktop;
  page.on("request", (req: Request) => requests.push(req.url()));
  page.on("pageerror", err => pageErrors.push(String(err)));
  page.on("console", (msg: ConsoleMessage) => {
    if (/Content Security Policy|Refused to/i.test(msg.text())) cspViolations.push(msg.text());
  });
  await waitForDashboard(page);
  await waitForLive(page);
});

afterAll(async () => {
  await desktop?.close();
});

describe("document safety", () => {
  test("hostile Markdown renders with no execution, no forbidden element and no outgoing request", async () => {
    const { page } = desktop;
    const id = await addTask("hostile", HOSTILE);
    requests.length = 0;
    pageErrors.length = 0;
    await openTask(page, id, "Hostile document");
    const view = page.locator(VIEW);
    await view.locator("pre.mermaid").waitFor();

    expect(await pwned(page)).toBeUndefined();
    // The only buttons left are the reader's own: code copy, @id refs and the mermaid retry.
    for (const sel of [
      "script",
      "style",
      "iframe",
      "form",
      "button:not(.md-copy):not(.md-ref):not(.md-mermaid-retry)",
      "math",
      "input:not([type=checkbox])",
    ]) {
      expect(await view.locator(sel).count(), `forbidden element still present: ${sel}`).toBe(0);
    }
    // Raw <svg> is gone; only a rendered (sanitized) diagram may hold one.
    expect(await view.locator("svg:not(pre.mermaid svg)").count()).toBe(0);
    expect(await view.locator("[onerror], [onload], [onclick]").count()).toBe(0);
    expect(await view.locator("a[href^='javascript'], a[href^='data:']").count()).toBe(0);
    expect(await view.locator("h1").textContent()).toBe("Hostile document");
    expect(await view.locator("a[href='https://example.com']").textContent()).toBe("site");
    expect(await view.locator("a[href='/task/1']").textContent()).toBe("relative link");
    expect(await view.locator("a[href^='mailto:']").count()).toBe(1);
    // DOM clobbering ids and names do not shadow window or document APIs.
    expect(await page.evaluate(() => typeof document.body.appendChild)).toBe("function");
    expect(await page.evaluate(() => typeof window.location.href)).toBe("string");
    // Safe GFM survives: the table, disabled task-list boxes, literal <>& and code.
    expect(await view.locator(".md-table-wrap table td", { hasText: "1" }).count()).toBe(1);
    const boxes = view.locator("input[type=checkbox]");
    expect(await boxes.count()).toBe(2);
    for (const box of await boxes.all()) expect(await box.isDisabled()).toBe(true);
    expect(await view.locator("code", { hasText: "<>&" }).count()).toBe(1);
    expect(await view.locator("code", { hasText: "<b>not html</b>" }).count()).toBe(1);
    expect(await view.locator("button.md-ref[data-ref-kind='task']").first().textContent()).toBe("@1");
    // The fence breakout stays inside its pre, as text or a sanitized diagram.
    expect(await view.locator("pre.mermaid").count()).toBe(1);
    expect(await view.locator("pre.mermaid script").count()).toBe(0);
    await page.waitForFunction(
      () => document.querySelector("pre.mermaid")?.getAttribute("data-mermaid-state") != null,
      null,
      { timeout: MERMAID_TIMEOUT },
    );
    expect(await pwned(page)).toBeUndefined();
    expect(requests.filter(url => !url.startsWith("cortex:"))).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(await page.evaluate(() => getComputedStyle(document.body).display)).not.toBe("none");
  });

  test("Mermaid strict mode: HTML labels stay text and a directive cannot lower securityLevel", async () => {
    const { page } = desktop;
    const body = [
      "# Strict",
      "",
      "```mermaid",
      "%%{init: {'securityLevel': 'loose', 'htmlLabels': true}}%%",
      "graph LR",
      '  A["<img src=x onerror=window.__pwned=1>label"] --> B',
      "```",
    ].join("\n");
    const id = await addTask("strict-mermaid", body);
    await openTask(page, id, "Strict");
    const pre = page.locator(`${VIEW} pre.mermaid`);
    await page.waitForFunction(
      () => /^(done|error)$/.test(document.querySelector(".doc-reader pre.mermaid")?.getAttribute("data-mermaid-state") ?? ""),
      null,
      { timeout: MERMAID_TIMEOUT },
    );
    expect(await pre.locator("img, script, foreignObject").count()).toBe(0);
    expect(await pwned(page)).toBeUndefined();
  });

  test("an invalid diagram fails visibly with Retry, keeps its source, and the newest render wins", async () => {
    const { page } = desktop;
    await addTask("broken-diagram", "# Broken\n\n```mermaid\ngraph LR\n  A --> \n  ((( nonsense\n```\n");
    await addTask("good-diagram", "# Good\n\n```mermaid\ngraph LR\n  GoodProbe --> Done\n```\n");
    const state = (): Promise<string | null> =>
      page.evaluate(() => document.querySelector(".doc-reader pre.mermaid")?.getAttribute("data-mermaid-state") ?? null);

    await openRow(page, "broken-diagram", "Broken");
    await expect.poll(state, { timeout: MERMAID_TIMEOUT }).toBe("error");
    await page.locator(".doc-reader .md-mermaid-error .md-mermaid-retry").waitFor();
    expect(await page.locator(`${VIEW} pre.mermaid`).textContent()).toContain("nonsense");

    await openRow(page, "good-diagram", "Good");
    await page.locator(`${VIEW} pre.mermaid svg`).waitFor({ timeout: MERMAID_TIMEOUT });
    expect(await page.locator(`${VIEW} pre.mermaid svg`).textContent()).toContain("GoodProbe");
    expect(await page.locator(".doc-reader .md-mermaid-error").count()).toBe(0);

    await openRow(page, "broken-diagram", "Broken");
    await expect.poll(state, { timeout: MERMAID_TIMEOUT }).toBe("error");
    expect(await page.locator(".doc-reader pre.mermaid svg", { hasText: "GoodProbe" }).count()).toBe(0);
  });

  test("every diagram type of the matrix renders a real SVG with no policy violation", async () => {
    const { page } = desktop;
    const id = await addTask("mermaid-matrix", buildBody());
    cspViolations.length = 0;
    requests.length = 0;
    await openTask(page, id, "Mermaid diagram type matrix");
    await expect
      .poll(() => page.locator(`${VIEW} pre.mermaid svg`).count(), { timeout: MERMAID_TIMEOUT })
      .toBe(CASES.length);
    const blocks = page.locator(`${VIEW} pre.mermaid`);
    for (let i = 0; i < CASES.length; i++) {
      const c = CASES[i];
      const text = (await blocks.nth(i).locator("svg").textContent()) ?? "";
      // Mermaid's error picture says "Syntax error in text"; a missing renderer chunk shows it.
      expect(text, `${c.type}: rendered the error picture`).not.toContain("Syntax error");
      expect(text, `${c.type}: the SVG lacks its label`).toContain(c.probe);
    }
    expect(requests.some(url => url.startsWith("cortex://app/mermaid/chunks/")), "nested chunks loaded").toBe(true);
    expect(cspViolations).toEqual([]);
  });

  test("a source-only document never requests the mermaid runtime", async () => {
    const { page } = desktop;
    const id = await addTask("plain-doc", "# Plain\n\nJust prose and a\n\n```js\ncode block\n```\n\nno diagrams.\n");
    // A fresh document: the earlier tests already loaded the runtime into this one.
    requests.length = 0;
    await openTask(page, id, "Plain");
    await page.locator(`${VIEW} .md-codeblock`).waitFor();
    // A negative check: wait for an unrelated round trip through the daemon first.
    await page.evaluate(() => window.cortex.request({ method: "GET", path: "/api/workspace" }));
    expect(requests.some(url => url.endsWith("/bundle.js")), "the request recorder saw the page load").toBe(true);
    expect(requests.filter(url => new URL(url).pathname.includes("/mermaid/"))).toEqual([]);
  });
});

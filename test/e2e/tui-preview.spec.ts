// E2E — the terminal's explicit rich draft preview in REAL Chromium (plan
// @400 Task 10 B: P6, N21, G5).
//
// `:preview` (src/tui/bridge.ts) holds the task's EXACT current text on the
// daemon over its private IPC socket (POST /api/control/preview, bound to
// the verified instance) and opens `/preview/<token>` on the loopback
// dashboard. These tests create previews the SAME way (a small node:http
// helper over the daemon's Unix socket, never the real TUI) and certify:
//   - the exact unsaved source renders, nothing is written to the task and
//     the workspace never boots on the preview page;
//   - expiry, unknown tokens and the size limits are explicit errors;
//   - hostile content stays inert through the existing sanitizer boundary,
//     and an unsupported sanitizer fails CLOSED to the exact source;
//   - the tested Mermaid diagram types render (and an invalid one fails
//     visibly with its source) through the existing MarkdownView path;
//   - the page has its own layout (centered up to its max width on a
//     desktop, a long document scrolls to its last line) and a visit
//     stores no preference, not even the theme it applies.
//
// page.waitForTimeout is BANNED — auto-waiting locators and expect.poll only.

import fs from "node:fs";
import http from "node:http";
import { expect, test } from "./fixtures/cortex-server.ts";
import { buildBody, CASES, HOSTILE } from "./fixtures/markdown-probes.ts";

const MiB = 1024 * 1024;

interface PreviewAnswer {
  status: number;
  json: { token?: string; path?: string; error?: string; code?: string; limit?: number };
}

async function seedTask(url: string, title: string, body: string): Promise<{ id: number }> {
  const lane = await fetch(`${url}/api/lanes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "inbox" }),
  });
  if (!lane.ok && lane.status !== 409) throw new Error(`failed to seed the lane: ${lane.status} ${await lane.text()}`);
  const r = await fetch(`${url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lane: "inbox", title, body }),
  });
  if (!r.ok) throw new Error(`failed to seed task: ${r.status} ${await r.text()}`);
  return r.json();
}

/** The daemon's published metadata (`<db>.daemon.json`): its instance and private socket. */
async function daemonMetadata(env: Record<string, string>): Promise<{ instanceId: string; socketPath: string }> {
  const file = `${env.CORTEX_DB}.daemon.json`;
  // /api/health answers just before the metadata is published.
  await expect.poll(() => fs.existsSync(file), { timeout: 10_000 }).toBe(true);
  const meta = JSON.parse(fs.readFileSync(file, "utf8")) as {
    instanceId: string;
    endpoint: { kind: string; socketPath: string };
  };
  expect(meta.endpoint.kind).toBe("unix");
  return { instanceId: meta.instanceId, socketPath: meta.endpoint.socketPath };
}

/** POST the IPC-only preview control route over the daemon's Unix socket, as the TUI bridge does. */
async function createPreviewOverIpc(
  env: Record<string, string>,
  request: Record<string, unknown>,
): Promise<PreviewAnswer> {
  const { instanceId, socketPath } = await daemonMetadata(env);
  const body = JSON.stringify(request);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: "/api/control/preview",
        method: "POST",
        headers: {
          "Cortex-Instance": instanceId,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as PreviewAnswer["json"] });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function createdToken(env: Record<string, string>, request: Record<string, unknown>): Promise<string> {
  const answer = await createPreviewOverIpc(env, request);
  expect(answer.status, JSON.stringify(answer.json)).toBe(201);
  expect(answer.json.token).toMatch(/^[0-9a-f]{32}$/);
  return answer.json.token as string;
}

test("the EXACT unsaved draft renders; nothing is written and the workspace never boots", async ({
  cortexDaemon,
  url,
  page,
}) => {
  const task = await seedTask(url, "Saved title", "SAVED-BODY-PROBE: not what the preview shows");
  const state = async (): Promise<unknown> => (await fetch(`${url}/api/tasks/${task.id}/state`)).json();
  const before = await state();
  const source = [
    "# Unsaved draft heading",
    "",
    `Typed in the terminal, never saved: UNSAVED-PROBE-7. See @${task.id}.`,
    "",
    "| k | v |",
    "| - | - |",
    "| a | 1 |",
    "",
    "```js",
    "\tconsole.log('<b>tab and tag</b>')\r",
    "```",
    "",
    "A CRLF line\r",
    "",
  ].join("\n");
  const token = await createdToken(cortexDaemon.env, {
    taskId: task.id,
    title: "Unsaved <i>title</i>",
    source,
    unsaved: true,
  });

  const requests: string[] = [];
  page.on("request", req => requests.push(`${req.method()} ${new URL(req.url()).pathname}`));
  await page.goto(`${url}/preview/${token}`);
  const view = page.locator(".preview-document .markdown-view");
  await expect(view.locator("h1")).toHaveText("Unsaved draft heading");
  await expect(view).toContainText("UNSAVED-PROBE-7");
  await expect(view.locator(".md-table-wrap table td", { hasText: "1" })).toBeVisible();
  await expect(view.locator("code", { hasText: "<b>tab and tag</b>" })).toBeVisible();
  // Identity: the task id and the draft title as TEXT, marked unsaved and read-only.
  const title = page.locator(".preview-title");
  await expect(title).toContainText(`@${task.id}`);
  await expect(title).toContainText("Unsaved <i>title</i>");
  expect(await title.locator("i").count()).toBe(0);
  await expect(page.locator(".preview-kicker")).toContainText("Unsaved draft");
  await expect(page.locator(".preview-kicker")).toContainText("read-only");

  // The exact source, character for character (tabs and CRs included).
  await page.getByRole("button", { name: "Show source" }).click();
  expect(await page.locator("pre.preview-source").evaluate(el => el.textContent)).toBe(source);
  await page.getByRole("button", { name: "Show rendered" }).click();
  await expect(view.locator("h1")).toHaveText("Unsaved draft heading");

  // Zero task writes: state, versions, updates and the event cursor are unchanged.
  expect(await state()).toEqual(before);
  expect(requests.filter(r => !r.startsWith("GET "))).toEqual([]);
  // The workspace never booted: no live stream, no snapshot, no history rewrite.
  expect(requests.filter(r => /\/events|\/api\/(workspace|me|migrations|tasks)/.test(r))).toEqual([]);
  expect(new URL(page.url()).pathname).toBe(`/preview/${token}`);

  // A task reference leaves for the dashboard deep link, which shows the SAVED text.
  await view.locator("button.md-ref[data-ref-kind='task']").click();
  await expect(page).toHaveURL(new RegExp(`/task/${task.id}$`));
  await expect(page.locator(".doc-reader .markdown-view")).toContainText("SAVED-BODY-PROBE");
  expect(await state()).toEqual(before);
});

test("expiry, unknown tokens and the size limits are explicit errors", async ({ cortexDaemon, url, page }) => {
  const env = cortexDaemon.env;
  const task = await seedTask(url, "limits", "saved");

  await page.goto(`${url}/preview/${"0".repeat(32)}`);
  await expect(page.getByRole("alert").locator("h1")).toHaveText("Preview not found");

  // Read after it expired: an explicit expiry, not a blank page.
  const soon = await createdToken(env, { taskId: task.id, title: "t", source: "# Soon gone", ttlMs: 1000 });
  await expect.poll(async () => (await fetch(`${url}/api/preview/${soon}`)).status, { timeout: 10_000 }).toBe(410);
  await page.goto(`${url}/preview/${soon}`);
  const alert = page.getByRole("alert");
  await expect(alert.locator("h1")).toHaveText("This preview has expired");
  await expect(alert).toContainText("expired at");
  await expect(alert).toContainText(":preview");
  expect(await page.locator(".markdown-view").count()).toBe(0);

  // An open page says when its preview expires, and keeps what it showed.
  const open = await createdToken(env, { taskId: task.id, title: "t", source: "# Still shown", ttlMs: 4000 });
  await page.goto(`${url}/preview/${open}`);
  await expect(page.locator(".preview-document .markdown-view h1")).toHaveText("Still shown");
  await expect(page.locator(".preview-expired")).toContainText("expired", { timeout: 15_000 });
  await expect(page.locator(".preview-document .markdown-view h1")).toHaveText("Still shown");

  // One preview holds at most 1 MiB (title and source): nothing is created.
  const big = await createPreviewOverIpc(env, { taskId: task.id, title: "", source: "a".repeat(MiB + 1) });
  expect(big.status).toBe(413);
  expect(big.json).toMatchObject({ code: "preview_too_large", limit: MiB });
  expect(big.json.error).toContain("1 MiB");
  // All live previews hold at most 8 MiB together (the two above are expired and freed).
  for (let i = 0; i < 8; i++) await createdToken(env, { taskId: task.id, title: "", source: "b".repeat(MiB) });
  const full = await createPreviewOverIpc(env, { taskId: task.id, title: "", source: "c" });
  expect(full.status).toBe(507);
  expect(full.json).toMatchObject({ code: "preview_storage_full", limit: 8 * MiB });
  expect(full.json.error).toContain("8 MiB");
});

test("hostile content stays inert through the existing sanitizer boundary", async ({ cortexDaemon, url, page }) => {
  const task = await seedTask(url, "hostile", "saved");
  const token = await createdToken(cortexDaemon.env, {
    taskId: task.id,
    title: "<img src=x onerror=\"window.__pwned='title'\"> title",
    source: HOSTILE,
    unsaved: true,
  });
  const external: string[] = [];
  page.on("request", req => {
    if (new URL(req.url()).origin !== new URL(url).origin) external.push(req.url());
  });
  const pageErrors: string[] = [];
  page.on("pageerror", e => pageErrors.push(String(e)));
  await page.goto(`${url}/preview/${token}`);
  const view = page.locator(".preview-document .markdown-view");
  await expect(view.locator("h1")).toHaveText("Hostile document");

  expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
  for (const sel of [
    "script",
    "style",
    "iframe",
    "form",
    "button:not(.md-copy):not(.md-ref):not(.md-mermaid-retry)",
    "svg:not(pre.mermaid svg)",
    "math",
    "input:not([type=checkbox])",
  ]) {
    expect(await view.locator(sel).count(), `forbidden element still present: ${sel}`).toBe(0);
  }
  expect(await view.locator("[onerror], [onload], [onclick]").count()).toBe(0);
  expect(await view.locator("a[href^='javascript'], a[href^='data:']").count()).toBe(0);
  await expect(view.locator("a[href='https://example.com']")).toHaveText("site");
  // The mermaid fence breakout stays inside its pre.
  await expect(view.locator("pre.mermaid")).toHaveCount(1);
  expect(await view.locator("pre.mermaid script").count()).toBe(0);
  // The hostile title is text in the header, never an element.
  await expect(page.locator(".preview-title")).toContainText("<img src=x");
  expect(await page.locator(".preview-header img").count()).toBe(0);
  expect(external).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => getComputedStyle(document.body).display)).not.toBe("none");
});

test("an unsupported sanitizer fails CLOSED to the exact source (no second renderer)", async ({
  cortexDaemon,
  url,
  page,
}) => {
  // DOMPurify.isSupported is false without document.implementation.createHTMLDocument.
  await page.addInitScript(() => {
    delete (DOMImplementation.prototype as unknown as Record<string, unknown>).createHTMLDocument;
  });
  const task = await seedTask(url, "unsupported", "saved");
  const source =
    '# Would be a heading\n\n<img src=x onerror="window.__pwned=1">\n\n```mermaid\ngraph LR\n  A-->B\n```\n';
  const token = await createdToken(cortexDaemon.env, { taskId: task.id, title: "t", source });
  await page.goto(`${url}/preview/${token}`);
  await expect(page.locator(".preview-document .md-render-error")).toContainText("could not be rendered safely");
  expect(await page.locator(".preview-document .md-source-fallback").evaluate(el => el.textContent)).toBe(source);
  expect(await page.locator(".preview-document h1, .preview-document img, .preview-document svg").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
});

test("every tested Mermaid diagram type renders in the preview; an invalid one fails visibly with its source", async ({
  cortexDaemon,
  url,
  page,
}) => {
  const task = await seedTask(url, "mermaid", "saved");
  const source = `${buildBody()}\n## Broken\n\n\`\`\`mermaid\ngraph LR\n  A --> \n  ((( nonsense\n\`\`\`\n`;
  const token = await createdToken(cortexDaemon.env, { taskId: task.id, title: "diagrams", source, unsaved: true });
  await page.goto(`${url}/preview/${token}`);
  const doc = page.locator(".preview-document");
  await expect(doc.locator(".markdown-view h1")).toHaveText("Mermaid diagram type matrix");
  await expect(doc.locator("pre.mermaid svg")).toHaveCount(CASES.length, { timeout: 20_000 });
  const blocks = doc.locator("pre.mermaid");
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    if (c === undefined) continue;
    const svg = blocks.nth(i).locator("svg");
    await expect(svg, `${c.type} (block ${i + 1})`).toContainText(c.probe);
    expect(await svg.textContent(), `${c.type} rendered the error bomb`).not.toContain("Syntax error");
  }
  const broken = doc.locator("pre.mermaid[data-mermaid-state='error']");
  await expect(broken).toHaveCount(1, { timeout: 15_000 });
  await expect(broken).toContainText("nonsense");
  await expect(doc.locator(".md-mermaid-error .md-mermaid-retry")).toBeVisible();
});

// Review @405 F18: the preview is main#app's only child, not a dashboard pane: it must not
// land in the dashboard grid's 280px sidebar column nor under its fixed-height clipping.
const DESKTOP = { width: 1280, height: 800 };

test("a desktop preview is centered up to its max width, never in the sidebar column", async ({
  cortexDaemon,
  url,
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  const task = await seedTask(url, "layout", "saved");
  const token = await createdToken(cortexDaemon.env, {
    taskId: task.id,
    title: "layout",
    source: "# Wide preview\n\nA draft paragraph that is long enough to use the whole reading width of the page.\n",
  });
  await page.goto(`${url}/preview/${token}`);
  await expect(page.locator(".preview-document .markdown-view h1")).toHaveText("Wide preview");
  const geometry = await page.locator(".preview-page").evaluate(el => {
    const box = el.getBoundingClientRect();
    return {
      width: box.width,
      center: box.left + box.width / 2,
      maxWidth: Number.parseFloat(getComputedStyle(el).maxWidth),
      viewport: document.documentElement.clientWidth,
    };
  });
  expect(geometry.width).toBeGreaterThan(280);
  expect(Math.abs(geometry.width - Math.min(geometry.maxWidth, geometry.viewport))).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.center - geometry.viewport / 2)).toBeLessThanOrEqual(1);
});

test("a long preview scrolls: the user reaches its last line", async ({ cortexDaemon, url, page }) => {
  await page.setViewportSize(DESKTOP);
  const task = await seedTask(url, "long", "saved");
  const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of a long unsaved draft.`).join("\n\n");
  const source = `${buildBody()}\n${filler}\n\nLAST-LINE-PROBE: the end of the draft\n`;
  const token = await createdToken(cortexDaemon.env, { taskId: task.id, title: "long", source, unsaved: true });
  await page.goto(`${url}/preview/${token}`);
  const doc = page.locator(".preview-document");
  // Diagrams change the height as they render: measure the final document.
  await expect(doc.locator("pre.mermaid svg")).toHaveCount(CASES.length, { timeout: 20_000 });
  const last = doc.getByText("LAST-LINE-PROBE");
  await expect(last).not.toBeInViewport();
  // A user scroll, not scrollIntoView: script can scroll an overflow:hidden box, a wheel cannot.
  const box = await doc.boundingBox();
  if (box === null) throw new Error("the preview document has no layout box");
  await page.mouse.move(box.x + box.width / 2, DESKTOP.height / 2);
  await page.mouse.wheel(0, 100_000);
  await expect(last).toBeInViewport();
});

// Review @405 F19: a preview visit persists no preference, not even the theme it applies
// (a fresh context each test); the dashboard keeps persisting its first-load theme.
test("a preview visit stores no theme; the dashboard still persists its first-load theme", async ({
  cortexDaemon,
  url,
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const task = await seedTask(url, "theme", "SAVED-THEME-PROBE");
  const token = await createdToken(cortexDaemon.env, { taskId: task.id, title: "theme", source: "# Themed draft" });
  await page.goto(`${url}/preview/${token}`);
  await expect(page.locator(".preview-document .markdown-view h1")).toHaveText("Themed draft");
  // The system theme is applied before first paint...
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  // ...but never stored as if the user had chosen it; nothing else is stored either.
  expect(await page.evaluate(() => localStorage.getItem("cortex-theme"))).toBeNull();
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);

  await page.goto(`${url}/task/${task.id}`);
  await expect(page.locator(".doc-reader .markdown-view")).toContainText("SAVED-THEME-PROBE");
  expect(await page.evaluate(() => localStorage.getItem("cortex-theme"))).toBe("dark");
});

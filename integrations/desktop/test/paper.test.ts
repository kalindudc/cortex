// The paper look in a real window: the bundled fonts load from the app and
// set the prose, the title and the editor; nothing goes out over http or
// https; the document sheet's paper is a content-free, dotted layer with an
// uneven edge and no filter above the header or the reader; body text keeps
// 4.5:1 on the sheet and the desk in light and dark; high contrast drops the
// grain and the dots; and diagrams draw in Mermaid's hand-drawn look.
// happy-dom has no fonts, no layout and no pseudo-elements, so only this
// tier can check them.

import type { Page, Request } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { addTask, MOD } from "./chrome.ts";
import { type DesktopApp, launchDesktop, waitForDashboard } from "./harness.ts";
import { waitForLive } from "./live.ts";

let desktop: DesktopApp;
let taskId: number;
const requests: string[] = [];

const POLL = { timeout: 10_000, interval: 50 };
const MERMAID_TIMEOUT = 20_000;
const VIEW = ".doc-reader .markdown-view";
const DIAGRAM = `${VIEW} pre.mermaid svg`;
const LAYER = ".doc-sheet > .paper-layer";
const CARDS = "#setting-appearance";

const BODY = [
  "# Paper probe",
  "",
  "Prose on the sheet, with *italic* and **bold** words in one paragraph.",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  '  A["PaperProbeStart"] --> B["PaperProbeEnd"]',
  "```",
].join("\n");

// The serialized computed font-family quotes a name with a space and may quote a single word.
const STARTS_WITH_LITERATA = /^"?Literata"?(,|$)/;
const STARTS_WITH_IA_WRITER_MONO = /^"iA Writer Mono"(,|$)/;

beforeAll(async () => {
  desktop = await launchDesktop();
  desktop.page.on("request", (req: Request) => requests.push(req.url()));
  await waitForDashboard(desktop.page);
  await waitForLive(desktop.page);
  taskId = await addTask(desktop, "Paper probe title", { body: BODY });
});

afterAll(async () => {
  await desktop?.close();
});

/** Open the probe task by its address: a fresh document, so its fonts load again. */
async function openTask(page: Page): Promise<void> {
  await page.goto(`cortex://app/task/${taskId}`);
  await waitForDashboard(page);
  await waitForLive(page);
  await page.locator(".task-document").waitFor();
}

async function setMode(page: Page, mode: "Read" | "Edit"): Promise<void> {
  await page.locator('fieldset[aria-label="Body view mode"]').getByRole("button", { name: mode, exact: true }).click();
}

async function readView(page: Page): Promise<void> {
  await setMode(page, "Read");
  await page.locator(`${VIEW} h1`, { hasText: "Paper probe" }).waitFor();
}

/** Choose an appearance in the Settings panel, then come back to the task's document. */
async function setAppearance(page: Page, value: "light" | "dark" | "high-contrast"): Promise<void> {
  await page.keyboard.press(`${MOD}+Comma`);
  await page.locator(`${CARDS} input[value="${value}"]`).check();
  await page.locator('.nav-rail button[aria-label="Tasks"]').click();
  await page.locator(CARDS).waitFor({ state: "detached" });
  await page.locator(LAYER).waitFor();
  const expected = value === "high-contrast" ? { theme: "dark", contrast: "high" } : { theme: value, contrast: null };
  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          theme: document.documentElement.getAttribute("data-theme"),
          contrast: document.documentElement.getAttribute("data-contrast"),
        })),
      POLL,
    )
    .toEqual(expected);
}

const fontFamily = (page: Page, selector: string): Promise<string> =>
  page.locator(selector).evaluate(el => getComputedStyle(el).fontFamily);

/** The paper layer's own attributes and what its ::before paints. */
function paperLayer(page: Page) {
  return page.locator(LAYER).evaluate(el => {
    const before = getComputedStyle(el, "::before");
    return {
      ariaHidden: el.getAttribute("aria-hidden"),
      dotted: el.classList.contains("is-dotted"),
      clipPath: before.clipPath,
      backgroundImage: before.backgroundImage,
    };
  });
}

/** Every element from each selector's match up to <html> whose computed filter is not none. */
function filteredAncestors(page: Page, selectors: string[]): Promise<string[]> {
  return page.evaluate(sels => {
    const found: string[] = [];
    for (const sel of sels) {
      const start = document.querySelector(sel);
      if (!start) throw new Error(`${sel} is not in the document`);
      for (let el: Element | null = start; el; el = el.parentElement) {
        const filter = getComputedStyle(el).filter;
        if (filter !== "none") found.push(`${sel}: <${el.tagName.toLowerCase()} class="${el.className}"> ${filter}`);
      }
    }
    return found;
  }, selectors);
}

/** WCAG 2 contrast ratios of the body text tokens over the sheet and the desk, as the page resolves them. */
function contrastRatios(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    // A probe element resolves any colour syntax to the rgb() serialization.
    const probe = document.createElement("span");
    document.body.append(probe);
    const rgb = (token: string): number[] => {
      probe.style.color = `var(${token})`;
      const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(getComputedStyle(probe).color);
      if (!m) throw new Error(`${token} is not an opaque colour: ${getComputedStyle(probe).color}`);
      return [m[1], m[2], m[3]].map(c => Number(c) / 255);
    };
    const luminance = (token: string): number => {
      const [r, g, b] = rgb(token).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const out: Record<string, number> = {};
    try {
      for (const text of ["--text", "--text-content", "--text-2"]) {
        for (const surface of ["--sheet", "--desk"]) {
          const [hi, lo] = [luminance(text), luminance(surface)].sort((a, b) => b - a);
          out[`${text} on ${surface}`] = (hi + 0.05) / (lo + 0.05);
        }
      }
    } finally {
      probe.remove();
    }
    return out;
  });
}

describe("paper look", () => {
  test("Literata and iA Writer Mono load from the app, and nothing is requested over http or https", async () => {
    const { page } = desktop;
    requests.length = 0;
    await openTask(page);
    await readView(page);
    await page.locator(DIAGRAM).waitFor({ timeout: MERMAID_TIMEOUT });
    await setMode(page, "Edit");
    await page.locator(".md-editor .cm-content").waitFor();
    await page.evaluate(() => document.fonts.ready);

    const loaded = await page.evaluate(() =>
      [...document.fonts].filter(face => face.status === "loaded").map(face => face.family),
    );
    expect(loaded).toContain("Literata");
    expect(loaded).toContain("iA Writer Mono");

    expect(requests.some(url => url.endsWith("/bundle.js")), "the request recorder saw the page load").toBe(true);
    expect(requests.filter(url => /^https?:/i.test(url)), "requests over http or https").toEqual([]);
    const fonts = requests.filter(url => url.endsWith(".woff2"));
    expect(fonts.filter(url => !url.startsWith("cortex://app/fonts/")), "fonts from outside the app").toEqual([]);
    expect(fonts.some(url => url.includes("/fonts/literata-"))).toBe(true);
    expect(fonts.some(url => url.includes("/fonts/ia-writer-mono-"))).toBe(true);
  });

  test("Read view sets the prose and title in Literata, and Edit view the editor in iA Writer Mono", async () => {
    const { page } = desktop;
    await openTask(page);
    await readView(page);
    expect(await fontFamily(page, VIEW)).toMatch(STARTS_WITH_LITERATA);
    expect(await fontFamily(page, ".task-header .task-title-display")).toMatch(STARTS_WITH_LITERATA);

    await setMode(page, "Edit");
    await page.locator(".md-editor .cm-content").waitFor();
    expect(await fontFamily(page, ".md-editor .cm-content")).toMatch(STARTS_WITH_IA_WRITER_MONO);
  });

  test("a diagram renders as an SVG in Mermaid's hand-drawn look", async () => {
    const { page } = desktop;
    await openTask(page);
    await readView(page);
    await page.locator(DIAGRAM).waitFor({ timeout: MERMAID_TIMEOUT });
    // Classic nodes are g.node around a <rect>; hand-drawn nodes are g.rough-node around roughjs paths: a
    // hachure fill and an outline, both stroked curves (fill="none") drawn as several sub-paths.
    const drawing = await page.locator(DIAGRAM).evaluate(svg => ({
      text: svg.textContent ?? "",
      classicNodes: svg.querySelectorAll("g.node").length,
      nodes: [...svg.querySelectorAll("g.rough-node")].map(node => {
        const container = node.querySelector(".label-container");
        return {
          container: container?.tagName.toLowerCase() ?? null,
          paths: [...(container?.querySelectorAll("path") ?? [])].map(path => ({
            fill: path.getAttribute("fill"),
            curved: (path.getAttribute("d") ?? "").includes("C"),
            subpaths: (path.getAttribute("d") ?? "").split("M").length - 1,
          })),
        };
      }),
      edges: [...svg.querySelectorAll("path.flowchart-link")].map(
        path => (path.getAttribute("d") ?? "").split("M").length - 1,
      ),
    }));
    expect(drawing.text).toContain("PaperProbeStart");
    expect(drawing.text).toContain("PaperProbeEnd");
    expect(drawing.classicNodes).toBe(0);
    expect(drawing.nodes).toHaveLength(2);
    for (const node of drawing.nodes) {
      expect(node.container).toBe("g");
      expect(node.paths.length).toBeGreaterThanOrEqual(2);
      for (const path of node.paths) {
        expect(path).toMatchObject({ fill: "none", curved: true });
        expect(path.subpaths).toBeGreaterThan(4);
      }
    }
    // A hand-drawn edge is its line stroked more than once.
    expect(drawing.edges).toHaveLength(1);
    expect(drawing.edges[0]).toBeGreaterThanOrEqual(2);
  });

  test("light and dark: a dotted, uneven paper layer, no filter above the content, body text at 4.5:1", async () => {
    const { page } = desktop;
    await openTask(page);
    await readView(page);
    for (const appearance of ["light", "dark"] as const) {
      await setAppearance(page, appearance);
      await page.locator(VIEW).waitFor();
      const layer = await paperLayer(page);
      expect(layer.ariaHidden, appearance).toBe("true");
      expect(layer.dotted, appearance).toBe(true);
      expect(layer.clipPath, appearance).toMatch(/^polygon\(/);
      expect(layer.backgroundImage, appearance).toMatch(/^radial-gradient\(/);

      expect(await filteredAncestors(page, [".task-header", ".doc-reader"]), appearance).toEqual([]);
      // The control: the walk does see a filter, the paper layer's own lift.
      expect(await filteredAncestors(page, [LAYER]), appearance).toHaveLength(1);

      for (const [pair, ratio] of Object.entries(await contrastRatios(page))) {
        expect(ratio, `${appearance}: ${pair}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("high contrast draws no grain and no dots", async () => {
    const { page } = desktop;
    await openTask(page);
    await readView(page);
    await setAppearance(page, "high-contrast");
    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        grain: style.getPropertyValue("--paper-grain").trim(),
        dots: style.getPropertyValue("--dot-grid").trim(),
      };
    });
    expect(tokens).toEqual({ grain: "none", dots: "none" });
    // The dotted layer paints two images, the dots and the grain: both are gone.
    expect((await paperLayer(page)).backgroundImage.split(",").map(image => image.trim())).toEqual(["none", "none"]);
  });
});

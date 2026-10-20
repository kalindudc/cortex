// The task document in the running app: heading links, the reader's copy
// control and outline, the real CodeMirror editor and its autosave, a
// conflict with the CLI resolved both ways, Split mode, a status change from
// the toolbar and the editor's @id references. happy-dom has no layout and no
// real editor, so these journeys are only checked here.

import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type DesktopApp, launchDesktop, waitForDashboard } from "./harness.ts";
import { waitForLive } from "./live.ts";

let desktop: DesktopApp;
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const POLL = { timeout: 10_000, interval: 100 };
const VIEW = ".doc-reader .markdown-view";

async function addTask(title: string, body: string): Promise<number> {
  const task = JSON.parse(await desktop.cortex(["add", title, `--body=${body}`, "--json"])) as { id: number };
  return task.id;
}

async function bodyOf(id: number): Promise<string> {
  const shown = JSON.parse(await desktop.cortex(["show", String(id), "--json"])) as { task: { body: string | null } };
  return shown.task.body ?? "";
}

/** Open a task by its address; the body view mode is the one the user chose last. */
async function openTask(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await waitForDashboard(page);
  await waitForLive(page);
  await page.locator(".task-document").waitFor();
}

async function setMode(page: Page, mode: "Read" | "Edit" | "Split"): Promise<void> {
  await page.locator('fieldset[aria-label="Body view mode"]').getByRole("button", { name: mode, exact: true }).click();
}

async function editor(page: Page): Promise<Locator> {
  const cm = page.locator(".md-editor .cm-content");
  await cm.waitFor();
  return cm;
}

async function typeAtEnd(page: Page, cm: Locator, text: string, delay = 0): Promise<void> {
  await cm.click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type(text, { delay });
}

/** True when the element's top edge is inside the reader's visible area. */
function inReaderViewport(page: Page, id: string): Promise<boolean> {
  return page.evaluate(headingId => {
    const reader = document.querySelector(".doc-reader");
    const el = document.getElementById(headingId);
    if (!reader || !el) return false;
    const r = reader.getBoundingClientRect();
    const top = el.getBoundingClientRect().top;
    return top >= r.top - 2 && top < r.bottom;
  }, id);
}

// Separate paragraphs, so the sections are taller than the reader.
const filler = (label: string): string[] => Array.from({ length: 40 }, (_, i) => `${label} paragraph ${i + 1}.\n`);

beforeAll(async () => {
  desktop = await launchDesktop();
  await waitForDashboard(desktop.page);
  await waitForLive(desktop.page);
});

afterAll(async () => {
  await desktop?.close();
});

describe("document surface", () => {
  test("a heading link opens that heading in Read mode, by full anchor and by bare slug", async () => {
    const { page } = desktop;
    const body = [
      "# Alpha",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      ...filler("alpha"),
      "",
      "## Beta",
      "",
      ...filler("beta"),
      "",
      "## Beta",
      "",
      ...filler("second beta"),
    ].join("\n");
    const id = await addTask("headings", body);

    await openTask(page, `cortex://app/task/${id}#task-${id}-beta-2`);
    expect(await page.locator('fieldset[aria-label="Body view mode"] button[aria-pressed="true"]').textContent()).toContain(
      "Read",
    );
    await expect.poll(() => inReaderViewport(page, `task-${id}-beta-2`), POLL).toBe(true);

    await openTask(page, `cortex://app/task/${id}#beta`);
    await expect.poll(() => inReaderViewport(page, `task-${id}-beta`), POLL).toBe(true);
    expect(await inReaderViewport(page, `task-${id}-beta-2`)).toBe(false);

    // The code block's copy control hands the code text to the clipboard.
    await page.evaluate(() => {
      const copied: string[] = [];
      (window as unknown as { __copied: string[] }).__copied = copied;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: (text: string) => (copied.push(text), Promise.resolve()) },
      });
    });
    await page.locator(`${VIEW} .md-codeblock .md-copy`).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied), POLL)
      .toEqual(["const answer = 42;\n"]);
    expect(await page.locator(`${VIEW} .md-codeblock .md-copy`).textContent()).toBe("Copied");

    // The side panel's outline scrolls the reader to its entry.
    await page.getByRole("tab", { name: "Outline" }).click();
    await page.locator(".doc-outline .doc-outline-link", { hasText: "Alpha" }).click();
    await expect.poll(() => inReaderViewport(page, `task-${id}-alpha`), POLL).toBe(true);
    await page.locator(".doc-outline .doc-outline-link", { hasText: "Beta" }).last().click();
    await expect.poll(() => inReaderViewport(page, `task-${id}-beta-2`), POLL).toBe(true);
  });

  test("typing in Edit mode autosaves, and the editor's content grows and scrolls inside the pane", async () => {
    const { page } = desktop;
    const id = await addTask("editor autosave", "# Draft\n\nfirst line");
    await openTask(page, `cortex://app/task/${id}`);
    await setMode(page, "Edit");
    const cm = await editor(page);
    await typeAtEnd(page, cm, "\nsecond line typed in the app");
    await expect.poll(() => bodyOf(id), POLL).toBe("# Draft\n\nfirst line\nsecond line typed in the app");

    // The editor fills the pane and scrolls inside it, so the chrome around it stays put.
    const pane = await page.locator(".md-editor .cm-editor").boundingBox();
    const contentHeight = async (): Promise<number> => (await cm.boundingBox())?.height ?? 0;
    await typeAtEnd(page, cm, "\nmore".repeat(30));
    await expect.poll(contentHeight, POLL).toBeGreaterThan((pane?.height ?? 0) + 100);
    expect((await page.locator(".md-editor .cm-editor").boundingBox())?.height).toBeLessThanOrEqual((pane?.height ?? 0) + 1);
    expect(
      await page.locator(".md-editor .cm-scroller").evaluate(el => el.scrollHeight > el.clientHeight),
    ).toBe(true);
    await expect.poll(async () => (await bodyOf(id)).split("\n").length, POLL).toBe(34);
  });

  test("a CLI write during typing raises a conflict: autosave pauses, Keep writes ours, Apply adopts theirs", async () => {
    const { page } = desktop;
    const banner = page.locator(".external-change-banner");
    const typed = " typed slowly here.."; // 20 characters, under the 3 s autosave ceiling at 100 ms each

    const keepId = await addTask("conflict keep", "# Conflict\n\nbase");
    await openTask(page, `cortex://app/task/${keepId}`);
    await setMode(page, "Edit");
    let cm = await editor(page);
    await typeAtEnd(page, cm, typed.slice(0, 2));
    const typing = page.keyboard.type(typed.slice(2), { delay: 100 });
    await desktop.cortex(["edit", String(keepId), "--body", "from the CLI"]);
    await typing;
    await banner.waitFor({ timeout: 10_000 });
    expect(await banner.textContent()).toContain("from the CLI");
    // Paused: the daemon keeps the CLI's text while the user decides.
    expect(await bodyOf(keepId)).toBe("from the CLI");
    expect(await cm.textContent()).toContain(`base${typed}`);
    await banner.getByRole("button", { name: "Keep my changes" }).click();
    await banner.waitFor({ state: "detached" });
    await expect.poll(() => bodyOf(keepId), POLL).toBe(`# Conflict\n\nbase${typed}`);

    const applyId = await addTask("conflict apply", "# Conflict\n\nbase");
    await openTask(page, `cortex://app/task/${applyId}`);
    await setMode(page, "Edit");
    cm = await editor(page);
    await typeAtEnd(page, cm, typed.slice(0, 2));
    const typingAgain = page.keyboard.type(typed.slice(2), { delay: 100 });
    await desktop.cortex(["edit", String(applyId), "--body", "from the CLI"]);
    await typingAgain;
    await banner.waitFor({ timeout: 10_000 });
    await banner.getByRole("button", { name: "Apply", exact: true }).click();
    await banner.waitFor({ state: "detached" });
    await expect.poll(() => page.locator(".md-editor .cm-content").textContent(), POLL).toBe("from the CLI");
    expect(await bodyOf(applyId)).toBe("from the CLI");
  });

  test("Split mode shows the source and the rendered output side by side", async () => {
    const { page } = desktop;
    const id = await addTask("split view", "# Split heading\n\nsome **bold** text");
    await openTask(page, `cortex://app/task/${id}`);
    await setMode(page, "Split");
    await page.locator(".md-editor .cm-content").waitFor();
    const source = await page.locator(".doc-split > .editable-task-body").boundingBox();
    const rendered = await page.locator(".doc-split > .doc-reader").boundingBox();
    if (!source || !rendered) throw new Error("expected both panes to be laid out");
    expect(source.x + source.width).toBeLessThanOrEqual(rendered.x + 1);
    expect(Math.abs(source.y - rendered.y)).toBeLessThan(40);
    expect(await page.locator(".doc-split .doc-reader strong").textContent()).toBe("bold");
    expect(await page.locator(".md-editor .cm-content").textContent()).toContain("some **bold** text");
  });

  test("the toolbar's next-status action changes the task and posts no notification", async () => {
    const { page } = desktop;
    const id = await addTask("status target", "# Status\n\nbody");
    await openTask(page, `cortex://app/task/${id}`);
    const notifications = (): Promise<number> =>
      page.evaluate(async () => {
        const reply = await window.cortex.request({ method: "GET", path: "/api/notifications" });
        return (JSON.parse(reply.body) as unknown[]).length;
      });
    const before = await notifications();
    const status = async (): Promise<string | undefined> =>
      (JSON.parse(await desktop.cortex(["ls", "--json"])) as { id: number; status: string }[]).find(t => t.id === id)
        ?.status;
    expect(await status()).toBe("open");
    await page.locator(".task-next-status").click();
    await expect.poll(status, POLL).toBe("review");
    expect(await notifications()).toBe(before);
  });

  test("an @id in the editor is decorated, and Mod+click opens that task", async () => {
    const { page } = desktop;
    const target = await addTask("reference target", "# Target\n\nthe referenced task");
    const id = await addTask("reference source", "# Source\n\nbody");
    await openTask(page, `cortex://app/task/${id}`);
    await setMode(page, "Edit");
    const cm = await editor(page);
    await typeAtEnd(page, cm, `\nsee @${target} here`);
    const ref = page.locator(".md-editor .cm-cortex-ref", { hasText: `@${target}` });
    await ref.waitFor();
    expect(await ref.getAttribute("data-ref-kind")).toBe("task");
    await ref.click({ modifiers: [MOD === "Meta" ? "Meta" : "Control"] });
    await expect.poll(() => page.url(), POLL).toBe(`cortex://app/task/${target}`);
    await page.locator(".task-document", { hasText: "reference target" }).waitFor();
  });
});

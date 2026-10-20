// MarkdownView — structural tests for the shared rendered-Markdown surface.
//
// DOMPurify is mocked with a passthrough (broken under happy-dom; real
// scrubbing is Chromium-verified in test/e2e/document-safety.spec.ts), so
// these tests cover the STRUCTURE: stable namespaced heading ids +
// outline reporting, prose-only ref decoration, copy controls with visible
// failure, defensive input tightening, DOM stability across unrelated
// re-renders, and the fail-closed sanitizer-unsupported view.

import { describe, test, expect, mock, beforeEach } from "bun:test";

const purifyCtrl = { supported: true };
mock.module("dompurify", () => ({
  default: {
    get isSupported() {
      return purifyCtrl.supported;
    },
    sanitize: (html: string) => html,
    addHook: () => {},
    removeHook: () => {},
  },
}));

import { render, fireEvent } from "@testing-library/preact";
import { MarkdownView, type MarkdownHeading } from "../../../../src/ui/components/active/MarkdownView.tsx";
import { tasks, selectedId, filters, workspaceQuery } from "../../../../src/ui/state/signals.ts";
import type { Task } from "../../../../src/ui/api/types.ts";

const mkTask = (id: number): Task => ({
  id,
  lane: "now",
  title: `task ${id}`,
  body: null,
  status: "open",
  priority: null,
  created: 0,
  updated: 0,
  tags: [],
  memory_excluded: false,
});

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe("MarkdownView", () => {
  beforeEach(() => {
    purifyCtrl.supported = true;
    tasks.value = [];
    selectedId.value = null;
    filters.value = { status: null, lane: null, tag: [] };
    workspaceQuery.value = "";
  });

  test("renders sanitized markdown into the host", async () => {
    const { container } = render(<MarkdownView source={"# Title\n\nBody text."} idPrefix="t1" />);
    await tick();
    expect(container.querySelector(".markdown-view h1")?.textContent).toBe("Title");
    expect(container.textContent).toContain("Body text.");
  });

  test("headings get stable namespaced unique ids; duplicates get suffixes", async () => {
    const { container } = render(
      <MarkdownView source={"# Setup\n\n## Steps\n\n## Steps\n\n### Final Notes!"} idPrefix="task-9" />,
    );
    await tick();
    const ids = Array.from(container.querySelectorAll("h1, h2, h3")).map(h => h.id);
    expect(ids).toEqual(["task-9-setup", "task-9-steps", "task-9-steps-2", "task-9-final-notes"]);
  });

  test("onHeadings reports the outline", async () => {
    let got: MarkdownHeading[] = [];
    render(
      <MarkdownView
        source={"# One\n\n## Two"}
        idPrefix="x"
        onHeadings={h => {
          got = h;
        }}
      />,
    );
    await tick();
    expect(got).toEqual([
      { id: "x-one", text: "One", level: 1 },
      { id: "x-two", text: "Two", level: 2 },
    ]);
  });

  test("@id refs are decorated in prose but NEVER inside code", async () => {
    const { container } = render(
      <MarkdownView
        source={"See @42 for details.\n\n```\nignore @42 in code\n```\n\nAnd `inline @42` too."}
        idPrefix="t"
      />,
    );
    await tick();
    const refs = container.querySelectorAll("button.md-ref");
    expect(refs.length).toBe(1);
    expect(refs[0].textContent).toBe("@42");
  });

  test("clicking a task ref navigates via navigateRef (existing task)", async () => {
    tasks.value = [mkTask(42)];
    filters.value = { status: "open", lane: null, tag: [] };
    const { container } = render(<MarkdownView source={"go to @42 now"} idPrefix="t" />);
    await tick();
    const ref = container.querySelector<HTMLButtonElement>("button.md-ref");
    if (!ref) throw new Error("expected decorated ref");
    fireEvent.click(ref);
    expect(selectedId.value).toBe(42);
    // navigateRef clears filters for task refs (existing contract).
    expect(filters.value).toEqual({ status: null, lane: null, tag: [] });
  });

  test("#tag refs replace only the tag filter slot", async () => {
    filters.value = { status: "open", lane: "now", tag: [] };
    const { container } = render(<MarkdownView source={"about #bugs today"} idPrefix="t" />);
    await tick();
    const ref = container.querySelector<HTMLButtonElement>("button.md-ref");
    if (!ref) throw new Error("expected decorated tag ref");
    fireEvent.click(ref);
    expect(filters.value.tag).toEqual(["bugs"]);
    expect(filters.value.status).toBe("open"); // untouched
    expect(filters.value.lane).toBe("now"); // untouched
  });

  test("an injected onRef follows refs instead of navigateRef: no selection/filter singleton changes", async () => {
    tasks.value = [mkTask(42)];
    filters.value = { status: "open", lane: "now", tag: [] };
    const followed: string[] = [];
    const { container } = render(
      <MarkdownView
        source={"see @42 and #bugs"}
        idPrefix="t"
        onRef={(kind, value) => followed.push(`${kind}:${value}`)}
      />,
    );
    await tick();
    for (const ref of Array.from(container.querySelectorAll<HTMLButtonElement>("button.md-ref"))) fireEvent.click(ref);
    expect(followed).toEqual(["task:42", "tag:bugs"]);
    expect(selectedId.value).toBeNull();
    expect(filters.value).toEqual({ status: "open", lane: "now", tag: [] });
  });

  test("code blocks gain a copy control; clipboard success shows feedback", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (t: string) => {
          writes.push(t);
          return Promise.resolve();
        },
      },
    });
    const { container } = render(<MarkdownView source={"```\ncopy me\n```"} idPrefix="t" />);
    await tick();
    const btn = container.querySelector<HTMLButtonElement>(".md-codeblock .md-copy");
    if (!btn) throw new Error("expected copy control");
    fireEvent.click(btn);
    await tick();
    expect(writes).toEqual(["copy me\n"]);
    expect(btn.textContent).toBe("Copied");
  });

  test("clipboard failure is VISIBLE on the control", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    const { container } = render(<MarkdownView source={"```\nx\n```"} idPrefix="t" />);
    await tick();
    const btn = container.querySelector<HTMLButtonElement>(".md-copy");
    if (!btn) throw new Error("expected copy control");
    fireEvent.click(btn);
    await tick();
    expect(btn.textContent).toBe("Copy failed");
  });

  test("only disabled checkboxes survive as inputs (defensive tightening)", async () => {
    const { container } = render(
      <MarkdownView source={'- [x] done\n\n<input type="text" value="steal"><input type="checkbox">'} idPrefix="t" />,
    );
    await tick();
    const inputs = Array.from(container.querySelectorAll("input"));
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.getAttribute("type")).toBe("checkbox");
      expect(input.hasAttribute("disabled")).toBe(true);
    }
  });

  test("tables get a local overflow wrapper", async () => {
    const { container } = render(<MarkdownView source={"| a | b |\n| - | - |\n| 1 | 2 |"} idPrefix="t" />);
    await tick();
    expect(container.querySelector(".md-table-wrap > table")).not.toBeNull();
  });

  test("unrelated parent re-renders do NOT rebuild the markdown DOM", async () => {
    const { container, rerender } = render(<MarkdownView source={"# Stable"} idPrefix="t" />);
    await tick();
    const before = container.querySelector("h1");
    if (!before) throw new Error("expected heading");
    rerender(<MarkdownView source={"# Stable"} idPrefix="t" />);
    await tick();
    expect(container.querySelector("h1")).toBe(before); // same node identity
  });

  test("source change DOES rebuild and reports fresh headings", async () => {
    const seen: string[][] = [];
    const { rerender, container } = render(
      <MarkdownView source={"# A"} idPrefix="t" onHeadings={h => seen.push(h.map(x => x.text))} />,
    );
    await tick();
    rerender(<MarkdownView source={"# B"} idPrefix="t" onHeadings={h => seen.push(h.map(x => x.text))} />);
    await tick();
    expect(container.querySelector("h1")?.textContent).toBe("B");
    expect(seen).toEqual([["A"], ["B"]]);
  });

  test("sanitizer-unsupported fails CLOSED: explicit error + raw source, no HTML insertion", async () => {
    purifyCtrl.supported = false;
    const { container } = render(<MarkdownView source={"# secret <script>alert(1)</script>"} idPrefix="t" />);
    await tick();
    expect(container.querySelector(".markdown-view-failed")).not.toBeNull();
    expect(container.querySelector(".md-render-error")?.textContent).toContain("could not be rendered safely");
    // Raw source is shown as TEXT (pre), never parsed as HTML.
    expect(container.querySelector(".md-source-fallback")?.textContent).toContain("<script>alert(1)</script>");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("h1")).toBeNull();
  });

  test("mermaid fences keep recoverable escaped source; module failure yields explicit error + retry", async () => {
    const { container } = render(<MarkdownView source={"```mermaid\ngraph TD; A-->B;\n```"} idPrefix="t" />);
    await tick();
    const node = container.querySelector<HTMLElement>("pre.mermaid");
    if (!node) throw new Error("expected mermaid node");
    // textContent recovers the raw arrows from the escaped fence.
    expect(node.textContent).toContain("A-->B;");
    // Module load fails under bun/happy-dom → explicit error + retry.
    await new Promise(r => setTimeout(r, 20));
    expect(node.dataset.mermaidState).toBe("error");
    expect(container.querySelector(".md-mermaid-error .md-mermaid-retry")).not.toBeNull();
    expect(container.textContent).toContain("Diagram failed to render");
  });
});

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURSOR_MARKER, type Component, type OverlayHandle, visibleWidth } from "@earendil-works/pi-tui";
import type { CortexClient, DaemonIdentity, WorkspaceSnapshot } from "../../../src/contracts.ts";
import type { Lane, Task } from "../../../src/store.ts";
import { DEFAULT_CONFIG, loadConfig } from "../../../src/tui/config.ts";
import { DEFAULT_KEYS } from "../../../src/tui/keys.ts";
import { openPreferences } from "../../../src/tui/preferences.ts";
import {
  createReader,
  findHeading,
  layoutDocument,
  parseDocument,
  type Reader,
  renderDocument,
  rowOfSourceLine,
  slugify,
} from "../../../src/tui/reader.ts";
import { drawMermaid } from "../../../src/tui/diagram.ts";
import { TuiSession } from "../../../src/tui/session.ts";
import { type ResolvedTheme, resolveTheme, type ThemeToken } from "../../../src/tui/theme.ts";

// Plan @400 Task 10 part A (P6, N17, N19-N22): the terminal reader: the
// shared heading slugger (src/lib/slug.ts) and duplicate numbering, prose-only @id/#tag
// references, code copy, and heading links; plus the terminal's own search,
// heading steps, per-task position and jump history. The Markdown parser is a
// renderer, NOT a security boundary: every untrusted string crosses
// src/tui/safety.ts before it is styled, and only validated URLs become OSC 8
// hyperlinks.

const DB = "0b6a2f4e-0c1d-4e5f-8a9b-1c2d3e4f5a6b";
const IDENTITY: DaemonIdentity = {
  protocol: 1,
  instanceId: "instance-1",
  databaseId: DB,
  databasePath: "/tmp/cortex.db",
  endpoint: { kind: "unix", socketPath: "/tmp/cortex-x.sock" },
  pid: 4242,
};
const LANES: Lane[] = [{ name: "now", color: null, sort: 0 }];

const task = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  lane: "now",
  title: `task ${id}`,
  body: null,
  status: "open",
  priority: null,
  created: 1,
  updated: 1,
  tags: [],
  ...over,
});

const PLAIN_THEME = resolveTheme({ config: DEFAULT_CONFIG, env: { NO_COLOR: "1", TERM: "xterm-256color" } });
const COLOR_THEME = resolveTheme({ config: DEFAULT_CONFIG, env: { COLORTERM: "truecolor", TERM: "xterm-256color" } });

/** SGR removed; OSC 8 hyperlinks removed (their visible text stays). */
const plain = (lines: readonly string[]): string[] =>
  lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, ""));
const text = (lines: readonly string[]): string => plain(lines).join("\n");

/**
 * What remains after removing every sequence the reader may legitimately
 * emit: SGR from theme.ts style() and OSC 8 around a URL safeUrl() accepted.
 */
const residue = (lines: readonly string[]): string =>
  lines
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\]8;;(?:https?:\/\/|mailto:)[\x21-\x7e]*\x1b\\/g, "")
    .replace(/\x1b\]8;;\x1b\\/g, "");

/** The SGR parameters of the styled run holding the first `needle` (no other escape between them). */
const sgrBefore = (lines: readonly string[], needle: string): string => {
  const joined = lines.join("\n");
  const at = joined.indexOf(needle);
  if (at < 0) throw new Error(`no ${JSON.stringify(needle)} in the output`);
  return /\x1b\[([0-9;]*)m[^\x1b]*$/.exec(joined.slice(0, at))?.[1] ?? "";
};
const rgb = (hex: string): string => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)).join(";");
/** The truecolor SGR prefix of a theme pair: `38;2;<fg>;48;2;<surface>`. */
const pairSgr = (fg: ThemeToken, surface: ThemeToken): string =>
  `38;2;${rgb(COLOR_THEME.colors[fg])};48;2;${rgb(COLOR_THEME.colors[surface])}`;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tui-reader-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  session: TuiSession;
  reader: Reader;
  clipboard: string[];
}

function harness(
  tasks: Task[],
  options: { initialTask?: number; heading?: string; theme?: ResolvedTheme; clipboard?: boolean } = {},
): Harness {
  const snapshot: WorkspaceSnapshot = {
    identity: IDENTITY,
    cursor: "e:1",
    tasks,
    lanes: LANES,
    tags: [],
    notifications: [],
  };
  const versions = { entity: "e", title: "t", body: "b", priority: "p", lane: "l", status: "s" };
  const client = {
    workspace: async () => snapshot,
    taskState: async (id: number) => {
      const found = snapshot.tasks.find(t => t.id === id);
      if (found === undefined) throw new Error(`no task ${id}`);
      return { task: found, updates: [], versions, cursor: "e:1" };
    },
  } as unknown as CortexClient;
  const session = new TuiSession({
    client,
    identity: IDENTITY,
    keys: DEFAULT_KEYS,
    preferences: openPreferences(path.join(dir, "tui", "default.state.json")),
    configFile: path.join(dir, "tui.toml"),
    initialTask: options.initialTask ?? null,
    heading: options.heading ?? null,
    schedule: () => () => {},
  });
  session.applySnapshot(snapshot);
  session.setTheme(options.theme ?? PLAIN_THEME);
  session.setOverlayHost({
    columns: () => 100,
    rows: () => 30,
    showOverlay: (_component: Component): OverlayHandle => ({
      hide: () => {},
      setHidden: () => {},
      isHidden: () => false,
      focus: () => {},
      unfocus: () => {},
      isFocused: () => true,
      getBounds: () => undefined,
    }),
  });
  const reader = createReader(session);
  const clipboard: string[] = [];
  if (options.clipboard !== false) session.setClipboard(data => clipboard.push(data));
  session.setFocus("document");
  return { session, reader, clipboard };
}

/** Render the reader at `width` x `height`. */
function frame(h: Harness, width = 80, height = 30): string[] {
  h.reader.height = height;
  return h.reader.render(width);
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// ---------- headings: the shared slugger and anchors ----------

describe("headings use the shared slugger, anchors and duplicate numbering", () => {
  test("slugify: lowercase ASCII words joined by '-', else 'section'", () => {
    expect(slugify("Final Notes!")).toBe("final-notes");
    expect(slugify("  Hello,   World  ")).toBe("hello-world");
    expect(slugify("Ünïcode")).toBe("n-code");
    expect(slugify("!!!")).toBe("section");
    expect(slugify("")).toBe("section");
  });

  test("stable namespaced ids; duplicates get -2, -3 (the MarkdownView test case)", () => {
    const doc = parseDocument("# Setup\n\n## Steps\n\n## Steps\n\n### Final Notes!", 9);
    expect(doc.headings.map(h => h.id)).toEqual([
      "task-9-setup",
      "task-9-steps",
      "task-9-steps-2",
      "task-9-final-notes",
    ]);
    expect(doc.headings.map(h => h.slug)).toEqual(["setup", "steps", "steps-2", "final-notes"]);
    expect(doc.headings.map(h => h.level)).toEqual([1, 2, 2, 3]);
  });

  test("the outline reports text and level like onHeadings", () => {
    const doc = parseDocument("# One\n\n## Two", 1);
    expect(doc.headings.map(h => ({ id: h.id, text: h.text, level: h.level }))).toEqual([
      { id: "task-1-one", text: "One", level: 1 },
      { id: "task-1-two", text: "Two", level: 2 },
    ]);
  });

  test("heading text is its text content: setext and nested headings count, entities decode, code stays literal, images vanish", () => {
    const doc = parseDocument(
      [
        "Intro",
        "=====",
        "",
        "> ## Quoted",
        "",
        "- ### In a list",
        "",
        "## A &amp; B `c&amp;` ![logo](x.png) [link](https://x.example) **bold**",
        "",
        "```",
        "# not a heading",
        "```",
        "",
        "## !!!",
      ].join("\n"),
      4,
    );
    expect(doc.headings.map(h => h.text)).toEqual(["Intro", "Quoted", "In a list", "A & B c&amp;  link bold", "!!!"]);
    expect(doc.headings.map(h => h.id)).toEqual([
      "task-4-intro",
      "task-4-quoted",
      "task-4-in-a-list",
      "task-4-a-b-c-amp-link-bold",
      "task-4-section",
    ]);
  });

  test("findHeading resolves the bare slug, the full anchor or a #fragment; a missing heading is null", () => {
    const doc = parseDocument("## Steps\n\n## Steps\n", 9);
    expect(findHeading(doc, "steps")?.id).toBe("task-9-steps");
    expect(findHeading(doc, "steps-2")?.id).toBe("task-9-steps-2");
    expect(findHeading(doc, "task-9-steps-2")?.id).toBe("task-9-steps-2");
    expect(findHeading(doc, "#task-9-steps")?.id).toBe("task-9-steps");
    expect(findHeading(doc, "#steps-2")?.id).toBe("task-9-steps-2");
    expect(findHeading(doc, "Steps")?.id).toBe("task-9-steps");
    expect(findHeading(doc, "steps-3")).toBeNull();
    expect(findHeading(doc, "task-8-steps")).toBeNull();
    expect(findHeading(parseDocument("", 9), "steps")).toBeNull();
  });
});

// ---------- GFM rendering ----------

describe("safe GFM rendering", () => {
  const render = (source: string, width = 60) => renderDocument(source, { taskId: 1, width, theme: PLAIN_THEME });

  test("every row is exactly the width; headings, paragraphs and emphasis render without Markdown syntax", () => {
    const lines = render("# Plan\n\nSome **bold** and *soft* words.\n\n## Steps\n\n### Detail", 50);
    for (const line of lines) expect(visibleWidth(line)).toBe(50);
    const out = text(lines);
    expect(out).toContain("Plan");
    expect(out).not.toContain("# Plan");
    expect(out).toContain("Some bold and soft words.");
    expect(out).toContain("Steps");
    expect(out).not.toContain("## Steps");
    expect(out).toContain("Detail");
    expect(out).not.toContain("#"); // no heading level markers, at any level
    const styled = renderDocument("Some **bold** and *soft* words.", { taskId: 1, width: 50, theme: COLOR_THEME });
    expect(styled.join("")).toMatch(/\x1b\[[0-9;]*1m?[^\x1b]*bold/);
  });

  test("headings are distinct by level: H1 bold over a heavy rule, H2 bold over a light rule, H3+ bold accent", () => {
    const source = "# Plan\n\nBody text.\n\n## Steps\n\n### Detail\n\n#### Minor";
    const rows = plain(render(source, 40)).map(l => l.trimEnd());
    const at = (t: string) => rows.findIndex(r => r.trim() === t);
    expect(rows[at("Plan") + 1]).toMatch(/^ ━{38}$/); // the full content width
    expect(rows[at("Steps") + 1]).toMatch(/^ ─{38}$/);
    expect(rows[at("Detail") + 1]).toBe(""); // H3+: no rule, one blank row
    expect(rows[at("Minor") + 1] ?? "").toBe("");
    const lines = renderDocument(source, { taskId: 1, width: 40, theme: COLOR_THEME });
    // Headings use the md.heading token (not the body text color), bold; H3+ the accent, bold.
    expect(COLOR_THEME.colors["md.heading"]).not.toBe(COLOR_THEME.colors.text);
    expect(sgrBefore(lines, "Plan")).toBe(`${pairSgr("md.heading", "bg")};1`);
    expect(sgrBefore(lines, "━")).toBe(pairSgr("md.heading", "bg"));
    expect(sgrBefore(lines, "Body text.")).toBe(pairSgr("text", "bg"));
    expect(sgrBefore(lines, "Steps")).toBe(`${pairSgr("md.heading", "bg")};1`);
    expect(sgrBefore(lines, "───")).toBe(pairSgr("border", "bg"));
    expect(sgrBefore(lines, "Detail")).toBe(`${pairSgr("accent", "bg")};1`);
    expect(sgrBefore(lines, "Minor")).toBe(`${pairSgr("accent", "bg")};1`);
  });

  test("no raw Markdown markers leak into the rendered text of common constructs", () => {
    const source = [
      "# Title with `code`",
      "",
      "Some **bold**, __strong__, *soft*, _em_, ~~gone~~ and `inline` words with a [link](https://x.example/a).",
      "",
      "## Second",
      "",
      "- **bold item**",
      "- [ ] open task",
      "- [x] done task",
      "  1. nested *one*",
      "",
      "> quoted **strong** words",
      ">",
      "> > nested quote",
      "",
      "### Third",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "| **h** | `c` |",
      "| - | - |",
      "| [cell](https://x.example/c) | _i_ |",
      "",
      "***",
      "",
      "Setext heading",
      "--------------",
    ].join("\n");
    for (const theme of [PLAIN_THEME, COLOR_THEME]) {
      const out = text(renderDocument(source, { taskId: 1, width: 100, theme }));
      for (const marker of ["#", "**", "__", "`", "[", "](", ">", "~~", "***"]) expect(out).not.toContain(marker);
      for (const shown of ["Title with code", "Some bold, strong, soft, em, gone and inline words with a link."]) {
        expect(out).toContain(shown);
      }
      for (const shown of ["bold item", "☐ open task", "☑ done task", "1. nested one", "quoted strong words"]) {
        expect(out).toContain(shown);
      }
      expect(out).toContain("┃ ┃ nested quote");
      expect(out).toContain("Setext heading");
    }
  });

  test("code blocks sit on the raised panel across the block width with a language label; inline code is tinted", () => {
    const lines = renderDocument("Use `npm i` now.\n\n```sh\necho hi\n```", {
      taskId: 1,
      width: 40,
      theme: COLOR_THEME,
    });
    expect(sgrBefore(lines, "npm i")).toBe(pairSgr("md.code", "raised"));
    expect(sgrBefore(lines, "sh")).toBe(pairSgr("muted", "raised"));
    expect(sgrBefore(lines, "echo hi")).toBe(pairSgr("md.code", "raised"));
    const rows = plain(lines);
    const caption = rows.findIndex(r => r.includes("sh · :copy 1"));
    expect(rows[caption]).toMatch(/^ {3}sh · :copy 1/);
    expect(rows[caption + 1]).toMatch(/^ │ echo hi/);
    // The panel spans the content width: from the margin to the right margin, which stays on the page.
    const raised = `48;2;${rgb(COLOR_THEME.colors.raised)}`;
    const page = `48;2;${rgb(COLOR_THEME.colors.bg)}`;
    for (const row of [caption, caption + 1]) {
      const line = lines[row] ?? "";
      const runs = [...line.matchAll(/\x1b\[([0-9;]*)m([^\x1b]*)/g)].filter(m => (m[2] ?? "") !== "");
      expect(runs[0]?.[1]).toContain(page); // the margin
      expect(runs[runs.length - 1]?.[1]).toContain(page); // the right margin
      expect(runs[runs.length - 1]?.[2]).toBe(" ");
      const inner = runs.slice(1, -1);
      expect(inner.every(m => (m[1] ?? "").includes(raised))).toBe(true);
      expect(inner.reduce((n, m) => n + visibleWidth(m[2] ?? ""), 0)).toBe(38);
    }
  });

  test("block quotes show an accent bar and muted italic text; task items show ☐/☑ with a done style", () => {
    const lines = renderDocument("> quoted words\n\n- [ ] open one\n- [x] done one", {
      taskId: 1,
      width: 40,
      theme: COLOR_THEME,
    });
    expect(sgrBefore(lines, "┃")).toBe(pairSgr("accent", "bg"));
    expect(sgrBefore(lines, "quoted words")).toBe(`${pairSgr("md.quote", "bg")};3`);
    expect(sgrBefore(lines, "☐")).toBe(pairSgr("md.bullet", "bg"));
    expect(sgrBefore(lines, "open one")).toBe(pairSgr("text", "bg"));
    expect(sgrBefore(lines, "☑")).toBe(pairSgr("status.done", "bg"));
    expect(sgrBefore(lines, "done one")).toBe(pairSgr("muted", "bg"));
  });

  test("exactly one blank row separates blocks, inside list items and quotes too, never two", () => {
    const source = [
      "Intro paragraph.",
      "- item text",
      "  ```",
      "  code in item",
      "  ```",
      "- next item",
      "  - nested tight",
      "",
      "> # Quoted heading",
      "> quoted text",
      "",
      "",
      "",
      "After.",
    ].join("\n");
    const rows = plain(render(source, 50)).map(l => l.trimEnd());
    const at = (t: string) => rows.findIndex(r => r.includes(t));
    expect(rows[at("Intro paragraph.") + 1]).toBe("");
    expect(rows[at("• item text") + 1]).toBe(""); // a code block inside a tight item is set apart
    expect(rows[at("code in item") + 1]).toBe("");
    expect(rows[at("• next item") + 1]).toContain("◦ nested tight"); // a tight nested list is not
    expect(rows[at("Quoted heading") + 1]).toMatch(/^ ┃ ━+$/);
    expect(rows[at("Quoted heading") + 2]).toBe(" ┃");
    expect(rows[at("quoted text") + 1]).toBe("");
    expect(rows[at("quoted text") + 2]).toContain("After.");
    for (let i = 1; i < rows.length; i++) {
      const blank = (r: string | undefined) => r === undefined || r === "" || /^ [┃ ]*$/.test(r);
      expect(blank(rows[i]) && blank(rows[i - 1])).toBe(false);
    }
  });

  test("without color (NO_COLOR) the structure stays readable with bold, dim and underline only", () => {
    const lines = renderDocument(
      "# Head\n\n### Sub\n\n> quote\n\n- [x] done\n\n[link](https://x.example)\n\n```\ncode\n```",
      { taskId: 1, width: 40, theme: PLAIN_THEME },
    );
    const joined = lines.join("\n");
    expect(joined).not.toMatch(/\x1b\[[0-9;]*(38|48);/); // no color at all
    expect(sgrBefore(lines, "Head")).toBe("1");
    expect(sgrBefore(lines, "Sub")).toBe("1");
    expect(sgrBefore(lines, "link")).toBe("4");
    const out = text(lines);
    for (const shown of ["━━━━", "┃ quote", "☑ done", "│ code", "code · :copy 1"]) expect(out).toContain(shown);
  });

  test("paragraphs wrap at words to the width", () => {
    const out = plain(render("alpha beta gamma delta epsilon zeta eta theta iota kappa", 20)).map(l => l.trimEnd());
    expect(out.filter(l => l !== "")).toEqual([
      " alpha beta gamma",
      " delta epsilon zeta",
      " eta theta iota",
      " kappa",
    ]);
  });

  test("lists, nesting, ordered numbering and task checkboxes", () => {
    const out = text(
      render("- one\n- two\n  - nested\n    - deeper\n\n3. third\n4. fourth\n\n- [x] shipped\n- [ ] pending"),
    );
    expect(out).toContain("• one");
    expect(out).toContain("• two");
    expect(out).toContain("  ◦ nested");
    expect(out).toContain("    ▪ deeper");
    expect(out).toContain("3. third");
    expect(out).toContain("4. fourth");
    expect(out).toContain("☑ shipped");
    expect(out).toContain("☐ pending");
    // A wrapped item hangs under its text, not under its marker.
    const wrapped = plain(render("- [ ] alpha beta gamma delta epsilon", 20)).map(l => l.trimEnd());
    expect(wrapped.filter(l => l !== "")).toEqual([" ☐ alpha beta gamma", "   delta epsilon"]);
  });

  test("tables have borders, a header rule, alignment and wrapped cells", () => {
    const out = plain(render("| name | n |\n| :--- | --: |\n| alpha | 1 |\n| beta | 22 |"));
    const rows = out.map(l => l.trim()).filter(l => l !== "");
    expect(rows).toEqual([
      "┌───────┬────┐",
      "│ name  │  n │",
      "├───────┼────┤",
      "│ alpha │  1 │",
      "│ beta  │ 22 │",
      "└───────┴────┘",
    ]);
    const narrow = plain(render("| a long header cell | b |\n| - | - |\n| some long cell text here | x |", 24));
    for (const line of narrow) expect(visibleWidth(line)).toBe(24);
    expect(narrow.join("\n")).toContain("some");
  });

  test("code blocks keep their text and indentation, name the language and the :copy number; block quotes and rules", () => {
    const out = text(render("```sh\necho hi\n  indented\n```\n\n> quoted text\n> more\n\n---\n\n```\nplain\n```"));
    expect(out).toMatch(/^ {3}sh · :copy 1 *$/m);
    expect(out).toContain("│ echo hi");
    expect(out).toContain("│   indented");
    expect(out).toMatch(/^ {3}code · :copy 2 *$/m);
    expect(out).toContain("┃ quoted text more");
    expect(out).toMatch(/^ ─{20,} ◆ ─{20,} $/m); // a rule with a centered ornament
  });

  test("an untrusted fence label is never UI text: unknown labels say code", () => {
    const out = text(render("```<b>not-a-lang</b> extra\nx\n```"));
    expect(out).toMatch(/^ {3}code · :copy 1 *$/m);
    expect(out).not.toContain("not-a-lang");
  });

  test("links show only their text (the URL is the OSC 8 target and in :links); others say where they go; images are never fetched", () => {
    const out = text(
      render(
        "See [the docs](https://docs.example/a) and https://bare.example/x plus ![diagram](https://img.example/d.png)",
        120,
      ),
    );
    expect(out).toContain("See the docs and https://bare.example/x plus");
    expect(out).not.toContain("https://docs.example/a");
    expect(out).toContain("[image: diagram] (https://img.example/d.png)");
    const lines = renderDocument("[the docs](https://docs.example/a)", { taskId: 1, width: 60, theme: COLOR_THEME });
    expect(sgrBefore(lines, "the docs")).toBe(`${pairSgr("md.link", "bg")};4`);
    expect(lines.join("")).toContain("\x1b]8;;https://docs.example/a\x1b\\");
    // Destinations cortex does not open are never hyperlinks, so the text says where they point.
    const inert = text(render("[a](docs/readme.md) [b](#nowhere) [c](#task-1-here)\n\n## Here", 100));
    expect(inert).toContain("a (docs/readme.md · not a web link)");
    expect(inert).toContain("b (#nowhere · no such heading)");
    expect(inert).toMatch(/no such heading\) c *$/m); // a live heading link shows its text only
    expect(inert).not.toContain("§");
  });

  test("Mermaid draws as text art in its code panel; :copy keeps the source and the source line maps into the art", () => {
    const source = "```mermaid\ngraph TD; A[Alpha]-->B[Beta];\n```";
    const out = text(render(source));
    expect(out).toContain("mermaid · :copy 1");
    expect(out).toContain("│ Alpha │");
    expect(out).toContain("▼");
    expect(out).not.toContain("A[Alpha]-->B[Beta]");
    const doc = parseDocument(source, 1);
    expect(doc.codeBlocks[0]).toMatchObject({ mermaid: true, text: "graph TD; A[Alpha]-->B[Beta];\n" });
    const layout = layoutDocument(doc, 60);
    const [start, end] = layout.codeSpans[0] ?? [-1, -1];
    expect(rowOfSourceLine(layout, 2)).toBeGreaterThan(start);
    expect(rowOfSourceLine(layout, 2)).toBeLessThanOrEqual(end);
  });

  test("Mermaid that cannot be drawn shows its source and says why; a partly parsed diagram says partial", () => {
    const gantt = text(render("```mermaid\ngantt\n  title Plan\n  section A\n  t1 :a1, 2024-01-01, 3d\n```"));
    expect(gantt).toContain("mermaid source · :copy 1");
    expect(gantt).toContain("t1 :a1, 2024-01-01, 3d");
    const wide = "flowchart LR\n  A[Parse the source] --> B[Lay out the graph] --> C[Paint the rows]";
    const w = drawMermaid(wide)?.width ?? 0;
    expect(w).toBeGreaterThan(0);
    const fits = text(render(`\`\`\`mermaid\n${wide}\n\`\`\``, w + 4));
    expect(fits).toContain("mermaid · :copy 1");
    expect(fits).not.toContain("A[Parse the source]");
    const narrow = text(render(`\`\`\`mermaid\n${wide}\n\`\`\``, w + 3));
    expect(narrow).toContain(`mermaid source · :copy 1 · too wide to draw (${w} columns)`);
    expect(narrow).toContain("A[Parse the source]");
    expect(text(render("```mermaid\ngraph TD\n  A[Start --> B\n```"))).toContain("mermaid · partial · :copy 1");
  });

  test("a drawn diagram uses existing raised theme pairs, and every row is exactly the pane width", () => {
    const lines = renderDocument("```mermaid\ngraph TD\n  A[Alpha] --> B\n```", {
      taskId: 1,
      width: 60,
      theme: COLOR_THEME,
    });
    expect(sgrBefore(lines, "Alpha")).toBe(pairSgr("text", "raised"));
    expect(sgrBefore(lines, "▼")).toBe(pairSgr("accent", "raised"));
    expect(sgrBefore(lines, "┌")).toBe(pairSgr("border", "raised"));
    const wide = '```mermaid\ngraph LR\n  A["👨‍👩‍👧 family"] --> B["🇨🇦 flag"] --> C["中文 标签"]\n```';
    for (const theme of [PLAIN_THEME, COLOR_THEME]) {
      for (const width of [40, 80]) {
        for (const line of renderDocument(wide, { taskId: 1, width, theme })) expect(visibleWidth(line)).toBe(width);
      }
    }
  });

  test("HTML entities decode in prose but never in code", () => {
    const out = text(render("Tom &amp; Jerry &lt;3 &#x41;&#66; `a &amp; b`"));
    expect(out).toContain("Tom & Jerry <3 AB a &amp; b");
  });

  test("raw HTML is shown as text, never interpreted", () => {
    const out = text(render('<div onclick="x()">raw</div>\n\ninline <b>bold</b> tag'));
    expect(out).toContain('<div onclick="x()">raw</div>');
    expect(out).toContain("inline <b>bold</b> tag");
  });

  test("an empty document says so", () => {
    expect(text(render(""))).toContain("No description yet");
  });
});

// ---------- terminal safety (G5) ----------

describe("hostile text in every surface cannot issue terminal controls (N20, G5)", () => {
  const HOSTILE = [
    "\x1b]52;c;SGVsbG8=\x07", // OSC 52 clipboard write
    "\x1b]8;;https://evil.example\x1b\\", // OSC 8 hyperlink
    "\x1bP1$qm\x1b\\", // DCS
    "\x1b_Gi=1;AAAA\x1b\\", // APC (kitty graphics)
    "\x1b[2J\x1b[31m", // CSI
    "\x9b31m\x9d0;title\x07", // C1 CSI / OSC
    "\x07\x08\x00\x7f", // C0 + DEL
  ].join("");
  const surfaces: [string, string][] = [
    ["heading", `# Title ${HOSTILE}\n`],
    ["paragraph", `text ${HOSTILE} more`],
    ["link text", `[click ${HOSTILE}](https://ok.example)`],
    ["link destination", `[click](https://ok.example/${HOSTILE})`],
    ["autolink", `<https://ok.example/${HOSTILE}>`],
    ["image", `![alt ${HOSTILE}](https://img.example/${HOSTILE})`],
    ["inline code", `\`${HOSTILE}\``],
    ["code block", `\`\`\`\n${HOSTILE}\n\`\`\``],
    ["code fence label", `\`\`\`${HOSTILE}\nx\n\`\`\``],
    ["mermaid", `\`\`\`mermaid\n${HOSTILE}\n\`\`\``],
    ["mermaid diagram", `\`\`\`mermaid\ngraph TD\n  A["x ${HOSTILE}"] --> B\n\`\`\``],
    ["table", `| h ${HOSTILE} |\n| - |\n| c ${HOSTILE} |`],
    ["list", `- item ${HOSTILE}\n- [x] done ${HOSTILE}`],
    ["quote", `> quoted ${HOSTILE}`],
    ["html", `<div>${HOSTILE}</div>`],
    ["entity", "&#27;]52;c;SGVsbG8=&#7; &#x9b;31m &#155;"],
  ];
  for (const [name, source] of surfaces) {
    test(`${name}: only theme SGR and validated OSC 8 reach the terminal; controls are visible text`, () => {
      for (const theme of [PLAIN_THEME, COLOR_THEME]) {
        for (const sourceView of [false, true]) {
          const lines = renderDocument(source, { taskId: 1, width: 70, theme, sourceView });
          const rest = residue(lines);
          expect(rest).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
          for (const line of lines) expect(visibleWidth(line)).toBe(70);
          // The fence label is never shown rendered (unknown labels say "code"); the source view shows it.
          if (name !== "entity" && (name !== "code fence label" || sourceView)) expect(rest).toContain("^[");
        }
      }
    });
  }

  test("a hostile title or body in a heading never reaches the outline or completion unescaped", () => {
    const doc = parseDocument(`## A ${HOSTILE}`, 1);
    // Headings keep the raw text (callers escape); the slug is plain ASCII.
    expect(doc.headings[0]?.slug).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("only validated destinations become OSC 8 hyperlinks", () => {
  const links = (source: string) => {
    const lines = renderDocument(source, { taskId: 1, width: 100, theme: COLOR_THEME });
    return [...lines.join("").matchAll(/\x1b\]8;;([^\x1b]*)\x1b\\/g)].map(m => m[1]).filter(u => u !== "");
  };

  test("http, https and mailto links are OSC 8 hyperlinks with the normalized href", () => {
    expect(links("[a](https://Example.COM/path?q=1) <mailto:me@example.com> http://x.example")).toEqual([
      "https://example.com/path?q=1",
      "mailto:me@example.com",
      "http://x.example/",
    ]);
  });

  for (const [label, source] of [
    ["javascript:", "[x](javascript:alert(1))"],
    ["data:", "[x](data:text/html,<script>alert(1)</script>)"],
    ["vbscript:", "[x](vbscript:msgbox)"],
    ["file:", "[x](file:///etc/passwd)"],
    ["relative", "[x](docs/readme.md)"],
    ["credentials", "[x](https://user:pass@example.com)"],
    ["bidi override", "[x](https://exa\u202emple.com)"],
    ["zero-width", "[x](https://exa\u200bmple.com)"],
    ["an image", "![x](https://img.example/a.png)"],
    ["a fragment", "[x](#task-1-plan)"],
  ] as const) {
    test(`${label} is never linked; its destination is shown as text`, () => {
      expect(links(source)).toEqual([]);
      const out = text(renderDocument(source, { taskId: 1, width: 100, theme: PLAIN_THEME }));
      expect(out).toContain("x");
    });
  }
});

// ---------- references (prose only) ----------

describe("@id / #tag references in prose only; heading links (refs.ts/MarkdownView parity)", () => {
  test("refs are found in prose (headings, lists, quotes, tables) but NEVER inside code or link text", () => {
    const doc = parseDocument(
      [
        "See @42 for details and #bugs.",
        "",
        "```",
        "ignore @42 in code",
        "```",
        "",
        "And `inline @42` too, [link @7 #x](https://x.example), path@123, #BadTag.",
        "",
        "## Heading @5",
        "",
        "- item #ops",
        "",
        "> quote @6",
        "",
        "| @8 |",
        "| - |",
        "| #cell |",
      ].join("\n"),
      1,
    );
    const refs = doc.links.flatMap(l =>
      l.target.kind === "task" ? [`@${l.target.id}`] : l.target.kind === "tag" ? [`#${l.target.name}`] : [],
    );
    expect(refs).toEqual(["@42", "#bugs", "@5", "#ops", "@6", "@8", "#cell"]);
  });

  test("the rendered text keeps the refs as written", () => {
    const out = text(renderDocument("go to @42 now about #bugs", { taskId: 1, width: 60, theme: PLAIN_THEME }));
    expect(out).toContain("go to @42 now about #bugs");
  });

  test("following @id clears every filter and the search, selects it, and :back returns", () => {
    const h = harness([task(1, { body: "go to @42 now" }), task(42, { title: "the target" })], { initialTask: 1 });
    h.session.setQuery("go");
    h.session.setFilter({ status: "open", lane: "now", tags: ["x"] });
    frame(h);
    const ref = h.reader.links().find(l => l.target.kind === "task");
    if (ref === undefined) throw new Error("expected a task ref");
    h.reader.follow(ref.target);
    expect(h.session.selectedId).toBe(42);
    expect(h.session.query).toBe("");
    expect(h.session.filter).toEqual({ status: null, lane: null, tags: [] });
    h.session.back();
    expect(h.session.selectedId).toBe(1);
  });

  test("a ref to a missing task changes nothing and says why", () => {
    const h = harness([task(1, { body: "see @99" })], { initialTask: 1 });
    h.session.setFilter({ status: "open", lane: null, tags: [] });
    frame(h);
    const ref = h.reader.links()[0];
    if (ref === undefined) throw new Error("expected a ref");
    h.reader.follow(ref.target);
    expect(h.session.selectedId).toBe(1);
    expect(h.session.filter.status).toBe("open");
    expect(h.session.status?.text).toMatch(/@99/);
  });

  test("#tag replaces only the tag filter slot", () => {
    const h = harness([task(1, { body: "about #bugs today" })], { initialTask: 1 });
    h.session.setFilter({ status: "open", lane: "now", tags: ["old", "other"] });
    frame(h);
    const ref = h.reader.links()[0];
    if (ref === undefined) throw new Error("expected a ref");
    h.reader.follow(ref.target);
    expect(h.session.filter).toEqual({ status: "open", lane: "now", tags: ["bugs"] });
  });

  test("a heading link jumps to that heading (full web anchor or bare slug); a missing one says so", () => {
    const body = [
      "[to risks](#task-1-risks) [also](#risks) [nowhere](#task-1-nope)",
      "",
      ...filler(60),
      "## Risks",
      "",
      "the end",
    ].join("\n");
    const h = harness([task(1, { body })], { initialTask: 1 });
    frame(h, 80, 10);
    const [first, second, missing] = h.reader.links();
    expect(first?.target).toMatchObject({ kind: "heading", id: "task-1-risks" });
    expect(second?.target).toMatchObject({ kind: "heading", id: "task-1-risks" });
    expect(missing?.target).toMatchObject({ kind: "heading", id: null });
    if (!first || !missing) throw new Error("expected heading links");
    h.reader.follow(first.target);
    expect(plain(frame(h, 80, 10))[0]).toContain("Risks");
    h.reader.follow(missing.target);
    expect(h.session.status?.text).toMatch(/No heading #task-1-nope/);
  });
});

function filler(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `Paragraph ${i} of the filler text.\n`);
}

// ---------- the reader component ----------

describe("the reader component: scroll, headings, search and history", () => {
  const long = [
    "# Intro",
    "",
    ...filler(30),
    "## Middle",
    "",
    ...filler(30),
    "## Risks",
    "",
    "needle here",
    "",
    "## Risks",
    "",
    "needle again",
  ].join("\n");

  test("fills exactly its height and width, and renders the current draft text of the selected task", async () => {
    const h = harness([task(1, { body: "saved text" })], { initialTask: 1 });
    let lines = frame(h, 60, 12);
    expect(lines.length).toBe(12);
    for (const line of lines) expect(visibleWidth(line)).toBe(60);
    expect(text(lines)).toContain("saved text");
    h.session.setDocumentMode("split");
    await settle();
    const doc = h.session.documentOf(1);
    doc?.editor?.insert("**draft** ");
    lines = frame(h, 60, 12);
    expect(text(lines)).toContain("draft saved text");
    expect(text(lines)).not.toContain("**draft**");
  });

  test("search finds only the Mermaid view on screen: a drawn diagram's labels, else its source", () => {
    const source = "flowchart LR\n  A[Alpha] --> B[Beta]";
    const h = harness([task(1, { body: `\`\`\`mermaid\n${source}\n\`\`\`` })], { initialTask: 1 });
    frame(h, 80, 20);
    h.reader.search("Alpha");
    expect(h.reader.searchStatus()?.count).toBe(1);
    h.reader.search("-->");
    expect(h.reader.searchStatus()?.count).toBe(0);
    frame(h, (drawMermaid(source)?.width ?? 0) + 3, 20); // too narrow: the source shows instead
    expect(h.reader.searchStatus()?.count).toBe(1);
  });

  test("} and { step to the next and previous heading, with counts; at the ends they say so", () => {
    const h = harness([task(1, { body: long })], { initialTask: 1 });
    frame(h, 80, 10);
    h.reader.stepHeading(1);
    expect(plain(frame(h, 80, 10))[0]).toContain("Middle");
    h.reader.stepHeading(2);
    expect(plain(frame(h, 80, 10))[0]).toContain("Risks");
    expect(h.reader.section()?.heading?.id).toBe("task-1-risks-2");
    h.reader.stepHeading(1);
    expect(h.session.status?.text).toMatch(/No next heading/);
    h.reader.stepHeading(-3);
    expect(plain(frame(h, 80, 10))[0]).toContain("Intro");
    h.reader.stepHeading(-1);
    expect(h.session.status?.text).toMatch(/No previous heading/);
  });

  test("scrollPosition reports the last render's top row and the document's rows (the shell's scrollbar)", () => {
    const h = harness([task(1, { body: long })], { initialTask: 1 });
    expect(h.reader.scrollPosition()).toEqual({ top: 0, total: 0 }); // never rendered
    frame(h, 80, 10);
    const first = h.reader.scrollPosition();
    expect(first.top).toBe(0);
    expect(first.total).toBeGreaterThan(10);
    h.reader.stepHeading(1);
    frame(h, 80, 10);
    const moved = h.reader.scrollPosition();
    expect(moved.top).toBe(h.session.docScroll(1));
    expect(moved.top).toBeGreaterThan(0);
    expect(moved.total).toBe(first.total);
    const short = harness([task(1, { body: "one line" })], { initialTask: 1 });
    frame(short, 80, 10);
    expect(short.reader.scrollPosition().total).toBeLessThanOrEqual(10);
    const empty = harness([]);
    frame(empty, 80, 10);
    expect(empty.reader.scrollPosition()).toEqual({ top: 0, total: 0 });
  });

  test("the scroll position is kept per task and anchored to its heading across a re-wrap", () => {
    const h = harness([task(1, { body: long }), task(2, { body: "other" })], { initialTask: 1 });
    frame(h, 80, 10);
    h.reader.goToHeading("middle");
    expect(plain(frame(h, 80, 10))[0]).toContain("Middle");
    h.session.select(2);
    expect(text(frame(h, 80, 10))).toContain("other");
    h.session.select(1);
    expect(plain(frame(h, 80, 10))[0]).toContain("Middle");
    // A narrower pane wraps the filler into more rows: the heading stays on top.
    expect(plain(frame(h, 30, 10))[0]).toContain("Middle");
  });

  test(":heading jumps (duplicate slugs are numbered -2, -3) and :back/:forward include heading jumps", async () => {
    const h = harness([task(1, { body: long }), task(2, { body: "two" })], { initialTask: 1 });
    frame(h, 80, 10);
    await h.session.execute("heading risks-2");
    expect(plain(frame(h, 80, 10))[0]).toContain("Risks");
    expect(text(frame(h, 80, 10))).toContain("needle again");
    await h.session.execute("heading middle");
    expect(plain(frame(h, 80, 10))[0]).toContain("Middle");
    h.session.jump(2);
    h.session.back();
    expect(h.session.selectedId).toBe(1);
    expect(plain(frame(h, 80, 10))[0]).toContain("Middle");
    h.session.back();
    expect(text(frame(h, 80, 10))).toContain("needle again");
    h.session.back();
    expect(plain(frame(h, 80, 10))[0]).toContain("Intro");
    h.session.forward();
    expect(text(frame(h, 80, 10))).toContain("needle again");
    await h.session.execute("heading nope");
    expect(h.session.status?.text).toMatch(/No heading #nope in @1/);
  });

  test(":heading completes the slugs of the current document with what each names", () => {
    const h = harness([task(1, { body: long })], { initialTask: 1 });
    h.session.openPrompt(":", "heading ri");
    h.session.promptKey("tab");
    expect(h.session.prompt?.text).toBe("heading risks");
    expect(h.session.prompt?.completion?.candidates).toEqual(["heading risks", "heading risks-2"]);
    expect(h.session.describeCandidate("heading risks-2")).toBe("Risks");
  });

  test("/ searches the rendered text when the document has the focus; n/N step with wrap-around", async () => {
    const h = harness([task(1, { body: long }), task(2, { title: "needle in the list" })], { initialTask: 1 });
    frame(h, 80, 10);
    h.session.input("/");
    for (const ch of "NEEDLE") h.session.input(ch);
    h.session.input("\r");
    await settle();
    expect(h.session.query).toBe(""); // the task list was not filtered
    expect(h.reader.query).toBe("NEEDLE");
    expect(h.session.status?.text).toMatch(/1 of 2/);
    expect(text(frame(h, 80, 10))).toContain("needle here");
    // n / N (the shell's next_match/previous_match actions) step the document's matches while it has the focus.
    h.session.stepResult(1);
    expect(h.session.status?.text).toMatch(/2 of 2/);
    expect(text(frame(h, 80, 10))).toContain("needle again");
    h.session.stepResult(1);
    expect(h.session.status?.text).toMatch(/wrapped/);
    h.session.stepResult(-1);
    expect(h.session.status?.text).toMatch(/2 of 2/);
    // The task list still searches with / when it has the focus.
    h.session.setFocus("tasks");
    h.session.input("/");
    for (const ch of "needle") h.session.input(ch);
    h.session.input("\r");
    await settle();
    expect(h.session.query).toBe("needle");
  });

  test("matches are highlighted with the theme's search pair plus a non-color marker; the current one is marked", async () => {
    const h = harness([task(1, { body: "one needle and another needle" })], { initialTask: 1, theme: COLOR_THEME });
    h.reader.search("needle");
    const lines = frame(h, 80, 6);
    const joined = lines.join("\n");
    // cortex-dark's search surface #4d3f14 (77;63;20), underlined, twice.
    expect(joined.match(/48;2;77;63;20(;1)?;4m/g)?.length).toBe(2);
    expect(joined).toMatch(/48;2;77;63;20;1;4m/); // the current match is also bold
    expect(
      plain(lines)
        .find(l => l.includes("needle"))
        ?.startsWith("▸"),
    ).toBe(true);
    // Without color the matches stay visible (inverse + underline).
    const flat = harness([task(1, { body: "one needle" })], { initialTask: 1 });
    flat.reader.search("needle");
    expect(frame(flat, 80, 6).join("\n")).toMatch(/\x1b\[(1;)?4;7mneedle/);
  });

  test("a phrase broken by a soft wrap still matches", () => {
    const h = harness([task(1, { body: "aaaa bbbb cccc dddd target phrase ffff" })], { initialTask: 1 });
    const rows = plain(frame(h, 30, 6)).map(l => l.trim());
    expect(rows).toContain("aaaa bbbb cccc dddd target");
    h.reader.search("target phrase");
    expect(h.session.status?.text).toMatch(/1 of 1/);
    const lines = frame(h, 30, 6);
    expect(lines.join("\n").match(/\x1b\[(1;)?4;7m(target|phrase)/g)?.length).toBe(2);
  });

  test("an unmatched search says so; an empty one clears", () => {
    const h = harness([task(1, { body: "text" })], { initialTask: 1 });
    h.reader.search("zzz");
    expect(h.session.status?.text).toMatch(/No match for \/zzz/);
    h.reader.search("");
    expect(h.reader.query).toBe("");
    h.reader.step(1);
    expect(h.session.status?.text).toMatch(/No search/);
  });

  test(":source shows the raw source, escaped, and toggles back", async () => {
    const h = harness([task(1, { body: "# Plan\n\n**bold** \x1b]52;c;x\x07" })], { initialTask: 1 });
    await h.session.execute("source");
    let out = text(frame(h, 60, 8));
    expect(out).toContain("# Plan");
    expect(out).toContain("**bold** ^[]52;c;x^G");
    await h.session.execute("source");
    out = text(frame(h, 60, 8));
    expect(out).not.toContain("# Plan");
  });

  test("the launch --heading opens at that heading with the shared slugger; a missing one warns once", () => {
    const body = [
      "Intro",
      "=====",
      "",
      ...filler(40),
      "Risks",
      "-----",
      "",
      "first risks",
      "",
      "## Risks",
      "",
      "second risks",
    ].join("\n");
    const h = harness([task(1, { body })], { initialTask: 1, heading: "task-1-risks-2" });
    expect(text(frame(h, 80, 6))).toContain("second risks");
    expect(h.session.pendingHeading()).toBeNull();
    const missing = harness([task(1, { body })], { initialTask: 1, heading: "nope" });
    frame(missing, 80, 6);
    expect(missing.session.status?.text).toContain("No heading #nope in @1");
  });

  test("--heading and :heading from Edit show Read for that task only; the saved preference stays", async () => {
    const h = harness([task(1, { body: long })], { initialTask: 1 });
    h.session.setDocumentMode("edit");
    await h.session.execute("heading middle");
    expect(h.session.documentMode()).toBe("read");
    expect(h.session.preferredMode).toBe("edit");
    expect(plain(frame(h, 80, 10))[0]).toContain("Middle");
  });
});

// ---------- copy (explicit, OSC 52) ----------

describe("copy is an explicit command (OSC 52) and never a rendering effect", () => {
  test(":copy <n> writes the code block (its text plus a final newline) and reports the result as unconfirmed", async () => {
    const h = harness([task(1, { body: "```sh\necho one\n```\n\n```\ntwo\n```" })], { initialTask: 1 });
    frame(h);
    expect(h.clipboard).toEqual([]); // rendering never writes the clipboard
    await h.session.execute("copy 2");
    expect(h.clipboard).toEqual([`\x1b]52;c;${Buffer.from("two\n").toString("base64")}\x1b\\`]);
    expect(h.session.status?.text).toMatch(/Copied code block 2/);
    expect(h.session.status?.text).toMatch(/unconfirmed/);
    await h.session.execute("copy");
    expect(h.clipboard[1]).toBe(`\x1b]52;c;${Buffer.from("echo one\n").toString("base64")}\x1b\\`);
    await h.session.execute("copy 3");
    expect(h.session.status?.level).toBe("error");
    expect(h.session.status?.text).toMatch(/code block 3/);
  });

  test("without a terminal clipboard, or when too large, copying fails visibly", async () => {
    const h = harness([task(1, { body: "```\nx\n```" })], { initialTask: 1, clipboard: false });
    frame(h);
    await h.session.execute("copy 1");
    expect(h.session.status?.level).toBe("error");
    const big = harness([task(1, { body: `\`\`\`\n${"x".repeat(80_000)}\n\`\`\`` })], { initialTask: 1 });
    frame(big);
    await big.session.execute("copy 1");
    expect(big.session.status?.level).toBe("error");
    expect(big.session.status?.text).toMatch(/too large/);
    expect(big.clipboard).toEqual([]);
  });
});

// ---------- :links ----------

describe(":links lists the document's links and references; Enter follows", () => {
  test("the dialog lists refs, heading links and web links in order; Enter on @id jumps", async () => {
    const h = harness(
      [
        task(1, { body: "see @2 and #bugs, [risks](#task-1-risks), [site](https://x.example)\n\n## Risks" }),
        task(2, { title: "Other task" }),
      ],
      { initialTask: 1 },
    );
    frame(h);
    await h.session.execute("links");
    expect(h.session.dialog?.label).toBe("links");
    h.session.input("\r");
    await settle();
    expect(h.session.dialog).toBeNull();
    expect(h.session.selectedId).toBe(2);
  });

  test("a document without links says so", async () => {
    const h = harness([task(1, { body: "plain" })], { initialTask: 1 });
    frame(h);
    await h.session.execute("links");
    expect(h.session.dialog).toBeNull();
    expect(h.session.status?.text).toMatch(/No links/);
  });
});

// ---------- line numbers (tui.toml number) ----------

describe("line numbers: the source line of each block in a gutter (tui.toml number)", () => {
  const SOURCE = [
    "# Title",
    "",
    "A paragraph that is long enough to wrap onto more rows here.",
    "",
    "```sh",
    "one",
    "two",
    "```",
    "",
    "- item one",
    "- item two",
    "",
    "| h | v |",
    "| - | - |",
    "| a | 1 |",
  ].join("\n");

  test("each block's first row shows its source line, every code line its own; continuation rows are blank", () => {
    const rows = plain(renderDocument(SOURCE, { taskId: 1, width: 40, theme: PLAIN_THEME, numbers: true }));
    for (const row of rows) expect(visibleWidth(row)).toBe(40);
    const at = (t: string) => rows.find(r => r.includes(t)) ?? "";
    expect(at("Title")).toMatch(/^ {2}1 {2}Title/);
    expect(rows[1]).toMatch(/^ {5}━+/); // the rule under a heading has no number
    expect(at("A paragraph")).toMatch(/^ {2}3 {2}A paragraph/);
    expect(at("rows here.")).toMatch(/^ {5}\S/); // the wrapped row
    expect(at("sh · :copy 1")).toMatch(/^ {2}5 {4}sh/);
    expect(at("│ one")).toMatch(/^ {2}6 {2}│ one/);
    expect(at("│ two")).toMatch(/^ {2}7 {2}│ two/);
    expect(at("item one")).toMatch(/^ 10 {2}• item one/);
    expect(at("item two")).toMatch(/^ 11 {2}• item two/);
    expect(at("│ h ")).toMatch(/^ 13 /);
    expect(at("│ a ")).toMatch(/^ 15 /);
    expect(rows.filter(r => r.startsWith("    ") && r.trim() === "").length).toBeGreaterThan(0); // gaps stay blank
    // Numbers are dim, never a color alone.
    const styled = renderDocument(SOURCE, { taskId: 1, width: 40, theme: COLOR_THEME, numbers: true });
    expect(sgrBefore(styled, "  1")).toBe(pairSgr("dim", "bg"));
    // :source numbers every source line.
    const source = plain(
      renderDocument(SOURCE, { taskId: 1, width: 40, theme: PLAIN_THEME, numbers: true, sourceView: true }),
    );
    expect(source[0]).toMatch(/^ {2}1 {2}# Title/);
    expect(source[1]?.trim()).toBe("2"); // a blank source line is one row
    expect(source[2]).toMatch(/^ {2}3 {2}A paragraph/);
    expect(source.find(r => r.includes("```sh"))).toMatch(/^ {2}5 {2}```sh/);
  });

  test(":config number toggles the gutter in Read at once and saves it as tui.toml's number", async () => {
    const h = harness([task(1, { body: SOURCE })], { initialTask: 1 });
    expect(h.session.lineNumbers).toBe(false);
    expect(plain(frame(h, 60, 10))[0]).toMatch(/^ Title/);
    await h.session.execute("config number");
    expect(h.session.lineNumbers).toBe(true);
    expect(plain(frame(h, 60, 10))[0]).toMatch(/^ {2}1 {2}Title/);
    expect(loadConfig(path.join(dir, "tui.toml")).config.number).toBe(true);
    await h.session.execute("config number false");
    expect(plain(frame(h, 60, 10))[0]).toMatch(/^ Title/);
    await h.session.execute("config number default");
    expect(h.session.lineNumbers).toBe(false);
    expect(fs.readFileSync(path.join(dir, "tui.toml"), "utf8")).toBe("");
  });
});

// ---------- the Split preview follows the editor ----------

describe("the Split preview follows the editor's cursor line", () => {
  test("rowOfSourceLine maps a source line to the rendered row of its block (code lines exactly)", () => {
    const source = ["# Title", "", "para line one", "para line two", "", "```", "a", "b", "c", "```", "", "tail"].join(
      "\n",
    );
    const layout = layoutDocument(parseDocument(source, 1), 40);
    const rows = plain(renderDocument(source, { taskId: 1, width: 40, theme: PLAIN_THEME }));
    const row = (t: string) => rows.findIndex(r => r.includes(t));
    expect(rowOfSourceLine(layout, 1)).toBe(row("Title"));
    expect(rowOfSourceLine(layout, 2)).toBe(row("Title")); // the blank line belongs to the block above
    expect(rowOfSourceLine(layout, 3)).toBe(row("para line one"));
    expect(rowOfSourceLine(layout, 4)).toBe(row("para line one")); // one rendered row for two source lines
    expect(rowOfSourceLine(layout, 7)).toBe(row("│ a"));
    expect(rowOfSourceLine(layout, 9)).toBe(row("│ c"));
    expect(rowOfSourceLine(layout, 12)).toBe(row("tail"));
    expect(rowOfSourceLine(layout, 99)).toBe(row("tail"));
    expect(rowOfSourceLine(layout, 0)).toBe(0);
    // A long paragraph spread over many source lines: a later line lands on a later row of its block.
    const long = Array.from({ length: 20 }, (_, i) => `word${i} and more text to wrap`).join("\n");
    const spread = layoutDocument(parseDocument(long, 1), 30);
    expect(rowOfSourceLine(spread, 20)).toBeGreaterThan(rowOfSourceLine(spread, 1) + 5);
  });

  test("the preview aligns the cursor line's block with the editor's cursor row; a manual scroll detaches it until the cursor moves", () => {
    const body = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");
    const h = harness([task(1, { body })], { initialTask: 1 });
    // Paragraph n is on source line 2n - 1.
    h.reader.editorCursor = { line: 101, row: 3, anchor: "cursor-a" };
    let rows = plain(frame(h, 60, 10));
    expect(rows[3]).toContain("Paragraph 51.");
    // The user scrolls the preview: it stays there while the editor's cursor does not move.
    h.session.scrollDocument(-6);
    rows = plain(frame(h, 60, 10));
    expect(rows[3]).toContain("Paragraph 48.");
    rows = plain(frame(h, 60, 10));
    expect(rows[3]).toContain("Paragraph 48.");
    // A jump in the preview (a heading, a search) detaches it the same way.
    h.reader.search("Paragraph 20.");
    rows = plain(frame(h, 60, 10));
    expect(rows.join("\n")).toContain("Paragraph 20.");
    // The cursor moves (a new editor state): the preview follows it again.
    h.reader.editorCursor = { line: 159, row: 9, anchor: "cursor-b" };
    rows = plain(frame(h, 60, 10));
    expect(rows[9]).toContain("Paragraph 80.");
    h.reader.editorCursor = { line: 3, row: 0, anchor: "cursor-c" };
    rows = plain(frame(h, 60, 10));
    expect(rows[0]).toContain("Paragraph 2.");
    // Read (no editor to follow) keeps its own scroll.
    h.reader.editorCursor = null;
    h.session.scrollDocument(4);
    expect(plain(frame(h, 60, 10))[0]).toContain("Paragraph 4.");
  });
});

// ---------- VISUAL: selecting the rendered text ----------

describe("VISUAL in the rendered document (Read, the Split preview): v by characters, V by rendered rows", () => {
  const SEL = "\x1b[7m";
  const body = "- one item\n- two item\n\nA **bold** paragraph.";

  test("V selects rendered rows from the top of the view; motions extend it; the text is the rows' visible characters", () => {
    const h = harness([task(1, { body })], { initialTask: 1 });
    frame(h, 40, 10);
    expect(h.reader.selecting()).toBeNull();
    expect(h.reader.selectedText()).toBeNull();
    expect(h.reader.select("line")).toBe(true);
    expect(h.reader.selecting()).toBe("line");
    expect(h.reader.selectedText()).toEqual({ text: "• one item\n", linewise: true, rows: 1 });
    h.reader.moveCursor("down");
    expect(h.reader.selectedText()).toEqual({ text: "• one item\n• two item\n", linewise: true, rows: 2 });
    h.reader.moveCursor("down", 2);
    expect(h.reader.selectedText()?.text).toBe("• one item\n• two item\n\nA bold paragraph.\n");
    const lines = frame(h, 40, 10);
    // The selection pair PLUS inverse (it shows without color); the cursor is an underlined hole; text unchanged.
    expect(lines[0]).toContain(`${SEL}one item\x1b[0m`);
    expect(lines[2]).toContain(`${SEL} \x1b[0m`); // the blank row between blocks shows one selected cell
    expect(lines[3]).toContain("\x1b[4mA\x1b[0m");
    expect(plain(lines)[3]).toBe(" A bold paragraph.                      ");
    for (const line of lines) expect(visibleWidth(line)).toBe(40);
    h.reader.moveCursor("top");
    expect(h.reader.selectedText()?.rows).toBe(1);
    h.reader.endSelection();
    expect(h.reader.selecting()).toBeNull();
    expect(frame(h, 40, 10).join("")).not.toContain(SEL);
  });

  test("v selects characters: w/e/$ and j/k/h/l/0 move its cursor; o swaps the ends; rows join with line breaks", () => {
    const h = harness([task(1, { body })], { initialTask: 1 });
    frame(h, 40, 10);
    h.reader.select("char");
    expect(h.reader.selectedText()).toEqual({ text: "•", linewise: false, rows: 1 });
    h.reader.moveCursor("word-next");
    expect(h.reader.selectedText()?.text).toBe("• o");
    h.reader.moveCursor("word-end");
    expect(h.reader.selectedText()?.text).toBe("• one");
    h.reader.moveCursor("line-end");
    expect(h.reader.selectedText()?.text).toBe("• one item");
    h.reader.moveCursor("down");
    expect(h.reader.selectedText()).toEqual({ text: "• one item\n• two item", linewise: false, rows: 2 });
    h.reader.moveCursor("left", 5);
    expect(h.reader.selectedText()?.text).toBe("• one item\n• two");
    h.reader.swapSelectionEnds();
    h.reader.moveCursor("right", 2);
    expect(h.reader.selectedText()?.text).toBe("one item\n• two");
    h.reader.moveCursor("word-prev");
    expect(h.reader.selectedText()?.text).toBe("• one item\n• two");
    h.reader.select("line"); // V switches the kind in place
    expect(h.reader.selectedText()?.text).toBe("• one item\n• two item\n");
    const lines = frame(h, 40, 10);
    expect(lines[0]).toContain("\x1b[4m•\x1b[0m"); // the cursor (0, 0)
  });

  test("hostile text stays escaped: the copied text is the visible characters, never a control byte", () => {
    const hostile = "danger \x1b]52;c;SGVsbG8=\x07 \x1b[31mred\x9b [link](https://ok.example)";
    const h = harness([task(1, { body: hostile })], { initialTask: 1 });
    frame(h, 80, 10);
    h.reader.select("line");
    const copied = h.reader.selectedText()?.text ?? "";
    expect(copied).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    expect(copied).toContain("^[]52;c;SGVsbG8=^G");
    expect(copied).toContain("<U+009B>");
    expect(copied).toContain("link"); // a link's text, never its OSC 8 wrapper
    expect(copied).not.toContain("https://ok.example");
    const lines = frame(h, 80, 10);
    expect(residue(lines)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  });

  test("motions keep the cursor row on screen (the view scrolls)", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Line ${i}`).join("\n\n");
    const h = harness([task(1, { body: long })], { initialTask: 1 });
    frame(h, 40, 10);
    h.reader.select("line");
    h.reader.moveCursor("down", 25);
    expect(h.session.docScroll(1)).toBe(16);
    expect(text(frame(h, 40, 10))).toContain("Line 12");
    h.reader.moveCursor("half-up");
    expect(h.reader.selectedText()?.rows).toBe(21);
    h.reader.moveCursor("top");
    expect(h.session.docScroll(1)).toBe(0);
    h.reader.moveCursor("bottom");
    expect(h.reader.selectedText()?.rows).toBe(79);
  });

  test("the selection belongs to its task and layout: a re-wrap, another task or a click ends it", () => {
    const h = harness([task(1, { body }), task(2, { body: "other" })], { initialTask: 1 });
    frame(h, 40, 10);
    h.reader.select("char");
    frame(h, 30, 10); // a resize re-wraps the document
    expect(h.reader.selecting()).toBeNull();
    frame(h, 40, 10);
    h.reader.select("line");
    h.session.select(2);
    expect(h.reader.selecting()).toBeNull();
    h.session.select(1);
    frame(h, 40, 10);
    h.reader.select("line");
    h.reader.handleMouse({ type: "click", button: "left", x: 30, y: 5 } as never);
    expect(h.reader.selecting()).toBeNull();
  });
});

describe("the mouse in the rendered document (the shell routes presses and drags here)", () => {
  test("pointAt maps a cell to a rendered row and a cluster of its text (the margin first), clamped to the rows on screen", () => {
    const h = harness([task(1, { body: "Some 日本 text\n\nnext" })], { initialTask: 1 });
    const lines = frame(h, 40, 6).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
    const y = lines.findIndex(l => l.includes("Some"));
    const x = (lines[y] ?? "").indexOf("Some");
    expect(h.reader.pointAt(x, y)).toEqual({ row: y, col: 0 });
    expect(h.reader.pointAt(0, y)).toEqual({ row: y, col: 0 }); // the margin: the first cluster
    expect(h.reader.pointAt(x + 6, y)).toEqual({ row: y, col: 5 }); // the second cell of 日
    expect(h.reader.pointAt(x + 7, y)).toEqual({ row: y, col: 6 });
    expect(h.reader.pointAt(x + 30, y)?.col).toBe("Some 日本 text".length - 1); // past the text: its last cluster
    expect(h.reader.pointAt(x, 99)?.row).toBeLessThan(6);
  });

  test("selectRange and selectWord make the VISUAL that y copies, on the current layout", () => {
    const h = harness([task(1, { body: "alpha beta gamma" })], { initialTask: 1 });
    const lines = frame(h, 40, 6).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
    const y = lines.findIndex(l => l.includes("alpha"));
    const x = (lines[y] ?? "").indexOf("beta");
    const anchor = h.reader.pointAt(x, y);
    const cursor = h.reader.pointAt(x + "beta gamm".length, y);
    expect(anchor).not.toBeNull();
    expect(h.reader.selectRange("char", cursor as never, anchor as never)).toBe(true);
    expect(h.reader.selecting()).toBe("char");
    expect(h.reader.selectedText()).toEqual({ text: "beta gamma", linewise: false, rows: 1 });
    expect(h.reader.selectWord(h.reader.pointAt(x + 1, y) as never)).toBe(true);
    expect(h.reader.selectedText()?.text).toBe("beta");
    expect(h.reader.selectRange("line", anchor as never, anchor as never)).toBe(true);
    expect(h.reader.selectedText()).toEqual({ text: "alpha beta gamma\n", linewise: true, rows: 1 });
  });
});

describe("the reading cursor (Read, the focused Split preview): painted while the reader has the keyboard", () => {
  const MARK = CURSOR_MARKER;
  const body = "- one item\n- two item\n\nA **bold** paragraph with [a link](https://ok.example).";
  const markers = (lines: readonly string[]) => lines.join("\n").split(MARK).length - 1;

  test("focused: one inverse cell behind the cursor marker; unfocused: none; rows keep their width", () => {
    const h = harness([task(1, { body })], { initialTask: 1 });
    expect(markers(frame(h, 40, 10))).toBe(0);
    h.reader.focused = true;
    const lines = frame(h, 40, 10);
    expect(markers(lines)).toBe(1);
    expect(lines[0]).toContain(`${MARK}\x1b[7m•\x1b[0m`);
    expect(h.reader.cursor()).toEqual({ row: 0, col: 0 });
    for (const line of lines) expect(visibleWidth(line.replace(MARK, ""))).toBe(40);
  });

  test("motions move it (counts, words, line ends, ends of the document); v then selects from it", () => {
    const h = harness([task(1, { body })], { initialTask: 1 });
    h.reader.focused = true;
    frame(h, 40, 10);
    h.reader.moveCursor("down");
    h.reader.moveCursor("word-next");
    expect(h.reader.cursor()).toEqual({ row: 1, col: 2 });
    h.reader.moveCursor("line-end");
    expect(h.reader.cursor()).toEqual({ row: 1, col: 9 });
    h.reader.select("char");
    h.reader.moveCursor("word-prev");
    expect(h.reader.selectedText()?.text).toBe("item");
    h.reader.endSelection();
    expect(h.reader.cursor()).toEqual({ row: 1, col: 6 }); // Esc keeps the cursor where the selection's end was
    h.reader.moveCursor("bottom");
    expect(h.reader.cursor()?.col).toBe(0);
    h.reader.moveCursor("top");
    expect(h.reader.cursor()).toEqual({ row: 0, col: 0 });
  });

  test("the marker never lands inside a link: the cursor's cell leaves the OSC 8 wrapper, the rest stays linked", () => {
    const h = harness([task(1, { body })], { initialTask: 1 });
    h.reader.focused = true;
    frame(h, 80, 10);
    h.reader.moveCursor("down", 3);
    for (let i = 0; i < 5; i++) h.reader.moveCursor("word-next");
    const lines = frame(h, 80, 10);
    const row = lines[3] ?? "";
    expect(h.reader.cursor()).toEqual({ row: 3, col: 24 }); // the "l" of "a link"
    expect(row).toContain(`\x1b]8;;\x1b\\${MARK}`); // the link closes before the marker
    expect(row.split("\x1b]8;;https://ok.example/").length - 1).toBe(2); // and opens again after the cursor's cell
    expect(plain([row.replace(MARK, "")])[0]).toContain("a link");
    expect(residue([row.replace(MARK, "")])).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  });

  test("a scroll it did not make keeps it on screen; a heading jump and a search match place it", () => {
    const long = [
      "# Top",
      "",
      ...Array.from({ length: 30 }, (_, i) => `Line ${i} text`),
      "## Tail",
      "",
      "the needle end",
    ].join("\n\n");
    const h = harness([task(1, { body: long })], { initialTask: 1 });
    h.reader.focused = true;
    frame(h, 40, 10);
    h.session.scrollDocument(20);
    frame(h, 40, 10);
    expect(h.reader.cursor()?.row).toBe(20);
    h.reader.stepHeading(1);
    frame(h, 40, 10);
    expect(h.reader.cursor()?.row).toBe(h.session.docScroll(1));
    h.reader.stepHeading(-1);
    h.reader.search("needle");
    const lines = frame(h, 40, 10);
    expect(h.reader.cursor()?.col).toBe(4);
    expect(plain(lines).find(l => l.includes("needle"))).toBeDefined();
    const before = h.session.docScroll(1);
    const row = h.reader.cursor()?.row ?? 0;
    h.reader.moveCursor("half-up"); // as vi's Ctrl-u: the view scrolls as far as the cursor moves
    expect(h.reader.cursor()?.row).toBe(row - 5);
    expect(h.session.docScroll(1)).toBe(before - 5);
  });

  test("a re-wrap keeps its row on screen; another task starts a new one on the top row on screen", () => {
    const h = harness([task(1, { body }), task(2, { body: "other" })], { initialTask: 1 });
    h.reader.focused = true;
    frame(h, 40, 10);
    h.reader.moveCursor("down", 3);
    frame(h, 30, 10);
    expect(h.reader.cursor()?.row).toBe(3);
    h.session.select(2);
    frame(h, 40, 10);
    expect(h.reader.cursor()).toEqual({ row: 0, col: 0 });
  });
});

describe("one cursor for Read, Edit and Split: the reading cursor maps to the body text and back", () => {
  /** Show `source` (as the shell does for a following reader), then the cursor's place. */
  const shown = (h: Harness, source: number, width = 40): { row: number; col: number } | null => {
    h.reader.syncSource = source;
    frame(h, width, 12);
    h.reader.syncSource = null;
    return h.reader.cursor();
  };

  test("cursorSource is the offset of the character under the cursor; markup and decoration are skipped", () => {
    const body = "alpha **beta** gamma\n\n- item\n  continues\n- two";
    const h = harness([task(1, { body })], { initialTask: 1 });
    frame(h, 40, 12);
    expect(h.reader.cursorSource()).toBe(0);
    h.reader.moveCursor("word-next");
    expect(h.reader.cursorSource()).toBe(body.indexOf("beta"));
    h.reader.moveCursor("line-end");
    expect(h.reader.cursorSource()).toBe(body.indexOf("gamma") + 4);
    h.reader.placeCursor({ row: 2, col: 0 }); // the bullet: the item's text
    expect(h.reader.cursorSource()).toBe(body.indexOf("item"));
    h.reader.placeCursor({ row: 2, col: 7 }); // "continues" after the soft break and its indent
    expect(h.reader.cursorSource()).toBe(body.indexOf("continues"));
    h.reader.placeCursor({ row: 3, col: 2 });
    expect(h.reader.cursorSource()).toBe(body.indexOf("two"));
    h.reader.placeCursor({ row: 1, col: 0 }); // the blank row between the blocks: the line after the paragraph
    expect(h.reader.cursorSource()).toBe(body.indexOf("\n\n") + 1);
  });

  test("a body offset shows at its character: markup goes to the text after it, a blank line to its row", () => {
    const body = "alpha **beta** gamma\n\n- item\n  continues\n- two";
    const h = harness([task(1, { body })], { initialTask: 1 });
    frame(h, 40, 12);
    expect(shown(h, body.indexOf("gamma"))).toEqual({ row: 0, col: 11 });
    expect(shown(h, body.indexOf("**"))).toEqual({ row: 0, col: 6 }); // the opening markup: "beta"
    expect(shown(h, body.indexOf("** gamma"))).toEqual({ row: 0, col: 10 }); // the closing markup: the space after it
    expect(shown(h, body.indexOf("continues"))).toEqual({ row: 2, col: 7 });
    expect(shown(h, body.indexOf("- two"))).toEqual({ row: 3, col: 0 }); // the marker: its row
    expect(shown(h, body.indexOf("two"))).toEqual({ row: 3, col: 2 });
    expect(shown(h, body.indexOf("\n\n") + 1)).toEqual({ row: 0, col: 0 }); // the blank line belongs to the block above
    expect(shown(h, body.length + 50)).toEqual({ row: 3, col: 4 }); // past the end: the last character
  });

  test("every visible character of a rich paragraph round-trips (emphasis, code, a link)", () => {
    const body = "alpha **beta** _gamma_ `code` [link](https://x.example) end";
    const h = harness([task(1, { body })], { initialTask: 1 });
    const lines = plain(frame(h, 80, 6));
    const width = (lines[0] ?? "").trimEnd().length - 1; // the margin cell, then the text
    expect(width).toBe("alpha beta gamma code link end".length);
    for (let col = 0; col < width; col++) {
      h.reader.placeCursor({ row: 0, col });
      const source = h.reader.cursorSource() ?? -1;
      expect(source).toBeGreaterThanOrEqual(0);
      expect(shown(h, source, 80)).toEqual({ row: 0, col });
    }
    h.reader.placeCursor({ row: 0, col: 22 }); // the "l" of link
    expect(h.reader.cursorSource()).toBe(body.indexOf("link"));
  });

  test("code lines, table cells, quotes and the source view map by line and column", () => {
    const body =
      "```js\nconst x = 1;\n  indented();\n```\n\n| a | bb |\n|---|---|\n| c | dd |\n\n> quoted *text*\n> more";
    const h = harness([task(1, { body })], { initialTask: 1 });
    const rows = plain(frame(h, 60, 16));
    const codeRow = rows.findIndex(l => l.includes("const x"));
    const ddRow = rows.findIndex(l => l.includes("dd"));
    const quoteRow = rows.findIndex(l => l.includes("quoted"));
    expect(shown(h, body.indexOf("x = 1"), 60)).toEqual({ row: codeRow, col: 2 + "const ".length });
    expect(shown(h, body.indexOf("indented"), 60)).toEqual({ row: codeRow + 1, col: 2 + 2 });
    h.reader.placeCursor({ row: codeRow, col: 0 }); // the code bar: the line's first character
    expect(h.reader.cursorSource()).toBe(body.indexOf("const"));
    expect(shown(h, body.indexOf("dd"), 60)).toEqual({ row: ddRow, col: 6 });
    h.reader.placeCursor({ row: ddRow, col: 0 }); // the table border: the row's first cell
    expect(h.reader.cursorSource()).toBe(body.indexOf("c |"));
    expect(shown(h, body.indexOf("more"), 60)).toEqual({ row: quoteRow, col: 2 + "quoted text ".length });
    h.reader.placeCursor({ row: quoteRow, col: 0 }); // the quote bar
    expect(h.reader.cursorSource()).toBe(body.indexOf("quoted"));
    // :source shows the raw lines: each row is its line.
    h.reader.toggleSource();
    frame(h, 60, 16);
    const at = body.indexOf("indented");
    expect(shown(h, at, 60)).toEqual({ row: 2, col: 2 });
    h.reader.placeCursor({ row: 2, col: 4 });
    expect(h.reader.cursorSource()).toBe(at + 2);
  });

  test("CRLF bodies map through the raw offsets; an empty body maps to 0", () => {
    const h = harness([task(1, { body: "ab\r\ncd" }), task(2, { body: "" })], { initialTask: 1 });
    frame(h, 40, 6);
    h.reader.placeCursor({ row: 0, col: 3 }); // "c" of the soft-broken paragraph "ab cd"
    expect(h.reader.cursorSource()).toBe(4);
    expect(shown(h, 4)).toEqual({ row: 0, col: 3 });
    expect(shown(h, 2)).toEqual({ row: 0, col: 2 }); // the CR: the break's space
    h.session.select(2);
    frame(h, 40, 6);
    expect(h.reader.cursorSource()).toBe(0);
    expect(shown(h, 0)).toEqual({ row: 0, col: 0 });
  });

  test("a synced offset is shown once per value and layout (a clamp keeps); a value this reader reported is a no-op", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Line ${i} text`).join("\n\n");
    const h = harness([task(1, { body: long })], { initialTask: 1 });
    frame(h, 40, 10);
    const at = long.indexOf("Line 30");
    h.reader.syncSource = at;
    frame(h, 40, 10);
    expect(h.reader.cursor()?.row).toBe(60);
    expect(h.session.docScroll(1)).toBeGreaterThan(0); // revealed: the row is on screen
    h.reader.moveCursor("up", 2); // as a clamp would: the same value does not pull the cursor back
    frame(h, 40, 10);
    expect(h.reader.cursor()?.row).toBe(58);
    h.reader.syncSource = long.indexOf("Line 20");
    frame(h, 40, 10);
    expect(h.reader.cursor()?.row).toBe(40);
    h.reader.syncSource = at; // a different value again: shown again
    frame(h, 40, 10);
    expect(h.reader.cursor()?.row).toBe(60);
    // Leading: the cursor on a bullet reports the item's text; following that report back must not move it.
    const h2 = harness([task(1, { body: "- item" })], { initialTask: 1 });
    frame(h2, 40, 10);
    h2.reader.syncSource = null;
    const reported = h2.reader.cursorSource() ?? -1;
    expect(reported).toBe(2);
    h2.reader.syncedTo(reported);
    h2.reader.syncSource = reported;
    frame(h2, 40, 10);
    expect(h2.reader.cursor()).toEqual({ row: 0, col: 0 });
  });
});

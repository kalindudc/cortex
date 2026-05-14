import path from "node:path";
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Store } from "../../src/store.ts";
import { startServer, type ServerHandle } from "../../src/server.ts";

let store: Store;
let h: ServerHandle;

beforeAll(() => {
  store = Store.open(":memory:");
  h = startServer({ port: 0, store });
});

afterAll(async () => {
  await h.stop();
  store.close();
});

const j = async (path: string, init?: RequestInit) => {
  const r = await fetch(`${h.url}${path}`, init);
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, ct: r.headers.get("content-type") ?? "" };
};

describe("UI: served assets (bundled)", () => {
  test("GET / returns the HTML shell linking the bundle css + module entry", async () => {
    const r = await fetch(`${h.url}/`);
    const t = await r.text();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toMatch(/text\/html/);
    expect(r.headers.get("cache-control") ?? "").toMatch(/no-store/);
    expect(t).toContain("<title>cortex</title>");
    expect(t).toContain('href="/bundle.css"');
    expect(t).toContain('src="/bundle.js"');
    expect(t).toContain('type="module"');
  });

  test("GET /bundle.css serves the bundled CSS with stable selectors", async () => {
    const r = await fetch(`${h.url}/bundle.css`);
    const t = await r.text();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toMatch(/text\/css/);
    expect(r.headers.get("cache-control") ?? "").toMatch(/no-store/);
    // Stable tokens / classes that the dashboard depends on. If any of
    // these vanish, scripts/build-css.sh dropped a slice from styles/.
    expect(t).toMatch(/--accent:\s*#?[0-9a-f]{3,6};/i);
    expect(t).toContain(".md-editor");
    expect(t).toContain(".pane-active");
    expect(t).toContain(".tooltip");
    // Unified-sidebar guard: the four classes below ship from the new
    // SidebarPane / FilterChips / SectionHeader / StatusBar bundle. If any
    // disappear, scripts/build-css.sh dropped a slice from styles/.
    expect(t).toContain(".sidebar-pane");
    expect(t).toContain(".status-bar");
    expect(t).toContain(".filter-chip");
    expect(t).toContain(".section-toggle");
  });

  test("GET /bundle.js serves the bundled JS with the preact runtime baked in", async () => {
    const r = await fetch(`${h.url}/bundle.js`);
    const t = await r.text();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toMatch(/javascript/);
    expect(r.headers.get("cache-control") ?? "").toMatch(/no-store/);
    // "preact" survives Bun's minifier (it's referenced as a module name in
    // sourcemap comments + identifier-bearing strings). If it ever stops
    // being a stable substring, fall back to asserting bundle size > 50 KB.
    expect(t).toContain("preact");
    expect(t.length).toBeGreaterThan(50_000);
  });
});

describe("UI: source-level lint guards (caught by tests, not Biome)", () => {
  // Bug class this test guards against:
  //   <input placeholder="Post an update\u2026"/>   ← bug: shows literal `\u2026`
  //   <input placeholder="Post an update…"/>      ← fix: actual ellipsis char
  //
  // JSX attribute strings are NOT JavaScript string literals. JS string
  // literals process backslash escapes (`\u2026` -> U+2026). JSX attribute
  // strings are the raw text between the quotes — every character is
  // emitted verbatim to the rendered DOM. So an attribute like
  // `placeholder="foo\u2026"` ships the 7 literal characters `f o o \ u 2 0 2 6`
  // to the browser and the user sees `foo\u2026` instead of `foo…`.
  //
  // Biome has no rule for this (Aug 2026). The pattern is mechanically
  // detectable, so we catch it here. Use the actual unicode character or
  // the JSX-expression form (`placeholder={"foo\u2026"}`) instead.
  test("no .tsx file has a JSX attribute string with literal \\u escape", async () => {
    const root = path.resolve(import.meta.dir, "..", "..", "src", "ui");
    const glob = new Bun.Glob("**/*.tsx");
    const files: string[] = [];
    for await (const f of glob.scan({ cwd: root, absolute: true })) files.push(f);
    expect(files.length).toBeGreaterThan(20);

    // Match: JSX attribute name (alphanumeric/dash) followed by `="..."` whose
    // value contains `\uXXXX`. Single-quoted attrs caught by the second pass.
    const dq = /\s([a-zA-Z][a-zA-Z0-9-]*)="([^"]*\\u[0-9a-fA-F]{4}[^"]*)"/g;
    const sq = /\s([a-zA-Z][a-zA-Z0-9-]*)='([^']*\\u[0-9a-fA-F]{4}[^']*)'/g;
    const offenders: string[] = [];
    for (const file of files) {
      const text = await Bun.file(file).text();
      for (const re of [dq, sq]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const lineNo = text.slice(0, m.index).split("\n").length;
          const rel = path.relative(process.cwd(), file);
          offenders.push(`${rel}:${lineNo} — ${m[1]}="${m[2]}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // Defense in depth: if a JSX-attribute escape slipped past the source scan,
  // the bug would manifest in the bundled JS as a string containing the
  // literal byte sequence backslash + 'u' + four hex digits (the JSX engine
  // emits the attribute value verbatim, so the backslash is real data, not
  // an escape). Bun's minifier then writes that data string as a JS string
  // literal where the backslash itself must be escaped — so the bundle
  // text contains TWO backslashes in a row (`\\u2026`).
  //
  // Note: a SINGLE-backslash `\u2026` substring in the bundle is normal —
  // Bun's minifier emits non-ASCII chars (real ellipsis, real em-dash,
  // CodeMirror's lezer unicode ranges, etc.) as `\u####` escapes for
  // transport safety. We do NOT match those. We match double-backslash only.
  test("bundled JS has no double-backslash \\\\u#### sequences (would mean a JSX attribute shipped a literal escape)", async () => {
    const r = await fetch(`${h.url}/bundle.js`);
    const t = await r.text();
    expect(r.status).toBe(200);
    // Match `\\u2026` etc. — 4-backslashes-in-regex = literal `\\u####` in text.
    const matches = t.match(/\\\\u[0-9a-fA-F]{4}/g);
    expect(matches).toBeNull();
  });
});

describe("UI: /api/me identity endpoint", () => {
  test("returns an author string from the cascade (gh → git → hostname → 'me')", async () => {
    const r = await j("/api/me");
    expect(r.status).toBe(200);
    expect(typeof r.body.author).toBe("string");
    expect(r.body.author.length).toBeGreaterThan(0);
  });
});

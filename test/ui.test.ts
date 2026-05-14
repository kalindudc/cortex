import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Store } from "../src/store.ts";
import { startServer, type ServerHandle } from "../src/server.ts";

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

describe("UI: /api/me identity endpoint", () => {
  test("returns an author string from the cascade (gh → git → hostname → 'me')", async () => {
    const r = await j("/api/me");
    expect(r.status).toBe(200);
    expect(typeof r.body.author).toBe("string");
    expect(r.body.author.length).toBeGreaterThan(0);
  });
});

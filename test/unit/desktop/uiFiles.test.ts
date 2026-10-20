import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveUiDir, resolveUiFile } from "../../../src/desktop/uiFiles.ts";

let base: string;
let ui: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cortex-ui-")));
  ui = path.join(base, "ui");
  fs.mkdirSync(path.join(ui, "mermaid"), { recursive: true });
  for (const name of ["index.html", "bundle.js", "bundle.css", "bundle.js.map", "mermaid/chunk.mjs", "data.bin"]) {
    fs.writeFileSync(path.join(ui, name), name);
  }
  fs.writeFileSync(path.join(base, "secret.js"), "secret");
  fs.symlinkSync(path.join(base, "secret.js"), path.join(ui, "link.js"));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("resolveUiFile", () => {
  test("serves known files with their MIME type", () => {
    expect(resolveUiFile(ui, "/index.html")).toEqual({
      file: path.join(ui, "index.html"),
      mime: "text/html; charset=utf-8",
    });
    expect(resolveUiFile(ui, "/bundle.js")?.mime).toBe("text/javascript; charset=utf-8");
    expect(resolveUiFile(ui, "/mermaid/chunk.mjs")?.mime).toBe("text/javascript; charset=utf-8");
    expect(resolveUiFile(ui, "/bundle.css")?.mime).toBe("text/css; charset=utf-8");
    expect(resolveUiFile(ui, "/bundle.js.map")?.mime).toBe("application/json; charset=utf-8");
  });

  test("falls back to index.html only for extensionless paths", () => {
    expect(resolveUiFile(ui, "/")?.file).toBe(path.join(ui, "index.html"));
    expect(resolveUiFile(ui, "/task/42")?.file).toBe(path.join(ui, "index.html"));
    expect(resolveUiFile(ui, "/missing.js")).toBeNull();
    expect(resolveUiFile(ui, "/data.bin")).toBeNull();
    expect(resolveUiFile(ui, "/api/workspace")).toBeNull();
    expect(resolveUiFile(ui, "/api")).toBeNull();
  });

  test("refuses traversal, NUL, bad encoding and a symlink out of the directory", () => {
    for (const p of [
      "/../secret.js",
      "/%2e%2e/secret.js",
      "/mermaid/../../secret.js",
      "/bundle.js%00.html",
      "/%zz.js",
      "/link.js",
    ]) {
      expect(resolveUiFile(ui, p), p).toBeNull();
    }
  });
});

describe("resolveUiDir", () => {
  test("prefers the packaged resources, then CORTEX_UI_DIR, else throws", () => {
    expect(resolveUiDir({ env: { CORTEX_UI_DIR: "/dev/ui" }, packagedResourcesPath: "/app/Resources" })).toBe(
      "/app/Resources/ui",
    );
    expect(resolveUiDir({ env: { CORTEX_UI_DIR: "/dev/ui" } })).toBe("/dev/ui");
    expect(() => resolveUiDir({ env: {} })).toThrow("CORTEX_UI_DIR");
  });
});

#!/usr/bin/env bun
// watch-css.ts — Re-run scripts/build-css.sh whenever a CSS slice in
// src/ui/styles/ changes.
//
// Why this exists: build-css.sh concatenates 14 per-feature slices into
// out/bundle.css. The Bun bundler doesn't watch this script (it's outside
// the JS module graph), and `bun build --watch` only tracks JS-side
// imports — so without this watcher, slice edits don't reach the browser
// until someone re-runs `pnpm run ui:build` by hand.
//
// node:fs.watch on macOS uses FSEvents under the hood; non-recursive watch
// of a small directory of ~14 files was verified reliable on bun 1.1.12. We debounce
// because most editors (VS Code, vim) write a file as rename-temp + atomic
// move, which fires multiple events for one logical save.
//
// Lifecycle: spawned in the background by scripts/dev.sh and killed via
// SIGTERM when the dev orchestrator exits. The SIGINT/SIGTERM handlers
// below ensure we don't leak a zombie process if Ctrl+C reaches us first.

import { watch } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const STYLES_DIR = join(SCRIPT_DIR, "..", "src", "ui", "styles");
const BUILD_SCRIPT = join(SCRIPT_DIR, "build-css.sh");
const DEBOUNCE_MS = 50;

let pending: ReturnType<typeof setTimeout> | null = null;
let building = false;

function rebuild(): void {
  if (building) {
    // A rebuild is already in flight — schedule another after it finishes
    // so we don't drop the latest edit.
    pending = setTimeout(rebuild, DEBOUNCE_MS);
    return;
  }
  building = true;
  const r = spawnSync("bash", [BUILD_SCRIPT], { stdio: "inherit" });
  building = false;
  if (r.status !== 0) {
    console.error(`[watch-css] build-css.sh exited ${r.status}`);
  }
}

function schedule(filename: string | null): void {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    console.log(`[watch-css] change: ${filename ?? "?"} → rebuilding bundle.css`);
    rebuild();
  }, DEBOUNCE_MS);
}

console.log(`[watch-css] watching ${STYLES_DIR}`);
const watcher = watch(STYLES_DIR, { recursive: false }, (_event, filename) => {
  // Filter to .css to ignore editor swap files (.swp, .css~, etc.).
  if (!filename?.endsWith(".css")) return;
  schedule(filename);
});

function shutdown(): void {
  if (pending) clearTimeout(pending);
  watcher.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

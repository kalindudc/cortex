/**
 * Maps a `cortex://app` request path to a file in the bundled UI directory.
 * Anything that could leave that directory, or has no known MIME type, maps
 * to nothing and the scheme handler answers 404.
 */

import fs from "node:fs";
import path from "node:path";

export interface UiFile {
  file: string;
  mime: string;
}

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/** The UI directory: `<resources>/ui` when packaged, else `CORTEX_UI_DIR`. */
export function resolveUiDir(o: { env: NodeJS.ProcessEnv; packagedResourcesPath?: string }): string {
  if (o.packagedResourcesPath) return path.join(o.packagedResourcesPath, "ui");
  const dir = o.env.CORTEX_UI_DIR;
  if (!dir) throw new Error("CORTEX_UI_DIR is not set: point it at the built UI (out/ui, from `pnpm run ui:build`)");
  return dir;
}

function realFile(file: string): string | null {
  try {
    const real = fs.realpathSync(file);
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Resolve a request pathname; extensionless paths (client routes such as /task/42) fall back to index.html. */
export function resolveUiFile(uiDir: string, pathname: string): UiFile | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  // A stray data fetch must fail visibly instead of receiving the HTML shell.
  if (decoded === "/api" || decoded.startsWith("/api/")) return null;
  const ext = path.extname(decoded);
  const relative = ext === "" ? "index.html" : decoded;
  const mime = MIME[(ext === "" ? ".html" : ext).toLowerCase()];
  if (!mime) return null;
  let root: string;
  try {
    root = fs.realpathSync(uiDir);
  } catch {
    return null;
  }
  const real = realFile(path.join(root, relative));
  if (real === null || !real.startsWith(root + path.sep)) return null;
  return { file: real, mime };
}

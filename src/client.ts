/**
 * Tiny HTTP client used by write commands when a daemon is running.
 *
 * Why: `events.ts` is an in-process bus, so a CLI mutation that writes
 * directly to SQLite is invisible to the daemon's SSE subscribers. Routing
 * mutations through HTTP keeps the daemon as the single writer-of-record
 * while it's alive, and matches how Plan 2 (UI) and Plan 3 (MCP) interact.
 */

import fs from "node:fs";
import { pidPath, urlPath } from "./paths.ts";

/**
 * If a healthy daemon is running, return its base URL. Otherwise null.
 *
 * "Healthy" means: pid file exists, the process responds to signal 0, and a
 * URL file exists. Stale pid files are silently ignored (the next `serve`
 * overwrites them).
 */
export function daemonUrl(): string | null {
  if (!fs.existsSync(pidPath()) || !fs.existsSync(urlPath())) return null;
  const pidStr = fs.readFileSync(pidPath(), "utf8").trim();
  const pid = Number.parseInt(pidStr, 10);
  if (!Number.isFinite(pid)) return null;
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  return fs.readFileSync(urlPath(), "utf8").trim() || null;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * Error thrown by `request()` on any non-2xx response. Carries the HTTP
 * `status` plus the server's machine-readable `code` / `matches` (parsed from
 * the JSON error body when present) so the CLI can re-emit them in its
 * structured `--json` error envelope. `message` is the server's clean error
 * text (or the raw body) — no HTTP method/path/status noise leaks to agents.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly matches?: number;
  constructor(status: number, message: string, code?: string, matches?: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    if (code !== undefined) this.code = code;
    if (matches !== undefined) this.matches = matches;
  }
}

async function request<T>(url: string, method: Method, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    let code: string | undefined;
    let matches: number | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: string; code?: string; matches?: number };
      if (parsed.error) msg = parsed.error;
      if (typeof parsed.code === "string") code = parsed.code;
      if (typeof parsed.matches === "number") matches = parsed.matches;
    } catch {
      /* keep raw text */
    }
    throw new HttpError(res.status, msg, code, matches);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const Client = {
  addTask: (url: string, b: unknown) => request(url, "POST", "/api/tasks", b),
  getTask: (url: string, id: number) => request(url, "GET", `/api/tasks/${id}`),
  editTask: (url: string, id: number, b: unknown) => request(url, "PATCH", `/api/tasks/${id}`, b),
  setStatus: (url: string, id: number, status: string, author?: string) =>
    request(url, "PATCH", `/api/tasks/${id}/status`, author ? { status, author } : { status }),
  moveTask: (url: string, id: number, lane: string) => request(url, "PATCH", `/api/tasks/${id}/lane`, { lane }),
  removeTask: (url: string, id: number) => request(url, "DELETE", `/api/tasks/${id}`),
  addUpdate: (url: string, id: number, b: unknown) => request(url, "POST", `/api/tasks/${id}/updates`, b),
  backup: (url: string, b: unknown) => request(url, "POST", "/api/backup", b),
  addLane: (url: string, b: unknown) => request(url, "POST", "/api/lanes", b),
  editLane: (url: string, name: string, b: unknown) =>
    request(url, "PATCH", `/api/lanes/${encodeURIComponent(name)}`, b),
  removeLane: (url: string, name: string) => request(url, "DELETE", `/api/lanes/${encodeURIComponent(name)}`),
  setTaskTags: (url: string, id: number, names: string[]) =>
    request(url, "PATCH", `/api/tasks/${id}/tags`, { set: names }),
  listTags: (url: string) => request(url, "GET", "/api/tags"),
  addTag: (url: string, b: unknown) => request(url, "POST", "/api/tags", b),
  editTag: (url: string, name: string, b: unknown) => request(url, "PATCH", `/api/tags/${encodeURIComponent(name)}`, b),
  removeTag: (url: string, name: string, force?: boolean) =>
    request(url, "DELETE", `/api/tags/${encodeURIComponent(name)}${force ? "?force=1" : ""}`),
};

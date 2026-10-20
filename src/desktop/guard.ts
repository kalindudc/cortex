/**
 * Checks main applies to everything the renderer sends. The renderer is
 * treated as untrusted: it may read and write tasks through `/api/` data
 * routes, never reach a control route, and never bind a request to a daemon
 * instance itself.
 */

import { CONTROL_PATHS } from "../api.ts";
import { APP_HOST, APP_SCHEME } from "./ipc.ts";

export interface ParsedBridgeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const DROPPED_HEADERS: ReadonlySet<string> = new Set(["cortex-instance", "host", "content-length"]);
const CONTROL_PREFIX = "/api/control";
const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

function invalid(reason: string): never {
  throw new Error(`invalid bridge request: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkPath(path: unknown): string {
  if (typeof path !== "string" || !path.startsWith("/api/")) invalid("path must start with /api/");
  const query = path.indexOf("?");
  const raw = query === -1 ? path : path.slice(0, query);
  let pathname: string;
  try {
    pathname = decodeURIComponent(raw);
  } catch {
    invalid("path has a malformed percent-encoding");
  }
  // A `..` in the query string is data; in the pathname it is traversal.
  if (pathname.includes("..") || pathname.includes("\\") || pathname.includes("\0")) invalid("path traversal");
  const lower = pathname.toLowerCase();
  const controls: string[] = Object.values(CONTROL_PATHS);
  if (lower.startsWith(CONTROL_PREFIX) || controls.includes(lower)) invalid("control routes are not reachable");
  return path;
}

function checkHeaders(headers: unknown): Record<string, string> {
  if (headers === undefined) return {};
  if (!isRecord(headers)) invalid("headers must be an object");
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") invalid(`header ${name} must be a string`);
    if (DROPPED_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/** Validate one `cortex:request` payload; throws `invalid bridge request: <reason>`. */
export function parseBridgeRequest(value: unknown): ParsedBridgeRequest {
  if (!isRecord(value)) invalid("not an object");
  const { method, body } = value;
  if (typeof method !== "string" || !METHODS.has(method)) invalid(`method ${String(method)} is not allowed`);
  const path = checkPath(value.path);
  const headers = checkHeaders(value.headers);
  if (body !== undefined && typeof body !== "string") invalid("body must be a string");
  return body === undefined ? { method, path, headers } : { method, path, headers, body };
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** True for a URL on the app's own `cortex://app` origin. */
export function isAppUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const parsed = parseUrl(url);
  return (
    parsed !== null &&
    parsed.protocol === `${APP_SCHEME}:` &&
    parsed.host === APP_HOST &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

/** True for a link the app may hand to the system browser or mail client. */
export function isExternalLink(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed !== null && EXTERNAL_PROTOCOLS.has(parsed.protocol);
}

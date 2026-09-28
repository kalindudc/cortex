// Rich draft previews (plan @400 N11/N21, Task 10 part B).
//
// `:preview` in the terminal hands the daemon one task's EXACT current text
// (unsaved edits included) and opens `/preview/<token>` on the loopback
// dashboard, where the browser renders it through the ONE sanitized Markdown
// boundary (MarkdownView over src/ui/lib/markdown.ts: DOMPurify, strict
// Mermaid). This module is the daemon side: a bounded private in-memory token
// store and its two routes.
//
// - Create: POST CONTROL_PATHS.preview, registered ONLY on the IPC app (the
//   private Unix socket; the listener kind is set by the code that bound it,
//   never derived from a request) and bound to the verified instance
//   (Cortex-Instance is required; buildApp's checkInstance answers 421 for
//   another instance).
// - Read: GET /api/preview/:token. The EXACT token (128 random bits, 32
//   lowercase hex) is the only credential: no header, cookie or listener
//   claim is consulted, and nothing lists previews.
// - Bounds: a 10-minute TTL (a request may ask for less), 1 MiB of UTF-8 per
//   preview (title and source together), 8 MiB and 1000 previews in total.
//   Overflow is an explicit error (413/507), never a silent eviction. Expired
//   content is dropped at once; a bounded set of expired tokens is remembered
//   WITHOUT content, so a late read says "expired" (410), not "not found" (404).
// - A preview never becomes a task write: this module has no Store and
//   publishes no events.

import type { Context, Hono } from "hono";
import { CONTROL_PATHS, INSTANCE_HEADER } from "./api.ts";
import type { PreviewCreated, PreviewRequest, PreviewSnapshot } from "./contracts.ts";
import type { DaemonRuntime } from "./server.ts";

export const PREVIEW_TTL_MS = 10 * 60 * 1000;
/** UTF-8 bytes one preview (title and source) may hold. */
export const PREVIEW_MAX_BYTES = 1024 * 1024;
/** UTF-8 bytes every live preview together may hold. */
export const PREVIEW_TOTAL_BYTES = 8 * 1024 * 1024;
/** Live previews at once (empty drafts are 0 bytes, so bytes alone would not bound the count). */
export const PREVIEW_MAX_COUNT = 1000;
/** Expired tokens remembered (token and expiry only) so late reads can say "expired". */
const MAX_EXPIRED = 1024;
const TOKEN = /^[0-9a-f]{32}$/;
const MiB = 1024 * 1024;

export type PreviewErrorCode =
  | "invalid_preview"
  | "preview_not_found"
  | "preview_expired"
  | "preview_too_large"
  | "preview_storage_full";
export type PreviewErrorStatus = 400 | 404 | 410 | 413 | 507;

/** An explicit preview failure; the routes answer it as `{ error, code, ...details }` with `status`. */
export class PreviewError extends Error {
  readonly code: PreviewErrorCode;
  readonly status: PreviewErrorStatus;
  /** Sizes and limits added to the JSON error body. */
  readonly details: Readonly<Record<string, number>>;
  constructor(
    code: PreviewErrorCode,
    status: PreviewErrorStatus,
    message: string,
    details: Record<string, number> = {},
  ) {
    super(message);
    this.name = "PreviewError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface PreviewStoreOptions {
  /** Clock seam (ms since the epoch). */
  now?: () => number;
  ttlMs?: number;
  maxBytes?: number;
  totalBytes?: number;
  maxCount?: number;
  maxExpired?: number;
  /** 16 random bytes per token (default crypto.getRandomValues). */
  random?: () => Uint8Array;
}

export interface PreviewStore {
  /** Hold one draft; throws PreviewError for a bad request or a full store. */
  create(request: PreviewRequest): PreviewCreated;
  /** The held draft for the EXACT token; throws PreviewError (not found / expired). */
  read(token: string): PreviewSnapshot;
  /** Live previews and their bytes (after dropping the expired ones). */
  usage(): { count: number; bytes: number };
}

/** `1 MiB`, `1.5 MiB`, `12.3 KiB`, `10 bytes`. */
function formatSize(bytes: number): string {
  const trim = (n: number): string => n.toFixed(1).replace(/\.0$/, "");
  if (bytes >= MiB) return `${trim(bytes / MiB)} MiB`;
  if (bytes >= 1024) return `${trim(bytes / 1024)} KiB`;
  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} ${ms === 60_000 ? "minute" : "minutes"}`;
  const seconds = Math.ceil(ms / 1000);
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const invalid = (message: string): PreviewError => new PreviewError("invalid_preview", 400, message);

function parseRequest(value: unknown, ttlMs: number): Required<PreviewRequest> {
  if (!isRecord(value)) throw invalid("A preview request must be a JSON object { taskId, title, source }");
  const { taskId, title, source, unsaved, ttlMs: requested } = value;
  if (typeof taskId !== "number" || !Number.isSafeInteger(taskId) || taskId <= 0) {
    throw invalid("taskId must be a positive integer");
  }
  if (typeof title !== "string") throw invalid("title must be a string");
  if (typeof source !== "string") throw invalid("source must be a string (the exact Markdown to preview)");
  if (unsaved !== undefined && typeof unsaved !== "boolean") throw invalid("unsaved must be true or false");
  if (
    requested !== undefined &&
    (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1 || requested > ttlMs)
  ) {
    throw invalid(`ttlMs must be an integer from 1 to ${ttlMs} (previews last at most ${formatDuration(ttlMs)})`);
  }
  return { taskId, title, source, unsaved: unsaved ?? false, ttlMs: requested ?? ttlMs };
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

const defaultRandom = (): Uint8Array => crypto.getRandomValues(new Uint8Array(16));

export function createPreviewStore(options: PreviewStoreOptions = {}): PreviewStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PREVIEW_TTL_MS;
  const maxBytes = options.maxBytes ?? PREVIEW_MAX_BYTES;
  const totalBytes = options.totalBytes ?? PREVIEW_TOTAL_BYTES;
  const maxCount = options.maxCount ?? PREVIEW_MAX_COUNT;
  const maxExpired = options.maxExpired ?? MAX_EXPIRED;
  const random = options.random ?? defaultRandom;
  const ttlText = formatDuration(ttlMs);
  const live = new Map<string, { snapshot: PreviewSnapshot; expiresAtMs: number }>();
  /** Expired token -> when it expired (insertion order = oldest first). */
  const expired = new Map<string, number>();
  let used = 0;

  const prune = (at: number): void => {
    for (const [token, entry] of live) {
      if (entry.expiresAtMs > at) continue;
      live.delete(token);
      used -= entry.snapshot.bytes;
      expired.set(token, entry.expiresAtMs);
      while (expired.size > maxExpired) {
        const oldest = expired.keys().next().value;
        if (oldest === undefined) break;
        expired.delete(oldest);
      }
    }
  };

  const nextExpiry = (): string => {
    let soonest = Number.POSITIVE_INFINITY;
    for (const entry of live.values()) soonest = Math.min(soonest, entry.expiresAtMs);
    return Number.isFinite(soonest) ? new Date(soonest).toISOString() : "soon";
  };

  const newToken = (): string => {
    for (;;) {
      const bytes = random();
      if (!(bytes instanceof Uint8Array) || bytes.length !== 16) throw new Error("preview tokens need 16 random bytes");
      const token = hex(bytes);
      if (!live.has(token) && !expired.has(token)) return token;
    }
  };

  return {
    create(request) {
      const parsed = parseRequest(request, ttlMs);
      const at = now();
      prune(at);
      const bytes = Buffer.byteLength(parsed.title, "utf8") + Buffer.byteLength(parsed.source, "utf8");
      if (bytes > maxBytes) {
        throw new PreviewError(
          "preview_too_large",
          413,
          `The preview is ${formatSize(bytes)}; one preview may hold at most ${formatSize(maxBytes)} (its title and source together)`,
          { bytes, limit: maxBytes },
        );
      }
      if (used + bytes > totalBytes || live.size >= maxCount) {
        throw new PreviewError(
          "preview_storage_full",
          507,
          `Previews already hold ${formatSize(used)} of ${formatSize(totalBytes)} in ${live.size} of at most ${maxCount}, and this one needs ${formatSize(bytes)}. Each preview expires ${ttlText} after it was made (the next at ${nextExpiry()}); try again then`,
          { bytes, used, limit: totalBytes, count: live.size, maxCount },
        );
      }
      const token = newToken();
      const expiresAtMs = at + parsed.ttlMs;
      const snapshot: PreviewSnapshot = {
        taskId: parsed.taskId,
        title: parsed.title,
        source: parsed.source,
        unsaved: parsed.unsaved,
        createdAt: new Date(at).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        bytes,
      };
      live.set(token, { snapshot, expiresAtMs });
      used += bytes;
      return { token, path: `/preview/${token}`, expiresAt: snapshot.expiresAt, bytes };
    },

    read(token) {
      prune(now());
      if (typeof token === "string" && TOKEN.test(token)) {
        const entry = live.get(token);
        if (entry !== undefined) return { ...entry.snapshot };
        const expiredAt = expired.get(token);
        if (expiredAt !== undefined) {
          throw new PreviewError(
            "preview_expired",
            410,
            `This preview expired at ${new Date(expiredAt).toISOString()}: previews last ${ttlText}. Run :preview in the terminal again for a fresh one`,
          );
        }
      }
      throw new PreviewError(
        "preview_not_found",
        404,
        `No such preview: the link may be mistyped, it may have expired, or the daemon restarted (previews live only in the daemon's memory, for ${ttlText}). Run :preview in the terminal again`,
      );
    },

    usage() {
      prune(now());
      return { count: live.size, bytes: used };
    },
  };
}

/**
 * Register the preview routes on one listener's app: create only when that
 * app is the IPC app, read by exact token on every app. Call it after the
 * app's instance check (`/api/*`) is installed.
 */
export function registerPreviewRoutes(app: Hono, runtime: DaemonRuntime): void {
  const previews = runtime.previews;
  const failure = (c: Context, err: unknown): Response => {
    if (!(err instanceof PreviewError)) throw err;
    return c.json({ error: err.message, code: err.code, ...err.details }, err.status);
  };

  if (runtime.listener === "ipc") {
    app.post(CONTROL_PATHS.preview, async c => {
      c.header("Cache-Control", "no-store");
      if (c.req.header(INSTANCE_HEADER) === undefined) {
        return c.json(
          { error: `control requests must name the daemon instance (${INSTANCE_HEADER})`, code: "instance_required" },
          400,
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        return failure(c, invalid("A preview request must be JSON: { taskId, title, source }"));
      }
      try {
        return c.json(previews.create(body as PreviewRequest), 201);
      } catch (err) {
        return failure(c, err);
      }
    });
  }

  app.get("/api/preview/:token", c => {
    c.header("Cache-Control", "no-store");
    try {
      return c.json(previews.read(c.req.param("token")));
    } catch (err) {
      return failure(c, err);
    }
  });
}

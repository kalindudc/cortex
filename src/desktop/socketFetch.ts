/**
 * HTTP over the daemon's Unix socket for the desktop main process. Node's
 * `fetch` cannot use a Unix socket, so this wraps `http.request({ socketPath })`
 * and returns a web `Response` whose body streams, which SSE needs.
 */

import http from "node:http";
import type { RequestSender } from "../api.ts";
import type { StreamFetch } from "../subscription.ts";

export interface SocketRequest {
  socketPath: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** `new Response(stream, { status: 204 })` throws, so these statuses get a null body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function toHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
}

function streamBody(res: http.IncomingMessage): ReadableStream<Uint8Array> {
  let settled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        finish();
      };
      res.on("data", (chunk: Buffer) => {
        if (!settled) controller.enqueue(new Uint8Array(chunk));
      });
      res.on("end", () => settle(() => controller.close()));
      res.on("error", err => settle(() => controller.error(err)));
      // A peer that goes away mid-stream (a stopped daemon) must end the read, not hang it.
      res.on("close", () => settle(() => controller.error(new Error("connection closed before the response ended"))));
    },
    cancel() {
      settled = true;
      // Cancelling the body (for example an SSE reader) closes the socket.
      res.destroy();
    },
  });
}

/** Send one request; resolves as soon as the response headers arrive. */
export function socketResponse(options: SocketRequest): Promise<Response> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) headers["content-length"] = String(Buffer.byteLength(options.body));
    const req = http.request(
      { socketPath: options.socketPath, method: options.method, path: options.path, headers },
      res => {
        // Aborting after the headers arrived still tears the response down.
        res.on("close", () => signal?.removeEventListener("abort", onAbort));
        const status = res.statusCode ?? 0;
        const init = { status, statusText: res.statusMessage ?? "", headers: toHeaders(res.headers) };
        if (NULL_BODY_STATUSES.has(status)) {
          res.resume();
          resolve(new Response(null, init));
          return;
        }
        resolve(new Response(streamBody(res), init));
      },
    );
    const onAbort = (): void => {
      req.destroy(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", err => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

/** A RequestSender for `createApi` over the socket; only string bodies are sent. */
export function socketSender(socketPath: string): RequestSender {
  return (path, init = {}) => {
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
      return Promise.reject(new TypeError("socketSender sends only string bodies"));
    }
    return socketResponse({
      socketPath,
      method: init.method ?? "GET",
      path,
      headers: headerRecord(init.headers),
      body: init.body ?? undefined,
      signal: init.signal ?? undefined,
    });
  };
}

/** The StreamFetch `subscribeChanges` uses in main; it needs `init.unix`, the socket path. */
export const socketStreamFetch: StreamFetch = (url, init) => {
  if (!init.unix) return Promise.reject(new TypeError("socketStreamFetch needs init.unix (the socket path)"));
  const { pathname, search } = new URL(url);
  return socketResponse({
    socketPath: init.unix,
    method: init.method ?? "GET",
    path: pathname + search,
    headers: headerRecord(init.headers),
    signal: init.signal ?? undefined,
  });
};

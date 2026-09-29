/**
 * Environment-neutral typed client for the daemon's JSON API (plan @400 N11).
 *
 * `createApi(send)` takes the transport as a RequestSender: the native client
 * (src/client.ts) sends over the Unix socket or an absolute URL, the browser
 * over relative fetch. This module therefore imports nothing at runtime and
 * touches no Bun/node/DOM/state globals; test/unit/api.test.ts enforces it.
 *
 * Errors are centralized here: an HTTP error status becomes an HttpError
 * (status + server code, and the structured conflict for a 412), and a
 * request whose outcome is unknown (network failure, timeout, abort,
 * unparseable success) becomes a TransportError. A TransportError on a write
 * is `uncertain`: the write may have committed, so only retry it with the
 * same mutationId (deduplicated), never blindly.
 */

import type {
  CortexClient,
  CreateTaskRequest,
  MemorySearchQuery,
  MemoryStreamsQuery,
  PostUpdateRequest,
  TaskListQuery,
  VersionConflict,
  WriteGuard,
} from "./contracts.ts";

/** Sends one request to the daemon; `path` starts with `/` (for example `/api/tasks`). */
export type RequestSender = (path: string, init?: RequestInit) => Promise<Response>;

export interface ApiOptions {
  /** Bind every request to this daemon instance (`Cortex-Instance`); another instance answers 421. */
  instanceId?: string;
  /** Reject a request that has not completed in this many milliseconds (TransportError "timeout"). */
  timeoutMs?: number;
  /** Cancels every in-flight and future request (TransportError "aborted"); also handed to the sender. */
  signal?: AbortSignal;
}

/** The `Prefer` token that opts a write into versioned results. */
export const PREFER_VERSIONED = "cortex-versioned";
/** Request header binding a request to a verified daemon instance. */
export const INSTANCE_HEADER = "Cortex-Instance";

/**
 * Daemon control routes (plan @400 N5/N11). Registered ONLY on the daemon's
 * private IPC (Unix socket) app, never on the loopback listener, and every
 * request must carry INSTANCE_HEADER naming the verified instance.
 *   shutdown: POST, no body -> 202 `{ ok, instanceId }`, then the daemon stops.
 *   web:      POST EnableWebRequest -> 200 `{ identity }` (with `webUrl`).
 *   preview:  POST PreviewRequest -> 201 PreviewCreated (src/preview.ts); the
 *             loopback page `/preview/<token>` reads it by the exact token.
 */
export const CONTROL_PATHS = {
  shutdown: "/api/control/shutdown",
  web: "/api/control/web",
  preview: "/api/control/preview",
} as const;

/**
 * A non-2xx response. `message` is the server's clean error text (or the raw
 * body); `code`/`matches` come from the JSON error body; `conflict` is set for
 * a 412 version_conflict.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly matches?: number;
  readonly conflict?: VersionConflict;
  constructor(status: number, message: string, code?: string, matches?: number, conflict?: VersionConflict) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    if (code !== undefined) this.code = code;
    if (matches !== undefined) this.matches = matches;
    if (conflict !== undefined) this.conflict = conflict;
  }
}

export type TransportErrorKind = "network" | "timeout" | "aborted" | "protocol";

/** The request's outcome is unknown or unusable; see `uncertain` before retrying a write. */
export class TransportError extends Error {
  readonly kind: TransportErrorKind;
  readonly method: string;
  readonly path: string;
  /** True for writes: the daemon may have applied it. */
  readonly uncertain: boolean;
  constructor(kind: TransportErrorKind, method: string, path: string, message: string) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
    this.method = method;
    this.path = path;
    this.uncertain = method !== "GET";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build the HttpError for a non-2xx response body, with the legacy CLI client's message/code/matches rules. */
export function parseHttpError(status: number, text: string): HttpError {
  let message = text || `HTTP ${status}`;
  let code: string | undefined;
  let matches: number | undefined;
  let conflict: VersionConflict | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      if (typeof parsed.error === "string" && parsed.error) message = parsed.error;
      if (typeof parsed.code === "string") code = parsed.code;
      if (typeof parsed.matches === "number") matches = parsed.matches;
      if (code === "version_conflict" && Array.isArray(parsed.mismatches) && isRecord(parsed.current)) {
        conflict = {
          kind: parsed.kind as VersionConflict["kind"],
          key: parsed.key as VersionConflict["key"],
          mismatches: parsed.mismatches as VersionConflict["mismatches"],
          current: parsed.current as VersionConflict["current"],
        };
      }
    }
  } catch {
    /* not JSON: keep the raw text */
  }
  return new HttpError(status, message, code, matches, conflict);
}

/** A fresh id for a deduplicated create/post/status; reuse it for every retry of that one mutation. */
export function newMutationId(): string {
  return globalThis.crypto.randomUUID();
}

function preferenceApplied(res: Response): boolean {
  const applied = res.headers.get("preference-applied") ?? "";
  return applied.split(",").some(token => (token.split(/[;=]/)[0] ?? "").trim().toLowerCase() === PREFER_VERSIONED);
}

const enc = encodeURIComponent;

/** `?lane=..&status=..&search=..&tags=a,b` for the filters that are set (empty values omitted). */
function taskQueryString(query: TaskListQuery | undefined): string {
  if (query === undefined) return "";
  const pairs: string[] = [];
  const add = (key: string, value: string | undefined): void => {
    if (value) pairs.push(`${key}=${enc(value)}`);
  };
  add("lane", query.lane);
  add("status", query.status);
  add("search", query.search);
  add("tags", query.tags?.join(","));
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

/** `?k=v&...` for the memory routes: booleans become `1` only when true, number lists join with `,`. */
function queryString(params: Record<string, string | number | boolean | number[] | undefined>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === false || value === "") continue;
    const text = value === true ? "1" : Array.isArray(value) ? value.join(",") : String(value);
    if (text) pairs.push(`${key}=${enc(text)}`);
  }
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

export function createApi(send: RequestSender, options: ApiOptions = {}): CortexClient {
  type Method = "GET" | "POST" | "PATCH" | "DELETE";
  type Call = { body?: unknown; versioned?: boolean };

  /**
   * Resolve with the request's outcome, or reject with a TransportError on
   * deadline/abort; `abandon` runs synchronously at that moment.
   */
  const settle = <T>(work: Promise<T>, method: Method, path: string, abandon: () => void): Promise<T> => {
    const { timeoutMs, signal } = options;
    if (timeoutMs === undefined && signal === undefined) return work;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): boolean => {
        if (finished) return false;
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        return true;
      };
      const giveUp = (kind: "timeout" | "aborted"): void => {
        if (!finish()) return;
        abandon();
        const what = kind === "timeout" ? `timed out after ${timeoutMs}ms` : "was aborted";
        reject(new TransportError(kind, method, path, `${method} ${path} ${what}`));
      };
      const onAbort = (): void => giveUp("aborted");
      if (timeoutMs !== undefined) timer = setTimeout(() => giveUp("timeout"), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      work.then(
        value => {
          if (finish()) resolve(value);
        },
        err => {
          if (finish()) reject(err);
        },
      );
    });
  };

  const request = async <T>(method: Method, path: string, call: Call = {}): Promise<T> => {
    if (options.signal?.aborted) throw new TransportError("aborted", method, path, `${method} ${path} was aborted`);
    const headers: Record<string, string> = {};
    if (call.body !== undefined) headers["content-type"] = "application/json";
    if (call.versioned) headers.prefer = PREFER_VERSIONED;
    if (options.instanceId !== undefined) headers[INSTANCE_HEADER] = options.instanceId;
    const init: RequestInit = { method, headers };
    if (call.body !== undefined) init.body = JSON.stringify(call.body);
    if (options.signal) init.signal = options.signal;

    // After a deadline/abort, a late response is released instead of read. (A
    // body already being read when the deadline hits completes on its own.)
    let abandoned = false;
    const work = send(path, init).then(async r => {
      if (abandoned) {
        await r.body?.cancel().catch(() => {});
        return null;
      }
      return { res: r, text: await r.text() };
    });
    let outcome: { res: Response; text: string } | null;
    try {
      outcome = await settle(work, method, path, () => {
        abandoned = true;
      });
    } catch (err) {
      if (err instanceof TransportError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new TransportError("network", method, path, `${method} ${path} failed: ${reason}`);
    }
    if (outcome === null) throw new TransportError("aborted", method, path, `${method} ${path} was abandoned`);
    const { res, text } = outcome;
    if (!res.ok) throw parseHttpError(res.status, text);
    if (call.versioned && !preferenceApplied(res)) {
      throw new TransportError(
        "protocol",
        method,
        path,
        `${method} ${path}: the daemon ignored Prefer: ${PREFER_VERSIONED} (it predates this client; restart it)`,
      );
    }
    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TransportError("protocol", method, path, `${method} ${path}: response is not JSON`);
    }
  };

  const nothing = async (method: Method, path: string, call?: Call): Promise<void> => {
    await request<unknown>(method, path, call);
  };

  /** A JSON body carrying the optional guard (absent keys are omitted). */
  const withGuard = (body: object, guard: WriteGuard | undefined): object =>
    guard === undefined ? body : { ...body, guard };
  const guardOnly = (guard: WriteGuard | undefined): { body?: unknown } =>
    guard === undefined ? {} : { body: { guard } };

  return {
    // ---- reads ----
    health: () => request("GET", "/api/health"),
    me: () => request("GET", "/api/me"),
    authors: () => request("GET", "/api/authors"),
    migrations: () => request("GET", "/api/migrations"),
    tasks: query => request("GET", `/api/tasks${taskQueryString(query)}`),
    task: id => request("GET", `/api/tasks/${id}`),
    lanes: () => request("GET", "/api/lanes"),
    tags: () => request("GET", "/api/tags"),
    updates: id => request("GET", `/api/tasks/${id}/updates`),
    related: id => request("GET", `/api/tasks/${id}/related`),
    notifications: () => request("GET", "/api/notifications"),
    workspace: () => request("GET", "/api/workspace"),
    taskState: id => request("GET", `/api/tasks/${id}/state`),
    laneState: name => request("GET", `/api/lanes/${enc(name)}/state`),
    tagState: name => request("GET", `/api/tags/${enc(name)}/state`),
    preview: token => request("GET", `/api/preview/${enc(token)}`),
    memorySearch: (query: MemorySearchQuery) => request("GET", `/api/memory/search${queryString({ ...query })}`),
    memoryStreams: (query?: MemoryStreamsQuery) => request("GET", `/api/memory/streams${queryString({ ...query })}`),
    memoryStream: id => request("GET", `/api/memory/streams/${id}`),

    // ---- legacy writes (unguarded; legacy JSON) ----
    backup: body => request("POST", "/api/backup", { body: body ?? {} }),
    addTask: (body: CreateTaskRequest) => request("POST", "/api/tasks", { body }),
    editTask: (id, body) => request("PATCH", `/api/tasks/${id}`, { body }),
    setStat: (id, status) => request("PATCH", `/api/tasks/${id}/status`, { body: { status } }),
    moveLane: (id, lane) => request("PATCH", `/api/tasks/${id}/lane`, { body: { lane } }),
    delTask: id => nothing("DELETE", `/api/tasks/${id}`),
    postUpd: (id, body: PostUpdateRequest) => request("POST", `/api/tasks/${id}/updates`, { body }),
    addLane: body => request("POST", "/api/lanes", { body }),
    editLane: (name, body) => request("PATCH", `/api/lanes/${enc(name)}`, { body }),
    delLane: name => nothing("DELETE", `/api/lanes/${enc(name)}`),
    setTags: (id, names) => request("PATCH", `/api/tasks/${id}/tags`, { body: { set: names } }),
    // Membership deltas are atomic server-side: unrelated concurrent tag changes survive.
    addTaskTag: (id, name) => request("PATCH", `/api/tasks/${id}/tags`, { body: { add: [name] } }),
    removeTaskTag: (id, name) => request("PATCH", `/api/tasks/${id}/tags`, { body: { remove: [name] } }),
    addTag: body => request("POST", "/api/tags", { body }),
    editTag: (name, body) => request("PATCH", `/api/tags/${enc(name)}`, { body }),
    delTag: (name, force) => nothing("DELETE", `/api/tags/${enc(name)}${force ? "?force=1" : ""}`),
    markNotifRead: id => nothing("PATCH", `/api/notifications/${id}/read`),
    markNotifUnread: id => nothing("PATCH", `/api/notifications/${id}/unread`),
    markAllNotifRead: () => nothing("POST", "/api/notifications/read-all"),
    delNotif: id => nothing("DELETE", `/api/notifications/${id}`),
    clearNotifs: () => nothing("DELETE", "/api/notifications"),

    // ---- versioned, optionally guarded writes ----
    versioned: {
      addTask: (body, guard) => request("POST", "/api/tasks", { body: withGuard(body, guard), versioned: true }),
      editTask: (id, body, guard) =>
        request("PATCH", `/api/tasks/${id}`, { body: withGuard(body, guard), versioned: true }),
      setStatus: (id, body, guard) =>
        request("PATCH", `/api/tasks/${id}/status`, { body: withGuard(body, guard), versioned: true }),
      moveTask: (id, lane, guard) =>
        request("PATCH", `/api/tasks/${id}/lane`, { body: withGuard({ lane }, guard), versioned: true }),
      changeTags: (id, change, guard) =>
        request("PATCH", `/api/tasks/${id}/tags`, { body: withGuard(change, guard), versioned: true }),
      removeTask: (id, guard) => request("DELETE", `/api/tasks/${id}`, { ...guardOnly(guard), versioned: true }),
      postUpdate: (id, body, guard) =>
        request("POST", `/api/tasks/${id}/updates`, { body: withGuard(body, guard), versioned: true }),
      addLane: (body, guard) => request("POST", "/api/lanes", { body: withGuard(body, guard), versioned: true }),
      editLane: (name, body, guard) =>
        request("PATCH", `/api/lanes/${enc(name)}`, { body: withGuard(body, guard), versioned: true }),
      removeLane: (name, guard) =>
        request("DELETE", `/api/lanes/${enc(name)}`, { ...guardOnly(guard), versioned: true }),
      addTag: (body, guard) => request("POST", "/api/tags", { body: withGuard(body, guard), versioned: true }),
      editTag: (name, body, guard) =>
        request("PATCH", `/api/tags/${enc(name)}`, { body: withGuard(body, guard), versioned: true }),
      removeTag: (name, opts, guard) =>
        request("DELETE", `/api/tags/${enc(name)}${opts?.force ? "?force=1" : ""}`, {
          ...guardOnly(guard),
          versioned: true,
        }),
    },
  };
}

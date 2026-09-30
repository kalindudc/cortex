import { Hono, type Context, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AddTaskInput,
  BodySearchError,
  ConflictError,
  MutationReuseError,
  mutationDigest,
  type ResourceKind,
  type StatusChange,
  type Store,
  type Task,
  type TaskStatus,
  validateAuthorTag,
  validateTagName,
  WriteGuardError,
} from "./store.ts";
import { backupNotificationInput, createBackup, defaultBackupPath } from "./backup.ts";
import { createEventPublisher, type EventKind, type EventPublisher } from "./events.ts";
import { CONTROL_PATHS, INSTANCE_HEADER, PREFER_VERSIONED } from "./api.ts";
import { memoryPhrases, memoryTerms, recencyIntent } from "./memory.ts";
import type {
  BlockedTransition,
  DaemonIdentity,
  HealthResponse,
  LaneStateSnapshot,
  MemorySearchResult,
  NotificationChange,
  PostUpdateResult,
  ReadyPayload,
  ResyncPayload,
  TagStateSnapshot,
  TaskStateSnapshot,
  TaskWriteResult,
  Versions,
  WorkspaceSnapshot,
  WriteGuard,
} from "./contracts.ts";
import pkg from "../package.json" with { type: "json" };

/**
 * Resolve a sensible default author for posted updates.
 * Cascade (first hit wins):
 *   1. `gh` CLI hosts file (~/.config/gh/hosts.yml) — the GitHub username
 *   2. `git config --global user.name`
 *   3. `os.hostname()` (without trailing .local)
 *   4. literal "me"
 * Cached per-process; UIs fetch via GET /api/me.
 */
let cachedAuthor: string | null = null;
function resolveAuthor(): string {
  if (cachedAuthor) return cachedAuthor;
  // 1. gh hosts.yml — simple regex, no yaml parser needed.
  try {
    const ghHosts = path.join(os.homedir(), ".config", "gh", "hosts.yml");
    if (fs.existsSync(ghHosts)) {
      const m = fs.readFileSync(ghHosts, "utf8").match(/^\s+user:\s*(\S+)/m);
      if (m?.[1]) return (cachedAuthor = m[1]);
    }
  } catch {
    /* fall through */
  }
  // 2. git config user.name
  try {
    const r = Bun.spawnSync(["git", "config", "--global", "user.name"]);
    const name = new TextDecoder().decode(r.stdout).trim();
    if (name) return (cachedAuthor = name);
  } catch {
    /* fall through */
  }
  // 3. hostname (strip trailing .local for prettier display)
  try {
    const h = os.hostname().replace(/\.local$/, "");
    if (h) return (cachedAuthor = h);
  } catch {
    /* fall through */
  }
  return (cachedAuthor = "me");
}

const VERSION = pkg.version;
const isStatus = (v: string): v is TaskStatus =>
  v === "draft" || v === "open" || v === "review" || v === "blocked" || v === "done";

// ---------- daemon runtime ----------

/**
 * What the control routes may do to the daemon hosting this app. Only
 * `cortex serve` supplies it, for the app on its private Unix socket;
 * in-process apps (withClient, tests) have none, so they have no
 * control routes.
 */
export interface DaemonControl {
  /** Begin the daemon's graceful shutdown (called after the 202 has been sent). */
  shutdown(): void;
}

/** Delay between answering a shutdown request and starting it, so the 202 leaves before listeners close. */
const SHUTDOWN_DELAY_MS = 25;

/** Per-connection SSE bounds: past either queue bound a client gets one `resync` instead of more frames. */
export type StreamLimits = { maxQueuedFrames: number; maxQueuedChars: number; heartbeatMs: number };

/**
 * Everything a daemon's app shares beyond the Store: its published identity
 * (null for in-process use; read per request) and the ONE event publisher
 * it publishes to and streams from.
 */
export interface DaemonRuntime {
  identity: DaemonIdentity | null;
  readonly events: EventPublisher;
  readonly stream: StreamLimits;
  /** Control over the hosting daemon (exposed as the control routes); null for in-process apps. */
  readonly control: DaemonControl | null;
}

export const DEFAULT_STREAM_LIMITS: StreamLimits = {
  maxQueuedFrames: 1024,
  maxQueuedChars: 8 * 1024 * 1024,
  // Below Bun.serve's default idleTimeout (10 s), which the listeners keep for ordinary
  // requests: a longer gap let Bun close every idle stream (clients saw a spurious reconnect).
  heartbeatMs: 5_000,
};

export function createRuntime(
  options: {
    identity?: DaemonIdentity | null;
    events?: EventPublisher;
    stream?: Partial<StreamLimits>;
    control?: DaemonControl | null;
  } = {},
): DaemonRuntime {
  return {
    identity: options.identity ?? null,
    events: options.events ?? createEventPublisher(),
    stream: { ...DEFAULT_STREAM_LIMITS, ...options.stream },
    control: options.control ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when a `Prefer` header lists the cortex-versioned preference (RFC 7240 token, any parameters). */
function prefersVersioned(header: string | undefined): boolean {
  if (!header) return false;
  return header.split(",").some(token => (token.split(/[;=]/)[0] ?? "").trim().toLowerCase() === PREFER_VERSIONED);
}

/** Remove the transport-level `guard` member, leaving the request's own fields. */
function splitGuard<T extends Record<string, unknown>>(body: T): { guard: unknown; fields: Omit<T, "guard"> } {
  const { guard, ...fields } = body;
  return { guard, fields };
}

export function buildApp(store: Store, runtime: DaemonRuntime = createRuntime()): Hono {
  const app = new Hono();

  const events = runtime.events;
  const publish = (kind: EventKind, payload: unknown): void => {
    events.publish(kind, payload);
  };

  /** Current versions of a live resource, read inside the write's transaction. */
  const versionsOf = (kind: ResourceKind, key: number | string): Versions => {
    const v = store.versions(kind, key);
    if (!v) throw new Error(`${kind} ${key} vanished inside its own write`);
    return v;
  };

  /**
   * Run one write so its result can be answered consistently: with a guard
   * mutationId through the receipt table (looked up BEFORE any guard or
   * existence check; a replay writes nothing and returns the stored result),
   * otherwise in one transaction. `write` returns everything the response
   * and the post-commit publish need, as JSON-serializable data.
   */
  const mutate = <R>(
    guard: unknown,
    operation: string,
    request: unknown,
    write: () => R,
  ): { result: R; replayed: boolean } => {
    const mutationId = isRecord(guard) ? guard.mutationId : undefined;
    if (mutationId === undefined) return { result: store.atomically(write), replayed: false };
    const expected = isRecord(guard) ? guard.expected : undefined;
    // runIdempotent validates the id at runtime (a non-string is a WriteGuardError, i.e. 400).
    const { value, replayed } = store.runIdempotent(
      mutationId as string,
      mutationDigest(operation, { request, expected }),
      write,
    );
    return { result: value, replayed };
  };

  /** Legacy JSON by default; the versioned DTO when the request carried `Prefer: cortex-versioned`. */
  const answer = (c: Context, legacy: unknown, versioned: unknown, status: 200 | 201 = 200): Response => {
    if (prefersVersioned(c.req.header("prefer"))) {
      c.header("Preference-Applied", PREFER_VERSIONED);
      return c.json(versioned, status);
    }
    return c.json(legacy, status);
  };

  /** Structured answers for the guard/receipt errors; null for anything else (legacy mapping applies). */
  const guardFailure = (c: Context, err: unknown): Response | null => {
    if (err instanceof ConflictError) {
      return c.json(
        {
          error: err.message,
          code: err.code,
          kind: err.kind,
          key: err.key,
          mismatches: err.mismatches,
          current: err.current,
        },
        412,
      );
    }
    if (err instanceof WriteGuardError) return c.json({ error: err.message, code: "invalid_guard" }, 400);
    if (err instanceof MutationReuseError) {
      return c.json({ error: err.message, code: "mutation_reused", mutationId: err.mutationId }, 409);
    }
    return null;
  };

  /** Legacy routes treat an unparseable body as `{}`; kept for their unchanged error paths. */
  const lenientBody = async (c: Context): Promise<Record<string, unknown>> => {
    const body: unknown = await c.req.json().catch(() => ({}));
    return isRecord(body) ? body : {};
  };

  /**
   * DELETE bodies are optional (`{ guard }`), but a body that is present and
   * malformed must not silently turn a guarded delete into an unguarded one.
   */
  const deleteBody = async (c: Context): Promise<Record<string, unknown> | Response> => {
    const text = await c.req.text();
    if (text.trim() === "") return {};
    try {
      const body: unknown = JSON.parse(text);
      if (isRecord(body)) return body;
    } catch {
      /* answered below */
    }
    return c.json({ error: "DELETE body must be a JSON object such as { guard }", code: "invalid_guard" }, 400);
  };

  /**
   * Publish a committed status change: its `status → x` audit row (as
   * `update.posted`, like any post, so loaded activity threads show it), its
   * notification, the task, and an actual transition into blocked. Callers
   * skip it on a deduplicated replay.
   */
  const publishStatus = (change: StatusChange, author: string): void => {
    publish("update.posted", change.audit);
    if (change.notification) publish("notification.added", change.notification);
    publish("task.updated", change.task);
    if (change.task.status === "blocked" && change.previous !== "blocked") {
      const transition: BlockedTransition = { task: change.task, previous: change.previous, author };
      publish("task.blocked", transition);
    }
  };

  // Bind requests to the instance a native client verified. A request
  // without the header is unbound (a legacy CLI).
  const checkInstance: MiddlewareHandler = async (c, next) => {
    const expected = c.req.header(INSTANCE_HEADER);
    if (expected !== undefined && expected !== runtime.identity?.instanceId) {
      return c.json(
        {
          error: `this daemon is not instance ${expected}; rediscover the daemon and retry`,
          code: "instance_mismatch",
        },
        421,
      );
    }
    await next();
  };
  app.use("/api/*", checkInstance);
  app.use("/events", checkInstance);

  // A published daemon names itself, which is how clients verify the
  // instance behind a socket.
  app.get("/api/health", c => {
    const health: HealthResponse = { ok: true, version: VERSION };
    if (runtime.identity !== null) health.identity = runtime.identity;
    return c.json(health);
  });

  // ---------- control: the daemon's socket app only ----------
  // Registered only when the code that bound this app's listener supplied
  // control (`cortex serve`, for its private socket); an in-process app never
  // has these routes, whatever a request's headers claim. checkInstance
  // (above) already rejects a different instance; control additionally
  // requires the header, so a request can never stop an instance it did not
  // verify.
  if (runtime.control !== null) {
    const control = runtime.control;
    const requireInstance: MiddlewareHandler = async (c, next) => {
      if (c.req.header(INSTANCE_HEADER) === undefined) {
        return c.json(
          { error: `control requests must name the daemon instance (${INSTANCE_HEADER})`, code: "instance_required" },
          400,
        );
      }
      await next();
    };

    app.post(CONTROL_PATHS.shutdown, requireInstance, c => {
      setTimeout(() => control.shutdown(), SHUTDOWN_DELAY_MS);
      return c.json({ ok: true, instanceId: runtime.identity?.instanceId ?? null }, 202);
    });
  }

  // The TUI's update composer takes its default author from this.
  app.get("/api/me", c => c.json({ author: resolveAuthor() }));

  // UI checks for pending migrations on boot so it can show a banner.
  app.get("/api/migrations", c => c.json({ pending: store.pendingMigrations() }));

  // ---------- snapshots ----------
  // Store reads are synchronous and every write publishes in the same turn
  // it commits, so the cursor read here covers exactly the writes this
  // snapshot can see: apply only stream events after it.
  app.get("/api/workspace", c => {
    const snapshot = store.workspace();
    const body: WorkspaceSnapshot = { identity: runtime.identity, cursor: events.cursor(), ...snapshot };
    return c.json(body);
  });

  app.get("/api/tasks/:id/state", c => {
    const state = store.taskState(Number(c.req.param("id")));
    if (!state) return c.json({ error: "not found" }, 404);
    const body: TaskStateSnapshot = { ...state, cursor: events.cursor() };
    return c.json(body);
  });

  // ---------- tasks ----------
  app.get("/api/tasks", c => {
    const lane = c.req.query("lane");
    const statusQ = c.req.query("status");
    const status = statusQ && isStatus(statusQ) ? statusQ : undefined;
    const searchArg = c.req.query("search")?.trim();
    const searchOpts: { search?: string; title?: string; tagQuery?: string } = {};
    if (searchArg) {
      if (searchArg.startsWith("@")) searchOpts.title = searchArg.slice(1).trim();
      else if (searchArg.startsWith("#")) searchOpts.tagQuery = searchArg.slice(1).trim();
      else searchOpts.search = searchArg;
    }
    // `tags=a,b`: tasks carrying EVERY listed tag (the CLI's `ls -t`), validated names.
    let tags: string[] | undefined;
    const tagsArg = c.req.query("tags");
    if (tagsArg) {
      try {
        tags = tagsArg
          .split(",")
          .map(s => s.trim())
          .filter(Boolean)
          .map(n => validateTagName(n));
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400);
      }
    }
    return c.json(store.listTasks({ lane, status, tags, ...searchOpts }));
  });

  app.post("/api/tasks", async c => {
    const { guard, fields: body } = splitGuard(
      (await lenientBody(c)) as {
        title?: string;
        untitled?: unknown;
        lane?: string;
        body?: string | null;
        priority?: number | null;
        status?: TaskStatus;
        tags?: string[];
        author?: unknown;
        guard?: unknown;
      },
    );
    if (body.untitled !== undefined && typeof body.untitled !== "boolean") {
      return c.json({ error: "untitled must be a boolean" }, 400);
    }
    const untitled = body.untitled === true;
    if (untitled && body.title !== undefined) {
      return c.json({ error: "an untitled create takes its title from the new id; omit title" }, 400);
    }
    const title = body.title;
    if (!untitled && (!title || typeof title !== "string")) {
      return c.json({ error: "title is required" }, 400);
    }
    // A bad status would otherwise reach the CHECK constraint as a 500; null keeps meaning "default".
    const statusArg: unknown = body.status;
    if (statusArg !== undefined && statusArg !== null && !(typeof statusArg === "string" && isStatus(statusArg))) {
      return c.json({ error: "invalid status" }, 400);
    }
    // Validate tag names BEFORE the write so a malformed tag short-circuits
    // with a 400 (not a 500) and never persists a task.
    if (Array.isArray(body.tags)) {
      try {
        body.tags.forEach(n => {
          validateTagName(n);
        });
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400);
      }
    }
    let author: string | undefined;
    if (body.author !== undefined) {
      try {
        if (typeof body.author !== "string") throw new Error("author must be a string");
        author = validateAuthorTag(body.author);
        if (!author) throw new Error("author cannot be empty");
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400);
      }
    }
    const fields = { lane: body.lane, body: body.body, priority: body.priority, status: body.status, tags: body.tags };
    const input: AddTaskInput = untitled
      ? { ...fields, untitled: true, author }
      : { ...fields, title: title as string, author };
    try {
      // The `created` notification row commits with the task; its author
      // stays the server-side default, as before. Resolved outside the
      // transaction: the first call may spawn `git config`.
      const notification = { author: resolveAuthor() };
      const { result, replayed } = mutate(guard, "task.create", { body }, () => {
        const created = store.createTask({ ...input, notification }, guard as WriteGuard);
        return { ...created, versions: versionsOf("task", created.task.id) };
      });
      if (!replayed) {
        publish("task.added", result.task);
        if (result.created) publish("update.posted", result.created);
        if (result.notification) publish("notification.added", result.notification);
      }
      const dto: TaskWriteResult = { task: result.task, versions: result.versions, replayed };
      return answer(c, result.task, dto, 201);
    } catch (err) {
      const failure = guardFailure(c, err);
      if (failure) return failure;
      throw err;
    }
  });

  app.get("/api/tasks/:id", c => {
    const id = Number(c.req.param("id"));
    const task = store.getTask(id);
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json(task);
  });

  // GET /api/tasks/:id/related — three buckets of tasks related to :id
  // (other tasks mentioning :id, tasks :id mentions, tasks sharing tags).
  // Returns 404 if :id itself doesn't exist; otherwise always 200 with
  // possibly-empty arrays. See Store.relatedTasks for bucket semantics.
  app.get("/api/tasks/:id/related", c => {
    const id = Number(c.req.param("id"));
    if (!store.getTask(id)) return c.json({ error: "not found" }, 404);
    return c.json(store.relatedTasks(id));
  });

  app.patch("/api/tasks/:id", async c => {
    const id = Number(c.req.param("id"));
    const { guard, fields } = splitGuard(
      (await lenientBody(c)) as {
        title?: string;
        body?: string | null;
        bodySearch?: string;
        bodyReplace?: string;
        priority?: number | null;
        guard?: unknown;
      },
    );
    // Validate the bodySearch / bodyReplace combo at the API boundary so
    // agents get a clean 400 (not a generic 500) when they misuse the
    // partial-edit shape. The store ALSO defends against these but
    // surfacing them here gives the right HTTP status without relying on
    // store error-message string matching.
    const hasSearch = fields.bodySearch !== undefined;
    const hasReplace = fields.bodyReplace !== undefined;
    const hasBody = fields.body !== undefined;
    if (hasSearch !== hasReplace) {
      return c.json({ error: "bodySearch and bodyReplace must be provided together" }, 400);
    }
    if (hasSearch && hasBody) {
      return c.json({ error: "bodySearch/bodyReplace cannot be combined with body (use one or the other)" }, 400);
    }
    if (hasSearch && fields.bodySearch?.length === 0) {
      return c.json({ error: "bodySearch cannot be empty" }, 400);
    }
    try {
      const { result, replayed } = mutate(guard, "task.edit", { id, body: fields }, () => {
        const task = store.editTask(id, fields, guard as WriteGuard);
        return { task, versions: versionsOf("task", id) };
      });
      if (!replayed) publish("task.updated", result.task);
      return answer(c, result.task, { ...result, replayed });
    } catch (err) {
      const failure = guardFailure(c, err);
      if (failure) return failure;
      // Anchor-based partial edits surface as 409 Conflict so agents can
      // distinguish "my anchor is stale, re-read and retry" from "the task
      // doesn't exist" (404) or "my request is malformed" (400).
      if (err instanceof BodySearchError) {
        const payload: { error: string; code: string; matches?: number } = {
          error: err.message,
          code: err.kind === "not_found" ? "body_search_not_found" : "body_search_ambiguous",
        };
        if (err.matches !== undefined) payload.matches = err.matches;
        return c.json(payload, 409);
      }
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  app.patch("/api/tasks/:id/status", async c => {
    const id = Number(c.req.param("id"));
    const { guard, fields: body } = splitGuard(
      (await lenientBody(c)) as { status?: string; author?: string; guard?: unknown },
    );
    const status = body.status;
    if (!status || !isStatus(status)) {
      return c.json({ error: "invalid status" }, 400);
    }
    // Author attribution for the audit-trail row. HTTP path is OPTIONAL: the
    // TUI never sends an author for a status change (the human is the
    // supervisor, the keypress IS the attribution), only attributed CLI calls
    // do (every `cortex update` requires --as <session-id>). That same flag
    // decides whether the transition persists a notification: no point
    // pinging the supervisor about a change they just made themselves.
    const isAttributed = body.author !== undefined;
    let author: string;
    if (isAttributed) {
      try {
        author = validateAuthorTag(body.author as string);
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400);
      }
    } else {
      author = resolveAuthor();
    }
    try {
      // The notification (attributed, actual change only) commits inside the
      // status transaction; everything publishes after commit, and nothing on
      // a deduplicated replay.
      const { result, replayed } = mutate(guard, "task.status", { id, body }, () => {
        const change = store.transitionStatus(id, status, { author, notify: isAttributed }, guard as WriteGuard);
        return { change, versions: versionsOf("task", id) };
      });
      if (!replayed) publishStatus(result.change, author);
      const dto: TaskWriteResult = { task: result.change.task, versions: result.versions, replayed };
      return answer(c, result.change.task, dto);
    } catch (err) {
      const failure = guardFailure(c, err);
      if (failure) return failure;
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  app.patch("/api/tasks/:id/lane", async c => {
    const id = Number(c.req.param("id"));
    const { guard, fields: body } = splitGuard((await lenientBody(c)) as { lane?: string; guard?: unknown });
    const lane = body.lane;
    if (!lane || typeof lane !== "string") {
      return c.json({ error: "lane is required" }, 400);
    }
    try {
      const { result, replayed } = mutate(guard, "task.lane", { id, body }, () => {
        const task = store.moveTask(id, lane, guard as WriteGuard);
        return { task, versions: versionsOf("task", id) };
      });
      if (!replayed) publish("task.updated", result.task);
      return answer(c, result.task, { ...result, replayed });
    } catch (err) {
      const failure = guardFailure(c, err);
      if (failure) return failure;
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.patch("/api/tasks/:id/tags", async c => {
    const id = Number(c.req.param("id"));
    const { guard, fields: body } = splitGuard(
      (await lenientBody(c)) as { set?: string[]; add?: string[]; remove?: string[]; guard?: unknown },
    );
    // Exactly one mode per request: keeps the resolution rule trivial and
    // matches the CLI's mutually-exclusive `--set-tags` / `--add-tag` /
    // `--rm-tag` flags.
    const modes = [body.set, body.add, body.remove].filter(Array.isArray).length;
    if (modes !== 1) {
      return c.json({ error: "exactly one of 'set', 'add', or 'remove' must be provided" }, 400);
    }
    try {
      let write: () => Task;
      if (Array.isArray(body.set)) {
        const names = body.set.map(n => validateTagName(n));
        write = () => store.setTaskTags(id, names, guard as WriteGuard);
      } else {
        // add/remove are atomic membership deltas in the Store (no
        // read-then-replace), so concurrent unrelated tag changes survive.
        // The task is checked first to keep the legacy 404-before-400 order.
        const delta = Array.isArray(body.add) ? { add: body.add } : { remove: body.remove };
        write = () => {
          if (!store.getTask(id)) throw new Error(`task ${id} not found`);
          return store.changeTaskTags(id, delta, guard as WriteGuard);
        };
      }
      const { result, replayed } = mutate(guard, "task.tags", { id, body }, () => {
        const task = write();
        return { task, versions: versionsOf("task", id) };
      });
      if (!replayed) publish("task.updated", result.task);
      return answer(c, result.task, { ...result, replayed });
    } catch (err) {
      const failure = guardFailure(c, err);
      if (failure) return failure;
      const msg = (err as Error).message;
      const code = msg.includes("not found") ? 404 : 400;
      return c.json({ error: msg }, code);
    }
  });

  app.delete("/api/tasks/:id", async c => {
    const id = Number(c.req.param("id"));
    const parsed = await deleteBody(c);
    if (parsed instanceof Response) return parsed;
    const { guard } = splitGuard(parsed);
    try {
      const { result, replayed } = mutate(guard, "task.remove", { id }, () =>
        store.removeTask(id, guard as WriteGuard),
      );
      if (!replayed) {
        publish("task.removed", { id });
        // The delete cascaded the task's notifications away.
        if (result.notifications > 0) {
          const change: NotificationChange = { action: "task_removed", id: null, task_id: id };
          publish("notification.changed", change);
        }
      }
      return answer(c, { ok: true }, { ok: true, replayed });
    } catch (err) {
      const failure = guardFailure(c, err);
      if (failure) return failure;
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  // ---------- updates ----------
  app.get("/api/tasks/:id/updates", c => {
    const id = Number(c.req.param("id"));
    return c.json(store.listUpdates(id));
  });

  app.post("/api/tasks/:id/updates", async c => {
    const id = Number(c.req.param("id"));
    const { guard, fields: body } = splitGuard(
      (await lenientBody(c)) as {
        author?: string;
        summary?: string;
        body?: string | null;
        status?: unknown;
        notify?: unknown;
        guard?: unknown;
      },
    );
    if (!body.summary || !body.author) {
      return c.json({ error: "author and summary are required" }, 400);
    }
    // Early HTTP rejection: validate the author tag here so a malformed
    // payload never reaches the Store (which would also throw, but
    // a 400 from the route is the user-facing contract).
    let author: string;
    try {
      author = validateAuthorTag(body.author);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    // Optional status in the SAME transaction as the message. `notify`
    // marks an attributed agent change: a human's own post never notifies.
    const status = body.status;
    if (status !== undefined && (typeof status !== "string" || !isStatus(status))) {
      return c.json({ error: "invalid status" }, 400);
    }
    if (body.notify !== undefined && typeof body.notify !== "boolean") {
      return c.json({ error: "notify must be a boolean" }, 400);
    }
    const summary = body.summary;
    const notify = body.notify === true;
    try {
      const { result, replayed } = mutate(guard, "update.post", { id, body }, () => {
        const posted = store.postUpdate(
          { task_id: id, author, summary, body: body.body, status, notify },
          guard as WriteGuard,
        );
        const task = store.getTask(id);
        if (!task) throw new Error(`task ${id} not found`);
        return { update: posted.update, change: posted.status, task, versions: versionsOf("task", id) };
      });
      if (!replayed) {
        publish("update.posted", result.update);
        if (result.change) publishStatus(result.change, author);
      }
      const dto: PostUpdateResult = {
        update: result.update,
        audit: result.change?.audit ?? null,
        task: result.task,
        versions: result.versions,
        replayed,
      };
      return answer(c, result.update, dto, 201);
    } catch (err) {
      const failure = guardFailure(c, err);
      if (failure) return failure;
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ---------- backup ----------
  // On-demand backup (the TUI's :backup). Runs inside the daemon process against a
  // separate read-only SQLite connection, so it is safe while the daemon is
  // serving writes. Restore remains CLI-only because it refuses a live daemon.
  app.post("/api/backup", async c => {
    if (store.databasePath() === ":memory:") return c.json({ error: "backup requires a file-backed database" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { rotate?: number; outPath?: string };
    const rotate = Number.isInteger(body.rotate) && Number(body.rotate) >= 0 ? Number(body.rotate) : 0;
    try {
      const outPath = typeof body.outPath === "string" && body.outPath.trim() ? body.outPath : defaultBackupPath();
      const { doc } = await createBackup({ liveDbPath: store.databasePath(), outPath, rotate });
      const bytes = fs.statSync(outPath).size;
      const notification = store.addNotification(
        backupNotificationInput({ outPath, bytes, stats: doc.stats, author: resolveAuthor() }),
      );
      publish("notification.added", notification);
      return c.json({ outPath, bytes, stats: doc.stats, notification });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // ---------- memory ----------
  // Agent memory: ranked recall over the derived FTS5 index and bodiless
  // stream rows carrying `synced` (the last BODY change). Reads only; the
  // index is created and reconciled inside Store.searchMemory.
  const positiveInt = (raw: string | undefined): number | undefined | null => {
    if (raw === undefined || raw === "") return undefined;
    return /^[1-9][0-9]*$/.test(raw) ? Number(raw) : null;
  };

  app.get("/api/memory/search", c => {
    const q = c.req.query("q")?.trim();
    if (!q) return c.json({ error: "q is required" }, 400);
    const limit = positiveInt(c.req.query("limit"));
    if (limit === null) return c.json({ error: "limit must be a positive integer" }, 400);
    let exclude: number[] | undefined;
    const excludeArg = c.req.query("exclude");
    if (excludeArg) {
      const ids = excludeArg.split(",").map(s => positiveInt(s.trim()));
      if (ids.some(id => id === null || id === undefined)) {
        return c.json({ error: "exclude must be a comma-separated list of positive task ids" }, 400);
      }
      exclude = ids as number[];
    }
    const lane = c.req.query("lane") || undefined;
    const boost = c.req.query("boost") || undefined;
    // Recency words leave the terms and only re-order equally covered hits.
    const { terms, recent } = recencyIntent(memoryTerms(q));
    const phrases = memoryPhrases(q);
    try {
      const hits = terms.length > 0 ? store.searchMemory(terms, { lane, boost, limit, exclude, recent, phrases }) : [];
      const body: MemorySearchResult = { terms, recent, hits };
      return c.json(body);
    } catch (err) {
      return c.json({ error: `memory search unavailable: ${(err as Error).message}` }, 500);
    }
  });

  app.get("/api/memory/streams", c => {
    const limit = positiveInt(c.req.query("limit"));
    if (limit === null) return c.json({ error: "limit must be a positive integer" }, 400);
    let author: string | undefined;
    const authorArg = c.req.query("author");
    if (authorArg) {
      try {
        author = validateAuthorTag(authorArg);
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400);
      }
    }
    const active = c.req.query("active") === "1";
    return c.json(
      store.memoryStreams({
        lane: c.req.query("lane") || undefined,
        excludeLane: c.req.query("excludeLane") || undefined,
        author,
        active,
        limit,
      }),
    );
  });

  app.get("/api/memory/streams/:id", c => {
    const stream = store.memoryStream(Number(c.req.param("id")));
    if (!stream) return c.json({ error: "not found" }, 404);
    return c.json(stream);
  });

  // ---------- notifications ----------
  // Persisted notification feed. Read endpoint returns rows newest-first.
  // Mutation endpoints validate :id as a number and return 400 on NaN;
  // none of these accept a request body. An acknowledgement that changed a
  // row publishes a `notification.changed` invalidation so every
  // other connected client converges; a no-op publishes nothing.
  const notificationChanged = (action: NotificationChange["action"], id: number | null): void => {
    const change: NotificationChange = { action, id, task_id: null };
    publish("notification.changed", change);
  };

  app.get("/api/notifications", c => c.json(store.listNotifications()));

  app.patch("/api/notifications/:id/read", c => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    if (store.markNotificationRead(id)) notificationChanged("read", id);
    return c.json({ ok: true });
  });

  app.patch("/api/notifications/:id/unread", c => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    if (store.markNotificationUnread(id)) notificationChanged("unread", id);
    return c.json({ ok: true });
  });

  app.post("/api/notifications/read-all", c => {
    if (store.markAllNotificationsRead() > 0) notificationChanged("read_all", null);
    return c.json({ ok: true });
  });

  app.delete("/api/notifications/:id", c => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    if (store.dismissNotification(id)) notificationChanged("dismiss", id);
    return c.json({ ok: true });
  });

  app.delete("/api/notifications", c => {
    if (store.clearNotifications() > 0) notificationChanged("clear", null);
    return c.json({ ok: true });
  });

  // ---------- lanes ----------
  app.get("/api/lanes", c => c.json(store.listLanes()));

  // A lane, its member count and versions from one read, for guarded edits/deletes (TUI :lanes).
  app.get("/api/lanes/:name/state", c => {
    const state = store.laneState(c.req.param("name"));
    if (!state) return c.json({ error: "not found" }, 404);
    const body: LaneStateSnapshot = { ...state, cursor: events.cursor() };
    return c.json(body);
  });

  app.post("/api/lanes", async c => {
    const { guard, fields: body } = splitGuard(
      (await lenientBody(c)) as { name?: string; color?: string | null; sort?: number; guard?: unknown },
    );
    const name = body.name;
    if (!name || typeof name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }
    try {
      const { result, replayed } = mutate(guard, "lane.add", { body }, () => {
        const lane = store.addLane({ name, color: body.color, sort: body.sort }, guard as WriteGuard);
        return { lane, versions: versionsOf("lane", lane.name) };
      });
      if (!replayed) publish("lane.changed", result.lane);
      return answer(c, result.lane, { ...result, replayed }, 201);
    } catch (err) {
      const failure = guardFailure(c, err);
      if (failure) return failure;
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.patch("/api/lanes/:name", async c => {
    const name = c.req.param("name");
    const { guard, fields } = splitGuard(
      (await lenientBody(c)) as { color?: string | null; sort?: number; rename?: string; guard?: unknown },
    );
    try {
      const { result, replayed } = mutate(guard, "lane.edit", { name, body: fields }, () => {
        const lane = store.editLane(name, fields, guard as WriteGuard);
        return { lane, versions: versionsOf("lane", lane.name) };
      });
      if (!replayed) publish("lane.changed", result.lane);
      return answer(c, result.lane, { ...result, replayed });
    } catch (err) {
      const failure = guardFailure(c, err);
      if (failure) return failure;
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  app.delete("/api/lanes/:name", async c => {
    const name = c.req.param("name");
    const parsed = await deleteBody(c);
    if (parsed instanceof Response) return parsed;
    const { guard } = splitGuard(parsed);
    try {
      const { replayed } = mutate(guard, "lane.remove", { name }, () => {
        store.removeLane(name, guard as WriteGuard);
        return null;
      });
      if (!replayed) publish("lane.changed", { removed: name });
      return answer(c, { ok: true }, { ok: true, replayed });
    } catch (err) {
      const failure = guardFailure(c, err);
      if (failure) return failure;
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ---------- tags ----------
  // Mirrors /api/lanes: GET list, POST add, PATCH edit, DELETE remove.
  // Every write publishes `tag.changed`; clients re-read /api/tags on it.
  // Renames/forced removals cascade into tasks.
  app.get("/api/tags", c => c.json(store.listTags()));

  // A tag, its member count (a delete's impact) and versions from one read (TUI :tags).
  app.get("/api/tags/:name/state", c => {
    const state = store.tagState(c.req.param("name"));
    if (!state) return c.json({ error: "not found" }, 404);
    const body: TagStateSnapshot = { ...state, cursor: events.cursor() };
    return c.json(body);
  });

  app.post("/api/tags", async c => {
    const { guard, fields: body } = splitGuard(
      (await lenientBody(c)) as { name?: string; color?: string | null; guard?: unknown },
    );
    const name = body.name;
    if (!name || typeof name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }
    try {
      const { result, replayed } = mutate(guard, "tag.add", { body }, () => {
        const tag = store.addTag({ name, color: body.color }, guard as WriteGuard);
        return { tag, versions: versionsOf("tag", tag.name) };
      });
      if (!replayed) publish("tag.changed", result.tag);
      return answer(c, result.tag, { ...result, replayed }, 201);
    } catch (err) {
      const failure = guardFailure(c, err);
      if (failure) return failure;
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.patch("/api/tags/:name", async c => {
    const name = c.req.param("name");
    const { guard, fields } = splitGuard(
      (await lenientBody(c)) as { color?: string | null; rename?: string; guard?: unknown },
    );
    try {
      const { result, replayed } = mutate(guard, "tag.edit", { name, body: fields }, () => {
        const tag = store.editTag(name, fields, guard as WriteGuard);
        return { tag, versions: versionsOf("tag", tag.name) };
      });
      if (!replayed) publish("tag.changed", result.tag);
      return answer(c, result.tag, { ...result, replayed });
    } catch (err) {
      const failure = guardFailure(c, err);
      if (failure) return failure;
      const msg = (err as Error).message;
      const code = msg.includes("not found") ? 404 : 400;
      return c.json({ error: msg }, code);
    }
  });

  app.delete("/api/tags/:name", async c => {
    const name = c.req.param("name");
    const force = c.req.query("force") === "1";
    const parsed = await deleteBody(c);
    if (parsed instanceof Response) return parsed;
    const { guard } = splitGuard(parsed);
    try {
      const { replayed } = mutate(guard, "tag.remove", { name, force }, () => {
        store.removeTag(name, { force }, guard as WriteGuard);
        return null;
      });
      if (!replayed) publish("tag.changed", { removed: name });
      return answer(c, { ok: true }, { ok: true, replayed });
    } catch (err) {
      const failure = guardFailure(c, err);
      if (failure) return failure;
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ---------- SSE ----------
  // Subscribe FIRST, then send `ready` carrying the cursor at subscription:
  // a client snapshots after `ready` and applies only events after the
  // snapshot's cursor, so nothing published in between is lost. Each
  // event's id is its `<epoch>:<seq>` cursor; names and data are the legacy
  // ones. A slow reader's queue is bounded: past either bound (one frame
  // larger than the character bound included, even into an empty queue) the
  // queue is dropped for ONE `resync` frame whose cursor then tracks every
  // further event until it is written, so memory never grows with the backlog.
  app.get("/events", c =>
    streamSSE(c, async stream => {
      const limits = runtime.stream;
      type Frame = { event: string; data: string; id?: string };
      const queue: Frame[] = [];
      let queuedChars = 0;
      let resyncAt: string | null = null;
      let wake: (() => void) | null = null;
      const nudge = (): void => {
        const resume = wake;
        wake = null;
        resume?.();
      };
      const enqueue = (frame: Frame): void => {
        queue.push(frame);
        queuedChars += frame.data.length;
        nudge();
      };
      const unsubscribe = events.subscribe(ev => {
        if (resyncAt !== null) {
          resyncAt = ev.cursor;
          return;
        }
        const data = JSON.stringify(ev.payload);
        const full = queue.length >= limits.maxQueuedFrames || queuedChars + data.length > limits.maxQueuedChars;
        // Even with an empty queue (the writer may still be blocked on an earlier
        // frame): a single frame past the bound is never retained.
        if (full) {
          queue.length = 0;
          queuedChars = 0;
          resyncAt = ev.cursor;
          nudge();
          return;
        }
        enqueue({ event: ev.kind, data, id: ev.cursor });
      });
      const cursor = events.cursor();
      const ready: ReadyPayload = {
        cursor,
        epoch: events.epoch,
        instanceId: runtime.identity?.instanceId ?? null,
        databaseId: store.databaseId(),
      };
      enqueue({ event: "ready", data: JSON.stringify(ready), id: cursor });
      // Legacy heartbeat framing (no id), only while idle so it never queues behind events.
      const heartbeat = setInterval(() => {
        if (queue.length === 0 && resyncAt === null) enqueue({ event: "heartbeat", data: String(Date.now()) });
      }, limits.heartbeatMs);
      stream.onAbort(() => {
        unsubscribe();
        clearInterval(heartbeat);
        nudge();
      });
      try {
        while (!stream.aborted) {
          let frame: Frame | undefined;
          if (resyncAt !== null) {
            const resync: ResyncPayload = { reason: "overflow", cursor: resyncAt };
            frame = { event: "resync", data: JSON.stringify(resync), id: resyncAt };
            resyncAt = null;
          } else {
            frame = queue.shift();
            if (frame) queuedChars -= frame.data.length;
          }
          if (!frame) {
            await new Promise<void>(resolve => {
              wake = resolve;
            });
            continue;
          }
          await stream.writeSSE(frame);
        }
      } finally {
        unsubscribe();
        clearInterval(heartbeat);
      }
    }),
  );

  return app;
}

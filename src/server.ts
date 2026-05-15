import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Store, validateAuthorTag, validateTagName, BodySearchError, type TaskStatus } from "./store.ts";
import { emit, subscribe, type CortexEvent } from "./events.ts";
import pkg from "../package.json" with { type: "json" };
// `with { type: "file" }` returns a string PATH (not file contents) that
// `bun build --compile` rewrites to point at the embedded blob. Read the
// contents at request time via Bun.file(...).text() (or .bytes() for
// non-text). The UI is shipped as a single bundle.js + bundle.css produced
// by `pnpm run ui:build` (Bun bundler over src/ui/index.tsx). Source still
// lives in modular files under src/ui/; the bundler is what fuses them.
//
// Build order is enforced by scripts/build.sh: it runs `pnpm run ui:build`
// FIRST so out/bundle.{js,css} exist on disk before this server file is
// embedded by `bun build --compile`. If the bundler outputs are missing at
// server-build time, `bun build --compile` fails loudly with a missing-file
// error — which is the desired behavior (it surfaces a broken build).
import indexHtmlPath from "./ui/index.html" with { type: "file" };
import bundleJsPath from "../out/bundle.js" with { type: "file" };
import bundleCssPath from "../out/bundle.css" with { type: "file" };

// Map browser route -> embedded file path + content type. Each entry is
// served with Cache-Control: no-store so dev edits never sit invisible behind
// a stale cache, and so any shipped fix is picked up on the next reload.
const UI_ASSETS: Record<string, { path: string; type: string }> = {
  "/bundle.js": { path: bundleJsPath, type: "application/javascript; charset=utf-8" },
  "/bundle.css": { path: bundleCssPath, type: "text/css; charset=utf-8" },
};

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

export function buildApp(store: Store): Hono {
  const app = new Hono();

  app.get("/", async c => {
    // Local single-user app served from a Bun.embed bundle. We never want the
    // browser to cache the HTML; otherwise dev edits (and shipped fixes) sit
    // invisible behind a stale page until the user discovers Cmd-Shift-R.
    c.header("Cache-Control", "no-store, must-revalidate");
    // bun-types declares `*.html` imports as HTMLBundle, but the `with { type: "file" }`
    // attribute we use makes Bun resolve this to a string path at runtime. Cast at
    // the boundary rather than augmenting bun-types.
    return c.html(await Bun.file(indexHtmlPath as unknown as string).text());
  });

  // Static UI modules — CSS + ESM JS modules. Same no-store policy so the
  // browser always picks up the latest module graph after a reload. We use
  // c.body() with raw bytes so non-ASCII chars survive without re-encoding.
  for (const [route, { path, type }] of Object.entries(UI_ASSETS)) {
    app.get(route, async c => {
      c.header("Cache-Control", "no-store, must-revalidate");
      c.header("Content-Type", type);
      return c.body(await Bun.file(path).bytes());
    });
  }

  app.get("/api/health", c => c.json({ ok: true, version: VERSION }));

  // UI bootstraps the default author for the post-update form from this.
  app.get("/api/me", c => c.json({ author: resolveAuthor() }));

  // UI checks for pending migrations on boot so it can show a banner.
  app.get("/api/migrations", c => c.json({ pending: store.pendingMigrations() }));

  // ---------- tasks ----------
  app.get("/api/tasks", c => {
    const lane = c.req.query("lane");
    const statusQ = c.req.query("status");
    const status = statusQ && isStatus(statusQ) ? statusQ : undefined;
    return c.json(store.listTasks({ lane, status }));
  });

  app.post("/api/tasks", async c => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      lane?: string;
      body?: string | null;
      priority?: number;
      status?: TaskStatus;
      tags?: string[];
    };
    if (!body.title || typeof body.title !== "string") {
      return c.json({ error: "title is required" }, 400);
    }
    // Validate tag names BEFORE addTask so a malformed tag short-circuits
    // with a 400 (not a 500) and never persists a task we'd then have to
    // roll back.
    if (Array.isArray(body.tags)) {
      try {
        body.tags.forEach(n => {
          validateTagName(n);
        });
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400);
      }
    }
    let task = store.addTask(body as { title: string });
    if (Array.isArray(body.tags) && body.tags.length > 0) {
      task = store.setTaskTags(task.id, body.tags);
    }
    emit({ kind: "task.added", payload: task, ts: Date.now() });
    // Persist a bell-drawer notification so the row survives a dashboard
    // reload (the previous in-memory ring lost everything on refresh).
    // `status` snapshots the value the task was created with; the SSE
    // payload IS the row so the drawer can prepend it without a refetch.
    const notif = store.addNotification({
      task_id: task.id,
      author: resolveAuthor(),
      status: task.status,
      title: `[${task.id}] ${task.title}`,
      message: "created",
    });
    emit({ kind: "notification.added", payload: notif, ts: Date.now() });
    return c.json(task, 201);
  });

  app.get("/api/tasks/:id", c => {
    const id = Number(c.req.param("id"));
    const task = store.getTask(id);
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json(task);
  });

  app.patch("/api/tasks/:id", async c => {
    const id = Number(c.req.param("id"));
    const fields = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      body?: string | null;
      bodySearch?: string;
      bodyReplace?: string;
      priority?: number;
    };
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
      const task = store.editTask(id, fields);
      emit({ kind: "task.updated", payload: task, ts: Date.now() });
      return c.json(task);
    } catch (err) {
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
    const body = (await c.req.json().catch(() => ({}))) as {
      status?: string;
      author?: string;
    };
    if (!body.status || !isStatus(body.status)) {
      return c.json({ error: "invalid status" }, 400);
    }
    // Author attribution for the audit-trail row written inside setStatus.
    // HTTP path is OPTIONAL (humans on the dashboard never type their name);
    // fall back to the existing resolveAuthor() cascade.
    let author: string;
    if (body.author !== undefined) {
      try {
        author = validateAuthorTag(body.author);
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400);
      }
    } else {
      author = resolveAuthor();
    }
    try {
      // Capture prev BEFORE setStatus mutates the row — we only fire a
      // notification on an actual status change, mirroring the
      // dashboard's old client-side `lastStatus` Map at
      // src/ui/index.tsx:103. The store does its own getTask lookup
      // inside setStatus; this extra read is the cheapest way to make
      // the transition decision server-side.
      const prev = store.getTask(id);
      const task = store.setStatus(id, body.status, { author });
      if (prev && prev.status !== task.status) {
        const notif = store.addNotification({
          task_id: task.id,
          author,
          status: task.status,
          title: `[${task.id}] ${task.title}`,
          message: `${prev.status} \u2192 ${task.status}`,
        });
        emit({ kind: "notification.added", payload: notif, ts: Date.now() });
      }
      emit({ kind: "task.updated", payload: task, ts: Date.now() });
      return c.json(task);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  app.patch("/api/tasks/:id/lane", async c => {
    const id = Number(c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as { lane?: string };
    if (!body.lane || typeof body.lane !== "string") {
      return c.json({ error: "lane is required" }, 400);
    }
    try {
      const task = store.moveTask(id, body.lane);
      emit({ kind: "task.updated", payload: task, ts: Date.now() });
      return c.json(task);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.patch("/api/tasks/:id/tags", async c => {
    const id = Number(c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as {
      set?: string[];
      add?: string[];
      remove?: string[];
    };
    // Exactly one mode per request: keeps the resolution rule trivial and
    // matches the CLI's mutually-exclusive `--set-tags` / `--add-tag` /
    // `--rm-tag` flags.
    const modes = [body.set, body.add, body.remove].filter(Array.isArray).length;
    if (modes !== 1) {
      return c.json({ error: "exactly one of 'set', 'add', or 'remove' must be provided" }, 400);
    }
    try {
      let next: string[];
      if (Array.isArray(body.set)) {
        next = body.set.map(n => validateTagName(n));
      } else {
        const existing = store.getTask(id);
        if (!existing) return c.json({ error: `task ${id} not found` }, 404);
        if (Array.isArray(body.add)) {
          const adds = body.add.map(n => validateTagName(n));
          next = Array.from(new Set([...existing.tags, ...adds]));
        } else {
          const rms = new Set((body.remove ?? []).map(n => validateTagName(n)));
          next = existing.tags.filter(n => !rms.has(n));
        }
      }
      const task = store.setTaskTags(id, next);
      emit({ kind: "task.updated", payload: task, ts: Date.now() });
      return c.json(task);
    } catch (err) {
      const msg = (err as Error).message;
      const code = msg.includes("not found") ? 404 : 400;
      return c.json({ error: msg }, code);
    }
  });

  app.delete("/api/tasks/:id", c => {
    const id = Number(c.req.param("id"));
    try {
      store.removeTask(id);
      emit({ kind: "task.removed", payload: { id }, ts: Date.now() });
      return c.json({ ok: true });
    } catch (err) {
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
    const body = (await c.req.json().catch(() => ({}))) as {
      author?: string;
      summary?: string;
      body?: string | null;
    };
    if (!body.summary || !body.author) {
      return c.json({ error: "author and summary are required" }, 400);
    }
    // Early HTTP rejection: validate the author tag here so a malformed
    // dashboard payload never reaches Store.addUpdate (which would also
    // throw, but a 400 from the route is the user-facing contract).
    try {
      body.author = validateAuthorTag(body.author);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    try {
      const update = store.addUpdate({
        task_id: id,
        author: body.author,
        summary: body.summary,
        body: body.body,
      });
      emit({ kind: "update.posted", payload: update, ts: Date.now() });
      return c.json(update, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ---------- authors (derived view from updates table) ----------
  // Powers the dashboard's Authors tab. No new schema, no new column — just
  // a GROUP BY over the last 24h of updates. See Store.listAuthorsLast24h.
  app.get("/api/authors", c => c.json(store.listAuthorsLast24h()));

  // ---------- notifications ----------
  // Persisted bell-drawer feed. Read endpoint returns rows newest-first.
  // Mutation endpoints validate :id as a number and return 400 on NaN;
  // none of these accept a request body. No SSE emit on read/dismiss/
  // clear — the drawer mutates its local signal optimistically and the
  // canonical state is re-fetched on the next refresh().
  app.get("/api/notifications", c => c.json(store.listNotifications()));

  app.patch("/api/notifications/:id/read", c => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    store.markNotificationRead(id);
    return c.json({ ok: true });
  });

  app.patch("/api/notifications/:id/unread", c => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    store.markNotificationUnread(id);
    return c.json({ ok: true });
  });

  app.post("/api/notifications/read-all", c => {
    store.markAllNotificationsRead();
    return c.json({ ok: true });
  });

  app.delete("/api/notifications/:id", c => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    store.dismissNotification(id);
    return c.json({ ok: true });
  });

  app.delete("/api/notifications", c => {
    store.clearNotifications();
    return c.json({ ok: true });
  });

  // ---------- lanes ----------
  app.get("/api/lanes", c => c.json(store.listLanes()));

  app.post("/api/lanes", async c => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      color?: string | null;
      sort?: number;
    };
    if (!body.name || typeof body.name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }
    try {
      const lane = store.addLane(body as { name: string });
      emit({ kind: "lane.changed", payload: lane, ts: Date.now() });
      return c.json(lane, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.patch("/api/lanes/:name", async c => {
    const name = c.req.param("name");
    const fields = (await c.req.json().catch(() => ({}))) as {
      color?: string | null;
      sort?: number;
      rename?: string;
    };
    try {
      const lane = store.editLane(name, fields);
      emit({ kind: "lane.changed", payload: lane, ts: Date.now() });
      return c.json(lane);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  app.delete("/api/lanes/:name", c => {
    const name = c.req.param("name");
    try {
      store.removeLane(name);
      emit({ kind: "lane.changed", payload: { removed: name }, ts: Date.now() });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ---------- tags ----------
  // Mirrors /api/lanes: GET list, POST add, PATCH edit, DELETE remove.
  // Every write emits `tag.changed`; the dashboard's refresh() re-fetches
  // /api/tags on every event, so no per-event handler is needed in v1.
  app.get("/api/tags", c => c.json(store.listTags()));

  app.post("/api/tags", async c => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      color?: string | null;
    };
    if (!body.name || typeof body.name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }
    try {
      const tag = store.addTag(body as { name: string });
      emit({ kind: "tag.changed", payload: tag, ts: Date.now() });
      return c.json(tag, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.patch("/api/tags/:name", async c => {
    const name = c.req.param("name");
    const fields = (await c.req.json().catch(() => ({}))) as {
      color?: string | null;
      rename?: string;
    };
    try {
      const tag = store.editTag(name, fields);
      emit({ kind: "tag.changed", payload: tag, ts: Date.now() });
      return c.json(tag);
    } catch (err) {
      const msg = (err as Error).message;
      const code = msg.includes("not found") ? 404 : 400;
      return c.json({ error: msg }, code);
    }
  });

  app.delete("/api/tags/:name", c => {
    const name = c.req.param("name");
    const force = c.req.query("force") === "1";
    try {
      store.removeTag(name, { force });
      emit({ kind: "tag.changed", payload: { removed: name }, ts: Date.now() });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ---------- dev-only live-reload ----------
  // Gated by CORTEX_DEV=1 (set by scripts/dev.sh). The route is simply not
  // registered when the env var is missing, so production `cortex serve`
  // returns 404 for /api/dev-reload — no "is dev?" check leaks into the
  // hot path. We watch out/bundle.js with node:fs.watch on macOS (FSEvents
  // under the hood; reliable for a single file). Debounce ~100ms so a
  // single bun-build write doesn't fan out into 3 reloads. The CSS slice
  // pipeline rewrites bundle.css, which doesn't trigger this watcher —
  // but build-css.sh re-touches bundle.js? No: it doesn't. So we ALSO
  // watch out/bundle.css and reload on either. The browser's full reload
  // pulls both fresh anyway.
  if (process.env.CORTEX_DEV === "1") {
    console.log("[cortex] dev-reload enabled — GET /api/dev-reload (CORTEX_DEV=1)");
    const listeners = new Set<() => void>();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const fanout = (): void => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        for (const fn of listeners) {
          try {
            fn();
          } catch {
            /* listener already gone — cleaned up on stream abort */
          }
        }
      }, 100);
    };
    const watchOne = (p: string): void => {
      try {
        // recursive:false on a single file path; fs.watch tolerates the
        // file going away briefly during atomic rewrites.
        fs.watch(p, () => fanout());
      } catch (e) {
        console.warn(`[cortex] dev-reload: cannot watch ${p}: ${(e as Error).message}`);
      }
    };
    const bundleJsAbs = path.resolve(import.meta.dir, "..", "out", "bundle.js");
    const bundleCssAbs = path.resolve(import.meta.dir, "..", "out", "bundle.css");
    watchOne(bundleJsAbs);
    watchOne(bundleCssAbs);

    app.get("/api/dev-reload", c =>
      streamSSE(c, async stream => {
        const onChange = (): void => {
          void stream.writeSSE({
            event: "reload",
            data: JSON.stringify({ mtime: Date.now() }),
          });
        };
        listeners.add(onChange);
        stream.onAbort(() => {
          listeners.delete(onChange);
        });
        // Initial hello so the client can confirm the channel is live.
        await stream.writeSSE({ event: "hello", data: String(Date.now()) });
        while (!stream.aborted) {
          await stream.sleep(25000);
          if (stream.aborted) break;
          await stream.writeSSE({ event: "ping", data: String(Date.now()) });
        }
      }),
    );
  }

  // ---------- SSE ----------
  app.get("/events", c =>
    streamSSE(c, async stream => {
      const unsub = subscribe((ev: CortexEvent) => {
        void stream.writeSSE({
          event: ev.kind,
          data: JSON.stringify(ev.payload),
          id: String(ev.ts),
        });
      });
      stream.onAbort(() => unsub());
      while (!stream.aborted) {
        await stream.sleep(15000);
        if (stream.aborted) break;
        await stream.writeSSE({ event: "heartbeat", data: String(Date.now()) });
      }
    }),
  );

  return app;
}

export type ServerHandle = {
  port: number;
  /** Loopback URL written to `cortex.url`; used by the CLI client. */
  url: string;
  /** User-facing URL written to `cortex.browser-url`; opened in a browser. */
  browserUrl: string;
  stop(): Promise<void>;
};

export function startServer({
  port,
  host = "cortex.localhost",
  store,
}: {
  port: number;
  host?: string;
  store: Store;
}): ServerHandle {
  const app = buildApp(store);
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: app.fetch,
  });
  const resolvedPort = server.port ?? port;
  return {
    port: resolvedPort,
    url: `http://127.0.0.1:${resolvedPort}`,
    browserUrl: `http://${host}:${resolvedPort}`,
    async stop() {
      server.stop(true);
    },
  };
}

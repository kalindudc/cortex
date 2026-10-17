import os from "node:os";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { CortexRunner } from "./cli";
import {
  type CortexAuthor,
  type CortexStatus,
  classifyAuthor,
  planProgress,
  STATUSES,
  updateKind,
} from "./detail";

export type { CortexAuthor, CortexStatus } from "./detail";

export type CortexThreadState = {
  threadId: string;
  lane: string | null;
  /** The pinned task when it is still listed, else the most active one. */
  focusTaskId: number | null;
  pinnedTaskId: number | null;
  /** This cortex can record changes as the user (`update --as-me`). */
  canWrite: boolean;
  links: Array<{
    id: number;
    title: string;
    status: CortexStatus;
    lane: string;
    activity: number;
    /** The thread posted to it. */
    authored: boolean;
    /** Linked by hand. */
    manual: boolean;
  }>;
  health: { kind: "ok" | "stale" | "blocked" | "error"; message?: string };
};

export type CortexUpdate = {
  id: number;
  author: string;
  summary: string;
  body: string | null;
  created: number;
  kind: "note" | "status" | "created";
  /** The status a `status` row moved to. */
  to?: CortexStatus;
};

export type CortexTaskDetail = {
  task: {
    id: number;
    title: string;
    status: CortexStatus;
    lane: string;
    tags: string[];
    body: string | null;
    created: number;
    updated: number;
  };
  /** Oldest first, as cortex stores them. */
  updates: CortexUpdate[];
  staleness: { verdict: "fresh" | "stale" | "unverifiable"; reason?: string };
  /** The body's last sync and what changed since (from `cortex memory show`). */
  sync: {
    syncedAt: number;
    changed: string[];
    missing: string[];
    old: boolean;
    ageDays: number;
    /** Updates after the body sync that are not status audits. */
    notFolded: number;
  };
  progress: { done: number; total: number } | null;
  authors: Record<string, CortexAuthor>;
};

/** A task in a search result or suggestion list. */
export type CortexTaskRow = { id: number; title: string; lane: string; status: CortexStatus };

export type CortexState = {
  threadState(threadId: string): Promise<CortexThreadState>;
  task(threadId: string, taskId: number): Promise<CortexTaskDetail>;
  pin(threadId: string, taskId: number | null): Promise<CortexThreadState>;
  link(threadId: string, taskId: number): Promise<CortexThreadState>;
  unlink(threadId: string, taskId: number): Promise<CortexThreadState>;
  /** Records the change as the user (`update --as-me`) and returns the fresh detail. */
  setStatus(threadId: string, taskId: number, status: CortexStatus): Promise<CortexTaskDetail>;
  postNote(
    threadId: string,
    taskId: number,
    note: { summary: string; body: string | null },
    status?: CortexStatus,
  ): Promise<CortexTaskDetail>;
  searchTasks(query: string): Promise<CortexTaskRow[]>;
  recentTasks(threadId: string): Promise<{ lane: string | null; tasks: CortexTaskRow[] }>;
  warmProject(threadId: string): Promise<void>;
  refreshLane(lane: string): void;
  /** Drops the task's cached reads now; refreshes its lane's primers (resolved with `show` when `lane` is unknown). */
  refreshTask(taskId: number, lane?: string): Promise<void>;
  refreshAll(): Promise<void>;
  primerFor(projectId: string): string | null;
  laneFor(projectId: string): string | null;
  /** The thread's project and its checkout when that checkout is on this server's machine. */
  locate(threadId: string): Promise<{ projectId: string; cwd: string | null }>;
};

/** Realtime channels the server publishes; payloads are `{ threadId }`, `{ taskId }` and null. */
export type CortexRealtimeChannel = "thread" | "task" | "all";

const taskId = z.number().int().positive();
const statusSchema = z.enum(STATUSES);

export const threadStateSchema: z.ZodType<CortexThreadState> = z.object({
  threadId: z.string(),
  lane: z.string().nullable(),
  focusTaskId: taskId.nullable(),
  pinnedTaskId: taskId.nullable(),
  canWrite: z.boolean(),
  links: z.array(
    z.object({
      id: taskId,
      title: z.string(),
      status: statusSchema,
      lane: z.string(),
      activity: z.number(),
      authored: z.boolean(),
      manual: z.boolean(),
    }),
  ),
  health: z.object({ kind: z.enum(["ok", "stale", "blocked", "error"]), message: z.string().optional() }),
});

export const taskRowSchema: z.ZodType<CortexTaskRow> = z.object({
  id: taskId,
  title: z.string(),
  lane: z.string(),
  status: statusSchema,
});

export const taskDetailSchema: z.ZodType<CortexTaskDetail> = z.object({
  task: z.object({
    id: taskId,
    title: z.string(),
    status: statusSchema,
    lane: z.string(),
    tags: z.array(z.string()),
    body: z.string().nullable(),
    created: z.number(),
    updated: z.number(),
  }),
  updates: z.array(
    z.object({
      id: z.number(),
      author: z.string(),
      summary: z.string(),
      body: z.string().nullable(),
      created: z.number(),
      kind: z.enum(["note", "status", "created"]),
      to: statusSchema.optional(),
    }),
  ),
  staleness: z.object({ verdict: z.enum(["fresh", "stale", "unverifiable"]), reason: z.string().optional() }),
  sync: z.object({
    syncedAt: z.number(),
    changed: z.array(z.string()),
    missing: z.array(z.string()),
    old: z.boolean(),
    ageDays: z.number(),
    notFolded: z.number(),
  }),
  progress: z.object({ done: z.number(), total: z.number() }).nullable(),
  authors: z.record(
    z.string(),
    z.object({
      kind: z.enum(["you", "thread", "pi", "other"]),
      label: z.string(),
      threadId: z.string().optional(),
    }),
  ),
});

// ---------- the CLI's JSON shapes (src/store.ts Task/Update, src/commands/memory.ts) ----------

export const cliTaskSchema = z.object({
  id: taskId,
  title: z.string(),
  status: statusSchema,
  lane: z.string(),
  tags: z.array(z.string()),
  body: z.string().nullable(),
  created: z.number(),
  updated: z.number(),
});
export const cliUpdateSchema = z.object({
  id: z.number(),
  task_id: z.number(),
  author: z.string(),
  summary: z.string(),
  body: z.string().nullable(),
  created: z.number(),
});
const showSchema = z.object({ task: cliTaskSchema, updates: z.array(cliUpdateSchema) });
const streamRowSchema = z.object({
  id: taskId,
  title: z.string(),
  lane: z.string(),
  status: statusSchema,
  activity: z.number(),
});
const lsRowSchema = z.object({ id: taskId, title: z.string(), lane: z.string(), status: statusSchema, updated: z.number() });
const updateResultSchema = z.object({ update: cliUpdateSchema.nullable(), status: statusSchema.optional() });
export const linkedStreamSchema = z.object({ id: z.number(), status: z.string(), activity: z.number() });
export const stalenessSchema = z.object({
  verdict: z.enum(["fresh", "stale", "unverifiable"]),
  synced: z.number(),
  ageDays: z.number(),
  old: z.boolean(),
  repo: z.enum(["this", "other", "none"]),
  changed: z.array(z.string()),
  missing: z.array(z.string()),
  behind: z.number(),
});
export const memoryShowSchema = z.object({
  task: cliTaskSchema,
  synced: z.number(),
  latest: linkedStreamSchema.nullable(),
  trail: z.array(cliUpdateSchema),
  staleness: stalenessSchema,
  sections: z.array(z.object({ heading: z.string().nullable(), slug: z.string(), text: z.string() })).optional(),
});
export type MemoryShow = z.infer<typeof memoryShowSchema>;
const contextSchema = z.object({ lane: z.string(), primer: z.string() });

/** This plugin's thread metadata; each field falls back on its own, so one bad value never wipes the other. */
const metadataSchema = z.object({
  pinnedTaskId: taskId.nullable().catch(null),
  linkedTaskIds: z.array(taskId).catch([]),
});
type Metadata = z.infer<typeof metadataSchema>;

const STATUS_AUDIT = /^status \u2192 /;
const CACHE_MS = 60_000;
const PRIMER_DEBOUNCE_MS = 1_500;
const MAX_MANUAL_LINKS = 50;
const SEARCH_ROWS = 8;
const RECENT_ROWS = 5;
export const READ_ONLY_REASON = "Update cortex to change status from bb";
/** Not a git checkout, so a staleness check run here can only say "unverifiable". */
export const NEUTRAL_CWD = os.tmpdir();
export const REMOTE_REASON = "the thread's checkout is not on this bb server's machine";

/** The staleness verdict and why, in words. */
export function stalenessReason(s: z.infer<typeof stalenessSchema>): string | undefined {
  const parts: string[] = [];
  if (s.repo === "other") parts.push("cited files are not in this checkout");
  if (s.repo === "none") parts.push("not in a git checkout");
  if (s.changed.length > 0) parts.push(`changed: ${s.changed.join(", ")}`);
  if (s.missing.length > 0) parts.push(`missing: ${s.missing.join(", ")}`);
  if (s.old) parts.push(`last synced ${s.ageDays} days ago`);
  return parts.length > 0 ? parts.join(" \u00b7 ") : undefined;
}

type TaskEntry = { detail: CortexTaskDetail; activity: number };
type Cached<T> = { at: number; value: Promise<T> };

/** `userAuthor` is `cortex doctor`'s `author`: the user's own tag, and null for a cortex without `update --as-me`. */
export function createCortexState(
  bb: BbPluginApi,
  runner: CortexRunner,
  options: { userAuthor: string | null } = { userAuthor: null },
): CortexState {
  const { userAuthor } = options;
  const canWrite = userAuthor !== null;
  const tasks = new Map<string, Cached<TaskEntry>>();
  const titles = new Map<string, Cached<string>>();
  const streams = new Map<string, Cached<Array<z.infer<typeof streamRowSchema>>>>();
  const primers = new Map<string, { lane: string; primer: string; cwd: string }>();
  const warming = new Map<string, Promise<void>>();
  const locks = new Map<string, Promise<unknown>>();
  const pendingLanes = new Set<string>();
  let pendingAll = false;
  let primerTimer: ReturnType<typeof setTimeout> | null = null;
  let primaryHost: Promise<string | null> | null = null;

  bb.onDispose(() => {
    if (primerTimer !== null) clearTimeout(primerTimer);
    primerTimer = null;
  });

  function cached<T>(map: Map<string, Cached<T>>, key: string, load: () => Promise<T>): Promise<T> {
    const hit = map.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = load();
    map.set(key, { at: Date.now(), value });
    // A failed read is never cached: the next caller retries.
    value.catch(() => {
      if (map.get(key)?.value === value) map.delete(key);
    });
    return value;
  }

  function primaryHostId(): Promise<string | null> {
    primaryHost ??= bb.sdk.system.config().then(
      config => config.primaryHostId,
      err => {
        primaryHost = null;
        throw err;
      },
    );
    return primaryHost;
  }

  async function locate(threadId: string): Promise<{ projectId: string; cwd: string | null }> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return { projectId: thread.projectId, cwd: null };
    const [environment, primary] = await Promise.all([
      bb.sdk.environments.get({ environmentId: thread.environmentId }),
      primaryHostId(),
    ]);
    const local = environment.path !== null && primary !== null && environment.hostId === primary;
    return { projectId: thread.projectId, cwd: local ? environment.path : null };
  }

  /** A bb thread's title for an author label; the id when the lookup fails. */
  function threadTitle(threadId: string): Promise<string> {
    return cached(titles, threadId, () =>
      bb.sdk.threads.get({ threadId }).then(
        thread => thread.title ?? thread.titleFallback ?? threadId,
        () => threadId,
      ),
    );
  }

  async function authorsOf(tags: Iterable<string>): Promise<Record<string, CortexAuthor>> {
    const entries = await Promise.all(
      [...new Set(tags)].map(async (tag): Promise<[string, CortexAuthor]> => {
        const who = classifyAuthor(tag, userAuthor);
        if (who.kind !== "thread") return [tag, who];
        return [tag, { kind: "thread", label: await threadTitle(who.threadId), threadId: who.threadId }];
      }),
    );
    return Object.fromEntries(entries);
  }

  function taskEntry(id: number, cwd: string | null): Promise<TaskEntry> {
    return cached(tasks, `${id}\u0000${cwd ?? ""}`, async () => {
      const [shown, memory] = await Promise.all([
        runner.run(["show", String(id), "--json"], showSchema),
        runner.run(["memory", "show", String(id), "--json"], memoryShowSchema, { cwd: cwd ?? NEUTRAL_CWD }),
      ]);
      const { task } = shown;
      // bb's RPC output must be strict JSON, so an absent field is omitted, never undefined.
      const reason = cwd === null ? REMOTE_REASON : stalenessReason(memory.staleness);
      const verdict = cwd === null ? "unverifiable" : memory.staleness.verdict;
      const staleness: CortexTaskDetail["staleness"] = reason === undefined ? { verdict } : { verdict, reason };
      const activity = Math.max(
        task.created,
        memory.synced,
        ...shown.updates.filter(u => u.summary !== "created" && !STATUS_AUDIT.test(u.summary)).map(u => u.created),
      );
      const updates = shown.updates.map((u): CortexUpdate => {
        const kind = updateKind(u.summary);
        const row = { id: u.id, author: u.author, summary: u.summary, body: u.body, created: u.created };
        return kind.kind === "status" ? { ...row, kind: "status", to: kind.to } : { ...row, kind: kind.kind };
      });
      const { staleness: s } = memory;
      const detail: CortexTaskDetail = {
        task: {
          id: task.id,
          title: task.title,
          status: task.status,
          lane: task.lane,
          tags: task.tags,
          body: task.body,
          created: task.created,
          updated: task.updated,
        },
        updates,
        staleness,
        sync: {
          syncedAt: memory.synced,
          changed: s.changed,
          missing: s.missing,
          old: s.old,
          ageDays: s.ageDays,
          notFolded: s.behind,
        },
        progress: planProgress(
          task.tags,
          task.body,
          shown.updates.map(u => u.summary),
        ),
        authors: await authorsOf(shown.updates.map(u => u.author)),
      };
      return { detail, activity };
    });
  }

  function authored(threadId: string) {
    return cached(streams, threadId, () =>
      runner.run(["memory", "streams", `--author=bb-${threadId}`, "--json"], z.array(streamRowSchema)),
    );
  }

  async function readMetadata(threadId: string): Promise<Metadata> {
    const raw = await bb.sdk.threads.getPluginMetadata({ threadId });
    return metadataSchema.parse(raw ?? {});
  }

  async function writeMetadata(threadId: string, meta: Metadata): Promise<void> {
    await bb.sdk.threads.updatePluginMetadata({
      threadId,
      set: { pinnedTaskId: meta.pinnedTaskId, linkedTaskIds: meta.linkedTaskIds },
    });
  }

  async function threadState(threadId: string): Promise<CortexThreadState> {
    try {
      const [meta, place, rows] = await Promise.all([readMetadata(threadId), locate(threadId), authored(threadId)]);
      const authoredIds = new Set(rows.map(row => row.id));
      const manualIds = new Set(meta.linkedTaskIds);
      const links: CortexThreadState["links"] = rows.map(row => ({
        id: row.id,
        title: row.title,
        status: row.status,
        lane: row.lane,
        activity: row.activity,
        authored: true,
        manual: manualIds.has(row.id),
      }));
      // A removed task drops out of the view; the metadata is left alone.
      const extra = await Promise.allSettled(
        [...manualIds].filter(id => !authoredIds.has(id)).map(id => taskEntry(id, place.cwd)),
      );
      for (const result of extra) {
        if (result.status !== "fulfilled") continue;
        const { task } = result.value.detail;
        links.push({
          id: task.id,
          title: task.title,
          status: task.status,
          lane: task.lane,
          activity: result.value.activity,
          authored: false,
          manual: true,
        });
      }
      links.sort((a, b) => b.activity - a.activity || b.id - a.id);
      const pinnedTaskId = links.some(link => link.id === meta.pinnedTaskId) ? meta.pinnedTaskId : null;
      const focusTaskId = pinnedTaskId ?? links[0]?.id ?? null;
      const lane = primers.get(place.projectId)?.lane ?? null;
      const view = { threadId, lane, focusTaskId, pinnedTaskId, canWrite, links };
      if (focusTaskId === null) return { ...view, health: { kind: "ok" } };
      const { detail } = await taskEntry(focusTaskId, place.cwd);
      const health: CortexThreadState["health"] =
        detail.task.status === "blocked"
          ? { kind: "blocked", message: `#${focusTaskId} is blocked` }
          : detail.staleness.verdict === "stale"
            ? { kind: "stale", message: detail.staleness.reason ?? "stale" }
            : { kind: "ok" };
      return { ...view, health };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        threadId,
        lane: null,
        focusTaskId: null,
        pinnedTaskId: null,
        canWrite,
        links: [],
        health: { kind: "error", message },
      };
    }
  }

  /** One pin/link/unlink at a time per thread, so concurrent writes never drop each other. */
  function serialized<T>(threadId: string, write: () => Promise<T>): Promise<T> {
    const previous = locks.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(write);
    locks.set(threadId, next);
    next.finally(() => {
      if (locks.get(threadId) === next) locks.delete(threadId);
    }).catch(() => undefined);
    return next;
  }

  async function requireTask(id: number): Promise<void> {
    try {
      await runner.run(["show", String(id), "--json"], showSchema);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`task ${id} is not available: ${message}`);
    }
  }

  async function pin(threadId: string, id: number | null): Promise<CortexThreadState> {
    await serialized(threadId, async () => {
      const meta = await readMetadata(threadId);
      if (id !== null) {
        await requireTask(id);
        const linked = (await authored(threadId)).some(row => row.id === id) || meta.linkedTaskIds.includes(id);
        if (!linked) meta.linkedTaskIds = [...meta.linkedTaskIds, id].slice(-MAX_MANUAL_LINKS);
      }
      meta.pinnedTaskId = id;
      await writeMetadata(threadId, meta);
    });
    return threadState(threadId);
  }

  async function link(threadId: string, id: number): Promise<CortexThreadState> {
    await serialized(threadId, async () => {
      const meta = await readMetadata(threadId);
      if (meta.linkedTaskIds.includes(id)) return;
      await requireTask(id);
      meta.linkedTaskIds = [...meta.linkedTaskIds, id].slice(-MAX_MANUAL_LINKS);
      await writeMetadata(threadId, meta);
    });
    return threadState(threadId);
  }

  async function unlink(threadId: string, id: number): Promise<CortexThreadState> {
    await serialized(threadId, async () => {
      const meta = await readMetadata(threadId);
      // Only the manual link goes: a task this thread posted to stays listed.
      meta.linkedTaskIds = meta.linkedTaskIds.filter(linked => linked !== id);
      if (meta.pinnedTaskId === id) meta.pinnedTaskId = null;
      await writeMetadata(threadId, meta);
    });
    return threadState(threadId);
  }

  async function task(threadId: string, id: number): Promise<CortexTaskDetail> {
    const { cwd } = await locate(threadId);
    return (await taskEntry(id, cwd)).detail;
  }

  async function setStatus(threadId: string, id: number, status: CortexStatus): Promise<CortexTaskDetail> {
    if (!canWrite) throw new Error(READ_ONLY_REASON);
    await runner.run(["update", String(id), "--as-me", `--status=${status}`, "--json"], updateResultSchema);
    forgetTask(id);
    return task(threadId, id);
  }

  async function postNote(
    threadId: string,
    id: number,
    note: { summary: string; body: string | null },
    status?: CortexStatus,
  ): Promise<CortexTaskDetail> {
    if (!canWrite) throw new Error(READ_ONLY_REASON);
    const args = ["update", String(id), "--as-me", `--message=${note.summary}`];
    if (note.body !== null) args.push(`--body=${note.body}`);
    if (status !== undefined) args.push(`--status=${status}`);
    args.push("--json");
    await runner.run(args, updateResultSchema);
    forgetTask(id);
    return task(threadId, id);
  }

  async function searchTasks(query: string): Promise<CortexTaskRow[]> {
    const trimmed = query.trim();
    const byId = /^#?(\d+)$/.exec(trimmed);
    if (byId) {
      try {
        const { task: found } = await runner.run(["show", String(Number(byId[1])), "--json"], showSchema);
        return [{ id: found.id, title: found.title, lane: found.lane, status: found.status }];
      } catch {
        return [];
      }
    }
    // A dash-leading query would read as a flag, and leading dashes carry no terms.
    const terms = trimmed.replace(/^[\s-]+/, "");
    if (terms === "") return [];
    const rows = await runner.run(["search", terms, "--json"], z.array(taskRowSchema));
    return rows.slice(0, SEARCH_ROWS);
  }

  async function recentTasks(threadId: string): Promise<{ lane: string | null; tasks: CortexTaskRow[] }> {
    await warmProject(threadId).catch(() => undefined);
    const lane = state.laneFor((await locate(threadId)).projectId);
    const rows = await runner.run(["ls", ...(lane === null ? [] : [`--lane=${lane}`]), "--json"], z.array(lsRowSchema));
    const recent = rows
      .filter(row => row.status !== "done")
      .sort((a, b) => b.updated - a.updated || b.id - a.id)
      .slice(0, RECENT_ROWS)
      .map(row => ({ id: row.id, title: row.title, lane: row.lane, status: row.status }));
    return { lane, tasks: recent };
  }

  async function loadPrimer(projectId: string, cwd: string): Promise<void> {
    const out = await runner.run(["memory", "context", "--json"], contextSchema, { cwd });
    primers.set(projectId, { lane: out.lane, primer: out.primer, cwd });
  }

  async function warmProject(threadId: string): Promise<void> {
    const { projectId, cwd } = await locate(threadId);
    if (cwd === null || primers.has(projectId)) return;
    let running = warming.get(projectId);
    if (!running) {
      running = loadPrimer(projectId, cwd).finally(() => warming.delete(projectId));
      warming.set(projectId, running);
    }
    await running;
  }

  function flushPrimers(): void {
    primerTimer = null;
    const all = pendingAll;
    const lanes = new Set(pendingLanes);
    pendingAll = false;
    pendingLanes.clear();
    for (const [projectId, primer] of primers) {
      if (!all && !lanes.has(primer.lane)) continue;
      loadPrimer(projectId, primer.cwd).catch(err => bb.log.warn(`primer refresh for ${projectId} failed: ${String(err)}`));
    }
  }

  function schedulePrimers(): void {
    if (primerTimer !== null) return;
    primerTimer = setTimeout(flushPrimers, PRIMER_DEBOUNCE_MS);
    primerTimer.unref?.();
  }

  function refreshLane(lane: string): void {
    pendingLanes.add(lane);
    schedulePrimers();
  }

  function forgetTask(id: number): void {
    for (const key of tasks.keys()) if (key.startsWith(`${id}\u0000`)) tasks.delete(key);
    // Stream rows carry titles and statuses, so any task change can alter any thread's list.
    streams.clear();
  }

  async function refreshTask(id: number, lane?: string): Promise<void> {
    forgetTask(id);
    if (lane !== undefined) {
      refreshLane(lane);
      return;
    }
    try {
      const { task: shown } = await runner.run(["show", String(id), "--json"], showSchema);
      refreshLane(shown.lane);
    } catch {
      // Removed or unreadable: its lane is unknown, so every primer refreshes.
      pendingAll = true;
      schedulePrimers();
    }
  }

  async function refreshAll(): Promise<void> {
    tasks.clear();
    streams.clear();
    pendingAll = true;
    schedulePrimers();
  }

  const state: CortexState = {
    threadState,
    task,
    pin,
    link,
    unlink,
    setStatus,
    postNote,
    searchTasks,
    recentTasks,
    warmProject,
    refreshLane,
    refreshTask,
    refreshAll,
    primerFor: projectId => primers.get(projectId)?.primer ?? null,
    laneFor: projectId => primers.get(projectId)?.lane ?? null,
    locate,
  };
  return state;
}

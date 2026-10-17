import { z } from "zod";

/** Values of the Cortex pi extension's CORTEX_MEMORY (src/extensions/pi.ts memoryRole). */
export const MEMORY_MODES = ["write", "read", "off"] as const;
export const MEMORY_SETTINGS = ["auto", ...MEMORY_MODES] as const;
export type MemoryMode = (typeof MEMORY_MODES)[number];
export type MemorySetting = (typeof MEMORY_SETTINGS)[number];
export type MemoryRole = "writer" | "reader" | "off";

export const ROLE: Record<MemoryMode, MemoryRole> = { write: "writer", read: "reader", off: "off" };
export const MODE_LABEL: Record<MemoryMode, string> = {
  write: "Look up and save",
  read: "Look up only",
  off: "Off",
};
export const ROLE_LABEL: Record<MemoryRole, string> = {
  writer: MODE_LABEL.write,
  reader: MODE_LABEL.read,
  off: MODE_LABEL.off,
};

// A copy of src/extensions/memory-view.ts#REPORT_LIMITS (the plugin imports no cortex source), plus the lane and query.
const LIMITS = { rows: 500, focus: 50, text: 2000, lane: 200, query: 200 } as const;
/** Threads whose memory view is kept; the least recently written goes first. */
const MAX_THREADS = 500;
/** Focus streams a view lists, as the pi extension keeps (src/extensions/pi.ts FOCUS_CAP). */
const FOCUS_CAP = 5;
// Copies of src/extensions/pi.ts STALENESS_LINE and SEARCH_ROW (the text of src/memory.ts renderStream and streamLine).
const STALENESS_LINE = /^staleness: (\w+).*$/m;
const SEARCH_ROW = /^- \[(\d+)\]/gm;
const BY_ID = /^@?(\d+)(?:#(.+))?$/;

const taskId = z.number().int().positive();
const count = z.number().int().nonnegative();

/**
 * Mirrors src/extensions/memory-view.ts#MemoryReport within its REPORT_LIMITS.
 * Not strict: a newer extension's extra fields are dropped, not rejected.
 */
export const memoryViewSchema = z.object({
  role: z.enum(["writer", "reader", "off"]),
  lane: z.string().max(LIMITS.lane).nullable(),
  error: z.string().max(LIMITS.text),
  stale: z.object({ id: taskId, detail: z.string().max(LIMITS.text) }).nullable(),
  saving: z.boolean(),
  recallBudget: count,
  focus: z.array(taskId).max(LIMITS.focus),
  inContext: z
    .array(
      z.object({
        id: taskId,
        via: z.enum(["summary", "prompt", "recall"]),
        query: z.string().max(LIMITS.query).optional(),
      }),
    )
    .max(LIMITS.rows),
  stats: z.object({
    prompts: count,
    lookups: count,
    lastMs: count,
    chars: count,
    checkpoints: count,
    breadcrumbs: count,
    silentRuns: count,
  }),
});
export type MemoryView = z.infer<typeof memoryViewSchema>;

/** A thread's memory as the marker and the Memory tab show it. */
export type MemoryState = {
  threadId: string;
  /** A pi thread: the Cortex pi extension reports its view. */
  pi: boolean;
  setting: MemorySetting;
  /** The thread's own choice, or null to follow the setting. */
  override: MemoryMode | null;
  mode: MemoryMode;
  /** Started by another thread. */
  child: boolean;
  view: MemoryView | null;
  /** When the view was last written. */
  reportedAt: number | null;
  /** The thread's last re-read request (epoch ms), 0 for none. */
  refreshAt: number;
};

export const memoryStateSchema: z.ZodType<MemoryState> = z.object({
  threadId: z.string(),
  pi: z.boolean(),
  setting: z.enum(MEMORY_SETTINGS),
  override: z.enum(MEMORY_MODES).nullable(),
  mode: z.enum(MEMORY_MODES),
  child: z.boolean(),
  view: memoryViewSchema.nullable(),
  reportedAt: z.number().nullable(),
  refreshAt: z.number(),
});

/** A stored setting value; anything outside the options counts as `auto`. */
export function memorySetting(value: string): MemorySetting {
  return (MEMORY_SETTINGS as readonly string[]).includes(value) ? (value as MemorySetting) : "auto";
}

/** The thread's choice wins; `auto` saves only in a thread you started, never one started by another thread. */
export function effectiveMode(setting: MemorySetting, override: MemoryMode | null, child: boolean): MemoryMode {
  if (override !== null) return override;
  if (setting === "auto") return child ? "read" : "write";
  return setting;
}

export type MemoryTracker = {
  /**
   * Records what configure gave the thread: the first call creates the view; a later one follows the latest role,
   * fills a missing lane and enters a writer's new summary streams. Never touches a pi-reported view; true when
   * the view changed.
   */
  configured(
    threadId: string,
    start: { mode: MemoryMode; lane: string | null; summary: number[]; chars: number },
  ): boolean;
  recalled(threadId: string, query: string, text: string, ms: number): void;
  updated(threadId: string, taskId: number): void;
  failed(threadId: string, message: string): void;
  /** A new request clears the stale flag; true when that changed the view. */
  nextRequest(threadId: string): boolean;
  /** A pi report replaces the view unless it was sent before the stored one; true when it was stored. */
  report(threadId: string, view: MemoryView, sentAt: number): boolean;
  get(threadId: string): { view: MemoryView; at: number } | null;
  /** Asks the thread's pi to re-read memory; returns the request's time. */
  requestRefresh(threadId: string): number;
  refreshAt(threadId: string): number;
  forget(threadId: string): void;
};

type Entry = {
  view: MemoryView | null;
  at: number;
  /** The last report's sentAt; set only for a view the pi extension owns. */
  sentAt: number | null;
  refreshAt: number;
};

/** The changed/missing/old part of a `staleness: stale · synced … · …` line (src/extensions/pi.ts staleDetail). */
function staleDetail(line: string): string {
  return line.split(" \u00b7 ").slice(2).join(" \u00b7 ") || "stale";
}

/**
 * Per-thread memory views: pi threads' reports, and for other providers what
 * the plugin gave and the agent recalled. In memory only, for at most 500 threads.
 */
export function createMemoryTracker(recallBudget: number, now: () => number = Date.now): MemoryTracker {
  const entries = new Map<string, Entry>();

  function emptyView(role: MemoryRole, lane: string | null): MemoryView {
    return {
      role,
      lane,
      error: "",
      stale: null,
      saving: false,
      recallBudget,
      focus: [],
      inContext: [],
      stats: { prompts: 0, lookups: 0, lastMs: 0, chars: 0, checkpoints: 0, breadcrumbs: 0, silentRuns: 0 },
    };
  }

  /** Stores the entry as the most recently written, dropping the least recently written beyond the cap. */
  function write(threadId: string, entry: Entry): void {
    entries.delete(threadId);
    entries.set(threadId, entry);
    while (entries.size > MAX_THREADS) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  /** Applies a tool event to the plugin's own view; a pi-reported view changes only through reports. */
  function edit(threadId: string, change: (view: MemoryView) => void): void {
    const entry = entries.get(threadId);
    if (entry && entry.sentAt !== null) return;
    const view = entry?.view ?? emptyView("writer", null);
    change(view);
    write(threadId, { view, at: now(), sentAt: null, refreshAt: entry?.refreshAt ?? 0 });
  }

  /** Enters a stream unless it is already in context (the first reason wins); true when it entered. */
  function enter(view: MemoryView, id: number, via: "summary" | "prompt" | "recall"): boolean {
    if (!Number.isInteger(id) || id <= 0 || view.inContext.some(entry => entry.id === id)) return false;
    view.inContext = [{ id, via }, ...view.inContext].slice(0, LIMITS.rows);
    return true;
  }

  function addFocus(view: MemoryView, id: number): void {
    if (!Number.isInteger(id) || id <= 0) return;
    view.focus = [id, ...view.focus.filter(f => f !== id)].slice(0, FOCUS_CAP);
  }

  return {
    configured(threadId, start) {
      const entry = entries.get(threadId);
      if (entry && entry.sentAt !== null) return false;
      const role = ROLE[start.mode];
      // Entered oldest first, so the view lists them newest first, as the pi extension does.
      const enterSummary = (view: MemoryView): boolean =>
        start.summary.reduce((added, id) => enter(view, id, "summary") || added, false);
      if (!entry?.view) {
        const view = emptyView(role, start.lane);
        enterSummary(view);
        view.stats.chars = start.chars;
        write(threadId, { view, at: now(), sentAt: null, refreshAt: entry?.refreshAt ?? 0 });
        return true;
      }
      const { view } = entry;
      let changed = false;
      if (view.role !== role) {
        view.role = role;
        changed = true;
      }
      if (view.lane === null && start.lane !== null) {
        view.lane = start.lane;
        changed = true;
      }
      if (role === "writer" && enterSummary(view)) {
        view.stats.chars += start.chars;
        changed = true;
      }
      if (changed) write(threadId, { ...entry, at: now() });
      return changed;
    },
    recalled(threadId, query, text, ms) {
      edit(threadId, view => {
        const byId = BY_ID.exec(query.trim());
        if (byId) {
          const id = Number(byId[1]);
          enter(view, id, "recall");
          addFocus(view, id);
          const staleness = STALENESS_LINE.exec(text);
          if (staleness?.[1] === "stale") view.stale = { id, detail: staleDetail(staleness[0]).slice(0, LIMITS.text) };
          else if (staleness && view.stale?.id === id) view.stale = null;
        } else {
          for (const m of text.matchAll(SEARCH_ROW)) enter(view, Number(m[1]), "recall");
        }
        view.error = "";
        view.stats.lookups++;
        view.stats.lastMs = Math.max(0, Math.round(ms));
        view.stats.chars += text.length;
      });
    },
    updated(threadId, taskId) {
      edit(threadId, view => {
        view.error = "";
        addFocus(view, taskId);
      });
    },
    failed(threadId, message) {
      edit(threadId, view => {
        view.error = (message || "cortex failed").slice(0, LIMITS.text);
      });
    },
    nextRequest(threadId) {
      const entry = entries.get(threadId);
      if (!entry?.view || entry.sentAt !== null || entry.view.stale === null) return false;
      edit(threadId, view => {
        view.stale = null;
      });
      return true;
    },
    report(threadId, view, sentAt) {
      const entry = entries.get(threadId);
      if (entry && entry.sentAt !== null && sentAt < entry.sentAt) return false;
      write(threadId, { view, at: now(), sentAt, refreshAt: entry?.refreshAt ?? 0 });
      return true;
    },
    get(threadId) {
      const entry = entries.get(threadId);
      return entry?.view ? { view: entry.view, at: entry.at } : null;
    },
    requestRefresh(threadId) {
      const entry = entries.get(threadId);
      const at = now();
      // The view's own time stays: the request is pending until a later report.
      write(threadId, { view: entry?.view ?? null, at: entry?.at ?? at, sentAt: entry?.sentAt ?? null, refreshAt: at });
      return at;
    },
    refreshAt(threadId) {
      return entries.get(threadId)?.refreshAt ?? 0;
    },
    forget(threadId) {
      entries.delete(threadId);
    },
  };
}

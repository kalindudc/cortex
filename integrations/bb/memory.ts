import { z } from "zod";

/** The thread's memory modes. */
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

// The most rows and characters a view keeps, plus the lane and query, and the request characters kept as the reason
// a matching task is in context (src/extensions/pi.ts REASON_CHARS).
const LIMITS = { rows: 500, focus: 50, text: 2000, lane: 200, query: 200, reason: 40 } as const;
/** Threads whose memory view is kept; the least recently written goes first. */
const MAX_THREADS = 500;
/** Focus streams a view lists, as the pi extension keeps (src/extensions/pi.ts FOCUS_CAP). */
const FOCUS_CAP = 5;
// The staleness line and search rows printed by src/memory.ts renderStream and streamLine.
const STALENESS_LINE = /^staleness: (\w+).*$/m;
const SEARCH_ROW = /^- \[(\d+)\]/gm;
const BY_ID = /^@?(\d+)(?:#(.+))?$/;

const taskId = z.number().int().positive();
const count = z.number().int().nonnegative();

/** One thread's memory view, as the plugin builds it. */
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
  setting: MemorySetting;
  /** The thread's own choice, or null to follow the setting. */
  override: MemoryMode | null;
  mode: MemoryMode;
  /** Started by another thread. */
  child: boolean;
  view: MemoryView | null;
};

export const memoryStateSchema: z.ZodType<MemoryState> = z.object({
  threadId: z.string(),
  setting: z.enum(MEMORY_SETTINGS),
  override: z.enum(MEMORY_MODES).nullable(),
  mode: z.enum(MEMORY_MODES),
  child: z.boolean(),
  view: memoryViewSchema.nullable(),
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
   * fills a missing lane and enters a writer's new summary streams; true when the view changed.
   */
  configured(
    threadId: string,
    start: { mode: MemoryMode; lane: string | null; summary: number[]; chars: number },
  ): boolean;
  recalled(threadId: string, query: string, text: string, ms: number): void;
  updated(threadId: string, taskId: number): void;
  failed(threadId: string, message: string): void;
  /** Matching tasks steered into a request: entered as "prompt" with the query, one prompt and one lookup. */
  matched(threadId: string, ids: readonly number[], query: string, chars: number, ms: number): void;
  /** Adds focus streams named by the request's commands, oldest first so the newest leads. */
  focused(threadId: string, ids: readonly number[]): void;
  /** The save turn started: saving, and one more checkpoint. */
  checkpointing(threadId: string): void;
  /** The save turn ended or never started. */
  saved(threadId: string): void;
  /** A new request clears the stale flag; true when that changed the view. */
  nextRequest(threadId: string): boolean;
  get(threadId: string): { view: MemoryView; at: number } | null;
  forget(threadId: string): void;
};

type Entry = { view: MemoryView | null; at: number };

/** The changed/missing/old part of a `staleness: stale · synced … · …` line (src/extensions/pi.ts staleDetail). */
function staleDetail(line: string): string {
  return line.split(" \u00b7 ").slice(2).join(" \u00b7 ") || "stale";
}

/**
 * Per-thread memory views: what the plugin gave each thread and what its agent
 * recalled. In memory only, for at most 500 threads.
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

  /** Applies a tool event to the thread's view. */
  function edit(threadId: string, change: (view: MemoryView) => void): void {
    const view = entries.get(threadId)?.view ?? emptyView("writer", null);
    change(view);
    write(threadId, { view, at: now() });
  }

  /** Enters a stream unless it is already in context (the first reason wins); true when it entered. */
  function enter(view: MemoryView, id: number, via: "summary" | "prompt" | "recall", query?: string): boolean {
    if (!Number.isInteger(id) || id <= 0 || view.inContext.some(entry => entry.id === id)) return false;
    const entry = query === undefined ? { id, via } : { id, via, query: query.slice(0, LIMITS.reason) };
    view.inContext = [entry, ...view.inContext].slice(0, LIMITS.rows);
    return true;
  }

  function addFocus(view: MemoryView, id: number): void {
    if (!Number.isInteger(id) || id <= 0) return;
    view.focus = [id, ...view.focus.filter(f => f !== id)].slice(0, FOCUS_CAP);
  }

  return {
    configured(threadId, start) {
      const entry = entries.get(threadId);
      const role = ROLE[start.mode];
      // Entered oldest first, so the view lists them newest first, as the pi extension does.
      const enterSummary = (view: MemoryView): boolean =>
        start.summary.reduce((added, id) => enter(view, id, "summary") || added, false);
      if (!entry?.view) {
        const view = emptyView(role, start.lane);
        enterSummary(view);
        view.stats.chars = start.chars;
        write(threadId, { view, at: now() });
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
    matched(threadId, ids, query, chars, ms) {
      edit(threadId, view => {
        for (const id of ids) enter(view, id, "prompt", query);
        view.error = "";
        view.stats.prompts++;
        view.stats.lookups++;
        view.stats.lastMs = Math.max(0, Math.round(ms));
        view.stats.chars += chars;
      });
    },
    focused(threadId, ids) {
      edit(threadId, view => {
        for (const id of ids) addFocus(view, id);
      });
    },
    checkpointing(threadId) {
      edit(threadId, view => {
        view.saving = true;
        view.stats.checkpoints++;
      });
    },
    saved(threadId) {
      edit(threadId, view => {
        view.saving = false;
      });
    },
    nextRequest(threadId) {
      const entry = entries.get(threadId);
      if (!entry?.view || entry.view.stale === null) return false;
      edit(threadId, view => {
        view.stale = null;
      });
      return true;
    },
    get(threadId) {
      const entry = entries.get(threadId);
      return entry?.view ? { view: entry.view, at: entry.at } : null;
    },
    forget(threadId) {
      entries.delete(threadId);
    },
  };
}

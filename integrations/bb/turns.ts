import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { CortexRunner } from "./cli";
import type { MemoryMode, MemoryTracker } from "./memory";
import type { CortexRealtimeChannel, CortexState } from "./state";
import type { Workstreams } from "./workstreams";

// The cue, limits, patterns and checkpoint text copy src/extensions/pi.ts (injectMemory, shouldCheckpoint,
// focusFromBash, checkpointPrompt), since the plugin imports no cortex source: change them together.
export const TURN_LIMITS = {
  pages: 20,
  pageSize: 100,
  files: 10,
  candidates: 3,
  queryChars: 1000,
  minFiles: 3,
  firstHits: 5,
  laterHits: 3,
} as const;

/** Providers whose bb bridge injects a steer into the running turn; an ACP bridge's steer cancels the prompt. */
export const STEER_PROVIDERS: ReadonlySet<string> = new Set(["pi", "claude-code", "codex"]);

/**
 * A later request that asks for earlier work: continue/resume/pick up/left
 * off/remember/previous/earlier, "where/what was|were|did|is", or an `@<id>`
 * reference. Recency words and "again" are left out: boilerplate carries them
 * ("Last output" in a wake-up, "call loom_submit again"), and they started
 * most later lookups that no agent used.
 */
export const RECALL_CUE =
  /\b(continu(e|ing)|resum(e|ing)|pick(ed)? up|left off|remember|previous(ly)?|earlier)\b|\b(where|what)\s+(was|were|did|is)\b|(?<![\w@])@\d+\b/i;
/** How matching tasks tell the agent to load one. */
const LOAD_HINT = 'cortex_recall "@<id>"';
/**
 * A message a plugin sent rather than a person typed (bb records both with initiator "user"): it opens with a
 * bracketed tag word, then optional detail, such as `[loom]`, `[shuttle]`, `[Flare reminder]` or `[wake-up wk_\u2026 \u00b7
 * <reason>]`, whose reason can run to 200 characters. Never a person's `[WIP]` (one capitals word), a task box
 * `[ ]` or `[x]`, or a Markdown link `[the spec](\u2026)`.
 */
const PLUGIN_HEADER = /^\[(?![A-Z0-9]+\])[A-Za-z][A-Za-z0-9-]+(?:[ :\u00b7][^\]\n]{0,300})?\](?!\()/;
/** Commands that write to a stream the thread works on (`cortex add` ids come from its output); reads never count. */
const FOCUS_COMMAND = /\bcortex\s+(?:edit|update|mv)\s+(\d+)\b/g;
/** Commands that count as writing memory (the cortex_update tool counts too). */
const MEMORY_WRITE = /\bcortex\s+(?:edit|add|update)\b/;

export type EventRow = { seq: number; type: string; createdAt: number; data: unknown };
/** A request as bb recorded it: its row, the user's text and who sent it. */
export type RequestStart = { seq: number; createdAt: number; text: string; initiator: string; first: boolean };
/** The thread that started this one: a minion's parent, or the owner of a workflow agent; null for a thread a person started. */
export function startedBy(thread: { parentThreadId: string | null; lifecycleOwnerThreadId?: string | null }) {
  return thread.parentThreadId ?? thread.lifecycleOwnerThreadId ?? null;
}
export type RequestFacts = {
  outcome: "completed" | "failed" | "interrupted" | null;
  edited: string[];
  focus: number[];
  wroteMemory: boolean;
};

const requestSchema = z.object({
  input: z.array(z.unknown()),
  initiator: z.string(),
  target: z.object({ kind: z.string() }),
});
const textPartSchema = z.object({ type: z.literal("text"), text: z.string(), visibility: z.string().optional() });
const itemSchema = z.object({
  item: z.discriminatedUnion("type", [
    z.object({ type: z.literal("fileChange"), status: z.string(), changes: z.array(z.object({ path: z.string() })) }),
    z.object({
      type: z.literal("commandExecution"),
      status: z.string(),
      command: z.string(),
      aggregatedOutput: z.string().nullish(),
    }),
  ]),
});
const turnSchema = z.object({ status: z.enum(["completed", "failed", "interrupted"]) });

/** Deliberately crude: "yes", "ok continue" and "do it" look nothing up; the CLI's own term filter is the real one. */
function contentWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]{3,}/gu) ?? []).length;
}

/** The request a `client/turn/requested` row records; null for any other row or shape. */
export function readStart(row: EventRow): RequestStart | null {
  if (row.type !== "client/turn/requested") return null;
  const parsed = requestSchema.safeParse(row.data);
  if (!parsed.success) return null;
  const text = parsed.data.input
    .flatMap(part => {
      const parsedPart = textPartSchema.safeParse(part);
      return parsedPart.success && parsedPart.data.visibility !== "agent-only" ? [parsedPart.data.text] : [];
    })
    .join("\n")
    // Leading dashes and whitespace carry no terms, and a dash-leading value would read as a flag.
    .replace(/^[\s-]+/, "")
    .slice(0, TURN_LIMITS.queryChars);
  return {
    seq: row.seq,
    createdAt: row.createdAt,
    text,
    initiator: parsed.data.initiator,
    first: parsed.data.target.kind === "thread-start",
  };
}

/**
 * How many matching tasks a request brings: a first request, or one with a recall cue, with at least two content
 * words and no plugin header, in a thread that looks up and whose provider takes a steer mid-turn. Null brings none.
 */
export function hitLimit(s: { mode: MemoryMode; providerId: string; start: RequestStart }): number | null {
  const { mode, providerId, start } = s;
  if (mode === "off" || !STEER_PROVIDERS.has(providerId) || start.initiator !== "user") return null;
  if (PLUGIN_HEADER.test(start.text)) return null;
  if (contentWords(start.text) < 2 || !(start.first || RECALL_CUE.test(start.text))) return null;
  return mode === "write" && start.first ? TURN_LIMITS.firstHits : TURN_LIMITS.laterHits;
}

/** The stream ids a command touched: named ids, plus the new id a `cortex add` printed. */
function focusFromCommand(command: string, output: string): number[] {
  const ids = [...command.matchAll(FOCUS_COMMAND)].map(m => Number(m[1]));
  if (/\bcortex\s+add\b/.test(command)) {
    const added = /^\[(\d+)\]/m.exec(output) ?? /"id":(\d+)/.exec(output);
    if (added) ids.push(Number(added[1]));
  }
  return ids;
}

/** What a request did, from its `item/completed` and `turn/completed` rows; anything else is ignored. */
export function readRequest(rows: readonly EventRow[]): RequestFacts {
  const edited = new Set<string>();
  const focus: number[] = [];
  let wroteMemory = false;
  let outcome: RequestFacts["outcome"] = null;
  for (const row of rows) {
    if (row.type === "turn/completed") {
      const turn = turnSchema.safeParse(row.data);
      if (turn.success) outcome = turn.data.status;
      continue;
    }
    if (row.type !== "item/completed") continue;
    const parsed = itemSchema.safeParse(row.data);
    if (!parsed.success || parsed.data.item.status !== "completed") continue;
    const { item } = parsed.data;
    if (item.type === "fileChange") {
      for (const change of item.changes) edited.add(change.path);
    } else {
      focus.push(...focusFromCommand(item.command, item.aggregatedOutput ?? ""));
      if (MEMORY_WRITE.test(item.command)) wroteMemory = true;
    }
  }
  return { outcome, edited: [...edited], focus, wroteMemory };
}

/**
 * Whether a finished request earns ONE memory checkpoint turn: a writer's completed request that changed files and
 * wrote no memory, either with focus streams to re-sync ("update") or, with none, big enough to be worth a stream
 * ("attach"). Everything else is null.
 */
export function shouldCheckpoint(s: {
  mode: MemoryMode;
  outcome: RequestFacts["outcome"];
  wroteMemory: boolean;
  edited: number;
  focus: number;
}): "update" | "attach" | null {
  if (s.mode !== "write" || s.outcome !== "completed" || s.wroteMemory) return null;
  if (s.edited > 0 && s.focus > 0) return "update";
  if (s.focus === 0 && s.edited >= TURN_LIMITS.minFiles) return "attach";
  return null;
}

/** The checkpoint message: what changed, the streams to consider, and exactly one choice to make. */
export function checkpointPrompt(input: {
  kind: "update" | "attach";
  edited: string[];
  focus: number[];
  candidates: string;
  author: string;
}): string {
  const files = input.edited.slice(0, TURN_LIMITS.files).map(path => `- ${path}`);
  const more = input.edited.length - TURN_LIMITS.files;
  if (more > 0) files.push(`- \u2026 and ${more} more`);
  const streams =
    input.kind === "update"
      ? `Focus streams (most recent first): ${input.focus.map(id => `@${id}`).join(", ")}`
      : `Candidate streams (one memory search):\n${input.candidates || "(none found)"}`;
  return [
    "Memory checkpoint (automatic, once per request)",
    "",
    "This request changed files and wrote no cortex memory. Files changed:",
    ...files,
    "",
    streams,
    "",
    "Do EXACTLY ONE of:",
    "- UPDATE: re-sync a listed stream: anchored edits of its ## State, ## Decisions and ## Next and its `Verified:` line " +
      '(`cortex edit <id> --body-search "<exact old text>" --body-replace "<new text>"`), then ONE cortex_update. ' +
      "A `review`-status stream gets the cortex_update only, never a body edit.",
    "- ATTACH: ONE cortex_update on a listed stream naming this work.",
    "- CREATE: only when no listed stream fits (at most one new stream per request):",
    `  cortex add "<title>" --lane "$(cortex memory lane)" --status open --as ${input.author} --body-file - <<'EOF'`,
    "  ## Goal",
    "  ## State",
    "  ## Decisions",
    "  ## Next",
    "  ## Files",
    "  Verified: YYYY-MM-DD",
    "  EOF",
    "- NOTHING: no durable knowledge (a typo, formatting, throwaway work).",
    "",
    "Reply with one short line naming your choice.",
  ].join("\n");
}

export type MemoryTurns = {
  /** cortex_update wrote memory for the thread, so its current request needs no save turn. */
  wrote(threadId: string): void;
};

/** One thread's request bookkeeping. */
type ThreadTurn = {
  /** The newest request's start, until an idle evaluates it or the checkpoint mark clears. */
  start: RequestStart | null;
  /** When cortex_update last wrote for the thread. */
  wroteAt: number;
  /** The plugin's save turn was sent and has not ended yet. */
  marked: boolean;
  /** An idle evaluation is running. */
  busy: boolean;
  /** Cortex was asked which streams the thread posted to; later writes reach the tracker directly. */
  consulted: boolean;
};

const contextSchema = z.object({ hits: z.array(z.object({ id: z.number().int().positive() })), hitsText: z.string() });
const streamsSchema = z.array(z.object({ id: z.number().int().positive() }));

type TurnThread = { id: string; parentThreadId: string | null; lifecycleOwnerThreadId?: string | null };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Text the agent reads and the user's view of the thread leaves out. */
const agentOnly = (text: string) => [{ type: "text" as const, text, mentions: [], visibility: "agent-only" as const }];

/**
 * Around each request, as the pi extension does in plain pi: matching tasks steered into the running turn, and ONE
 * memory checkpoint turn after a request that changed files and saved nothing. Both read the request from bb's own
 * events, which bb records in one shape for every provider.
 */
export function registerMemoryTurns(
  bb: BbPluginApi,
  deps: {
    runner: CortexRunner;
    state: CortexState;
    tracker: MemoryTracker;
    workstreams?: Workstreams;
    publish: (channel: CortexRealtimeChannel, payload: unknown) => void;
    modeOf(thread: TurnThread): Promise<MemoryMode>;
  },
): MemoryTurns {
  const { runner, state, tracker } = deps;
  const threads = new Map<string, ThreadTurn>();
  const turnOf = (threadId: string): ThreadTurn => {
    let entry = threads.get(threadId);
    if (!entry) {
      entry = { start: null, wroteAt: 0, marked: false, busy: false, consulted: false };
      threads.set(threadId, entry);
    }
    return entry;
  };
  const changed = (threadId: string): void => deps.publish("memory", { threadId });

  /** The save turn ended: clears the mark, the stored start and the saving state. */
  function settle(threadId: string, entry: ThreadTurn): void {
    entry.marked = false;
    entry.start = null;
    tracker.saved(threadId);
    changed(threadId);
  }

  /**
   * Looks up the tasks matching a request and steers them into its turn, unless the request is over by then. A
   * thread started by another gets only the tasks its request links to and the starting thread's own, never keyword
   * hits: its brief already carries the context.
   */
  async function matchTasks(threadId: string, start: RequestStart, limit: number, parent: string | null): Promise<void> {
    if (deps.workstreams && (deps.workstreams.store.hasBindings() || deps.workstreams.store.tracked(threadId))) {
      const context = await deps.workstreams.context(threadId);
      if (context.binding || context.bindingChanged) {
        if (context.status !== "ready") {
          tracker.failed(threadId, context.error ?? "Workstream changed; no context was substituted.");
          changed(threadId);
          return;
        }
        const current = () => threads.get(threadId)?.start?.seq === start.seq && !threads.get(threadId)?.marked;
        if (!current() || (await bb.sdk.threads.get({ threadId })).status !== "active" || !current()) return;
        await bb.sdk.threads.send({ threadId, mode: "steer", input: agentOnly(context.exactText) });
        deps.workstreams.record(context, "match", context.exactText);
        return;
      }
    }
    const { cwd } = await state.locate(threadId);
    // As in pi, a stream the memory summary lists can still match: the hit says it fits this request.
    const seen =
      tracker
        .get(threadId)
        ?.view.inContext.filter(entry => entry.via !== "summary")
        .map(entry => entry.id) ?? [];
    const args = [
      "memory",
      "context",
      "--json",
      "--no-primer",
      `--author=bb-${threadId}`,
      `--limit=${limit}`,
      `--load-hint=${LOAD_HINT}`,
      `--query=${start.text}`,
    ];
    if (parent !== null) args.push(`--parent=bb-${parent}`);
    if (seen.length > 0) args.push(`--exclude=${seen.join(",")}`);
    const started = Date.now();
    let out: z.infer<typeof contextSchema>;
    try {
      out = await runner.run(args, contextSchema, { cwd: cwd ?? undefined });
    } catch (err) {
      tracker.failed(threadId, message(err));
      changed(threadId);
      return;
    }
    const ms = Date.now() - started;
    if (!out.hitsText) return;
    // A lookup that outlived its request would steer into the save turn or the next request, and a steer on an
    // idle thread starts a turn, which would make the save turn's start fail.
    const current = (): boolean => {
      const entry = threads.get(threadId);
      return entry?.start?.seq === start.seq && !entry.marked;
    };
    if (!current() || (await bb.sdk.threads.get({ threadId })).status !== "active" || !current()) return;
    try {
      await bb.sdk.threads.send({ threadId, mode: "steer", input: agentOnly(out.hitsText) });
    } catch (err) {
      bb.log.warn(`steering matching tasks into ${threadId} failed: ${message(err)}`);
      return;
    }
    tracker.matched(threadId, out.hits.map(hit => hit.id), start.text, out.hitsText.length, ms);
    changed(threadId);
  }

  /** The request's item and turn rows after its start, a bounded number of pages. */
  async function requestRows(threadId: string, afterSeq: number): Promise<EventRow[]> {
    const rows: EventRow[] = [];
    let after = afterSeq;
    for (let page = 0; page < TURN_LIMITS.pages; page++) {
      const batch = await bb.sdk.threads.events.list({
        threadId,
        afterSeq: String(after),
        order: "asc",
        limit: String(TURN_LIMITS.pageSize),
        types: ["item/completed", "turn/completed"],
      });
      rows.push(...batch);
      const last = batch.at(-1);
      if (last === undefined || batch.length < TURN_LIMITS.pageSize) break;
      after = last.seq;
    }
    return rows;
  }

  /**
   * The thread's focus streams, most recent first: the ones it wrote to in this process, or else, asked once per
   * process, the ones cortex records it posting to, which survive a restart of bb or the plugin. Null when cortex
   * could not say: a save turn then would invite a duplicate stream.
   */
  async function focusOf(threadId: string, entry: ThreadTurn): Promise<number[] | null> {
    const known = tracker.get(threadId)?.view.focus ?? [];
    if (known.length > 0 || entry.consulted) return known;
    let written: number[];
    try {
      const args = ["memory", "streams", `--author=bb-${threadId}`, `--limit=${TURN_LIMITS.candidates}`, "--json"];
      written = (await runner.run(args, streamsSchema)).map(row => row.id);
    } catch (err) {
      tracker.failed(threadId, message(err));
      changed(threadId);
      return null;
    }
    entry.consulted = true;
    if (written.length > 0) {
      // Oldest first, so the newest leads, as `focused` expects.
      tracker.focused(threadId, [...written].reverse());
      changed(threadId);
    }
    return written;
  }

  /** Decides whether the request that just ended earns the save turn, and starts it. */
  async function checkpoint(thread: TurnThread, entry: ThreadTurn, start: RequestStart): Promise<void> {
    const threadId = thread.id;
    const mode = await deps.modeOf(thread);
    if (deps.workstreams && (deps.workstreams.store.hasBindings() || deps.workstreams.store.tracked(threadId))) {
      const context = await deps.workstreams.context(threadId);
      if (context.binding || context.bindingChanged) return;
    }
    if (mode !== "write" || (await bb.sdk.threads.queuedMessages.list({ threadId })).length > 0) return;
    const facts = readRequest(await requestRows(threadId, start.seq));
    if (facts.focus.length > 0) {
      tracker.focused(threadId, facts.focus);
      changed(threadId);
    }
    const wroteMemory = facts.wroteMemory || entry.wroteAt >= start.createdAt;
    // Only a request that changed files and saved nothing can earn the turn, so only it reads focus from cortex.
    const focus =
      facts.edited.length > 0 && !wroteMemory && facts.outcome === "completed"
        ? await focusOf(threadId, entry)
        : (tracker.get(threadId)?.view.focus ?? []);
    if (focus === null) return;
    const kind = shouldCheckpoint({
      mode,
      outcome: facts.outcome,
      wroteMemory,
      edited: facts.edited.length,
      focus: focus.length,
    });
    if (kind === null) return;
    let candidates = "";
    if (kind === "attach" && contentWords(start.text) >= 2) {
      try {
        const { cwd } = await state.locate(threadId);
        const args = [
          "memory",
          "context",
          "--json",
          "--no-primer",
          `--author=bb-${threadId}`,
          `--query=${start.text}`,
          `--limit=${TURN_LIMITS.candidates}`,
        ];
        const parent = startedBy(thread);
        if (parent !== null) args.push(`--parent=bb-${parent}`);
        candidates = (await runner.run(args, contextSchema, { cwd: cwd ?? undefined })).hitsText;
      } catch (err) {
        // No candidates: the checkpoint still offers CREATE and NOTHING.
        tracker.failed(threadId, message(err));
      }
    }
    // A newer request began while this one was evaluated: its own idle decides, and this save turn is stale.
    if (entry.start !== null) return;
    const prompt = checkpointPrompt({ kind, edited: facts.edited, focus, candidates, author: `bb-${threadId}` });
    tracker.checkpointing(threadId);
    changed(threadId);
    entry.marked = true;
    try {
      // "start" fails on a busy thread, so the save turn never interrupts the user or queues ahead of them.
      await bb.sdk.threads.send({ threadId, mode: "start", input: agentOnly(prompt) });
    } catch (err) {
      entry.marked = false;
      tracker.saved(threadId);
      changed(threadId);
      bb.log.warn(`starting the memory checkpoint in ${threadId} failed: ${message(err)}`);
    }
  }

  bb.events.on("thread.active", async ({ thread }) => {
    try {
      const entry = turnOf(thread.id);
      if (entry.marked) return;
      const rows = await bb.sdk.threads.events.list({
        threadId: thread.id,
        types: ["client/turn/requested"],
        order: "desc",
        limit: "1",
      });
      const start = rows[0] ? readStart(rows[0]) : null;
      if (start === null || entry.marked) return;
      entry.start = start;
      const limit = hitLimit({ mode: await deps.modeOf(thread), providerId: thread.providerId, start });
      if (limit !== null) await matchTasks(thread.id, start, limit, startedBy(thread));
    } catch (err) {
      bb.log.warn(`reading the request of ${thread.id} failed: ${message(err)}`);
    }
  });

  bb.events.on("thread.idle", async ({ thread }) => {
    try {
      const entry = threads.get(thread.id);
      if (!entry) return;
      if (entry.marked) {
        settle(thread.id, entry);
        return;
      }
      if (entry.busy) return;
      // Evaluated at most once: bb can go idle again without a new request (an environment restore).
      const start = entry.start;
      entry.start = null;
      if (start === null) return;
      entry.busy = true;
      try {
        let next: RequestStart | null = start;
        while (next !== null) {
          await checkpoint(thread, entry, next);
          // A request that began and ended during that evaluation had its own idle skipped: evaluate it now.
          next = null;
          if (entry.start !== null && !entry.marked) {
            const live = await bb.sdk.threads.get({ threadId: thread.id });
            if (live.status === "idle" && entry.start !== null && !entry.marked) {
              next = entry.start;
              entry.start = null;
            }
          }
        }
      } finally {
        entry.busy = false;
      }
    } catch (err) {
      bb.log.warn(`the memory checkpoint of ${thread.id} failed: ${message(err)}`);
    }
  });

  // A failed request earns no save turn, and a failed save turn ends like a finished one.
  bb.events.on("thread.failed", ({ thread }) => {
    try {
      const entry = threads.get(thread.id);
      if (entry?.marked) settle(thread.id, entry);
      else if (entry) entry.start = null;
    } catch (err) {
      bb.log.warn(`ending the memory checkpoint of ${thread.id} failed: ${message(err)}`);
    }
  });

  const drop = ({ thread }: { thread: { id: string } }): void => {
    threads.delete(thread.id);
  };
  bb.events.on("thread.archived", drop);
  bb.events.on("thread.deleted", drop);

  return {
    wrote(threadId) {
      turnOf(threadId).wroteAt = Date.now();
    },
  };
}

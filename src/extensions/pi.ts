// @ts-nocheck — embedded asset: pi.ts is shipped as bytes via
// `with { type: "file" }` and runs INSIDE pi (which provides
// `@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent` at runtime).
// cortex itself does NOT depend on those packages, so type-checking this
// file from cortex's tsconfig is incorrect — the imports are unresolvable
// here and the tool's `execute` callback signature comes from pi's
// `defineTool`. The tsconfig `exclude` of `src/extensions/**` covers this
// file when reached directly, but the import in `src/extensions.ts` still
// pulls it into the program graph; this directive is the second line of
// defense.
//
/**
 * cortex pi extension — embedded asset.
 *
 * Shipped inside the cortex binary; installed by `cortex agents install` at
 * `<pi agent dir>/extensions/cortex/index.ts` (default
 * `~/.pi/agent/extensions/cortex/index.ts`), where pi auto-discovers it on the
 * next start (no `pi config` step).
 *
 * Responsibility: `cortex_update` + automatic cortex memory (primer, prompt
 * hits, `cortex_recall`, the footer status and `/memory`; both render only
 * through the sibling `./memory-view.ts`, installed beside this file under
 * the same name).
 *   - `cortex_update` wraps `cortex update` with auto-attribution: the bb
 *     thread (`bb-<thread id>`) inside bb, otherwise the active pi session
 *     (`pi-<full-uuidv7>`); both are resumable via `cortex resume`.
 *   - Every session starts with a frozen primer of the repo's memory streams
 *     (plus streams recently active in other lanes); later prompts that ask
 *     for earlier work (a recall cue) surface only NEW relevant streams, from
 *     every lane with this repo's boosted.
 *   - `cortex_recall` loads one stream (or one `@<id>#<section>`) with its
 *     staleness check, or searches every lane with this repo's first.
 *
 * Roles: writer = a human-facing UI is attached (ctx.hasUI); reader = headless
 * (delegates, pi -p); CORTEX_MEMORY=write|read|off overrides process-wide.
 * Cortex core has no notion of roles. Readers get hits only (no primer,
 * <= 3 hits, <= 2 recalls per request); `off` injects and spawns nothing.
 *
 * Overhead contract (memory must speed agents up, not make them loop):
 *   - A user prompt costs at most ONE `cortex memory context` spawn (3 s
 *     timeout; a failure never blocks or throws). After the session's first
 *     prompt (which fetches the primer) it costs ZERO when the prompt has
 *     fewer than 2 content words or no recall cue (RECALL_CUE: "continue",
 *     "last", "what was", an `@<id>`, ...), and later spawns pass
 *     `--no-primer`. Keyword recall cannot tell an action request from a
 *     lookup; the cue bounds the noise and `cortex_recall` covers the rest.
 *   - The system-prompt memory block is byte-identical for the whole session
 *     (refetched only after compaction or `/memory refresh`), so the provider
 *     prompt cache survives; hits ride as hidden messages instead.
 *   - A hit is injected at most once per session.
 *   - `cortex_recall` answers at most 3 calls per user request and
 *     short-circuits a repeated query.
 *   - The footer status names only what needs attention (a failed memory
 *     call, stale memory in use, the checkpoint turn) and is otherwise a
 *     quiet marker. `/memory` shows every stream in context and why it is
 *     there; it costs ONE `cortex ls --json` (titles), nothing else spawns
 *     for the UI, and the only timer is the save spinner (one checkpoint
 *     turn at most).
 *   - Tool failures THROW (on a non-zero exit OR a killed process): pi
 *     ignores a returned `isError`, and `pi.exec` resolves a timeout as
 *     `code: 0, killed: true`.
 *   - In bb (bb's own rpc-mode pi with CORTEX_BB_MEMORY_URL and a valid
 *     BB_THREAD_ID), the view goes to the Cortex bb plugin: at most ONE
 *     awaited local POST per prompt (BB_REPORT_TIMEOUT_MS, skipped while the
 *     last report failed) and one fire-and-forget POST per changed view
 *     (spinner frames change nothing). Reporting never throws and never
 *     counts as a memory error; outside bb it makes no call.
 *
 * The CLI defaults its author to the bb thread on its own; outside bb, humans
 * and fallback agents (no pi session) pass `--as` directly.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryPanel, memoryReport, memoryStatus, memoryViewText } from "./memory-view.ts";

const BB_THREAD_ID = /^thr_[0-9a-z]{6,40}$/;

export function sessionAuthor(sessionId: string, threadId: string | undefined = process.env.BB_THREAD_ID): string {
  return threadId && BB_THREAD_ID.test(threadId) ? `bb-${threadId}` : `pi-${sessionId}`;
}

const MEMORY_TIMEOUT_MS = 3000;
const RECALL_TIMEOUT_MS = 5000;
const RECALL_BUDGET = 3;
const FIRST_HITS = 5;
const LATER_HITS = 3;
const QUERY_CHARS = 1000;
const STATUS_KEY = "cortex-memory";
const READER_HITS = 3;
const READER_RECALL_BUDGET = 2;
const ROLE_OVERRIDES = ["write", "read", "off"];
const FOCUS_CAP = 5;
/** The save spinner's frame interval (only while the checkpoint turn runs). */
const SPINNER_MS = 150;
/** Prompt characters kept as the reason a hit is in context. */
const REASON_CHARS = 40;
/** A successful bash edit of a stream's body re-syncs it (clears its stale flag). */
const BODY_EDIT = /\bcortex\s+edit\s+(\d+)\b/g;
/** `memory show`'s staleness line (src/memory.ts renderStream). */
const STALENESS_LINE = /^staleness: (\w+).*$/m;
/** A `memory search` result row (src/memory.ts streamLine). */
const SEARCH_ROW = /^- \[(\d+)\]/gm;
/** Commands that name a stream the session works on (`cortex add` ids come from its output). */
const FOCUS_COMMAND = /\bcortex\s+(?:edit|update|mv|show|memory\s+show)\s+(\d+)\b/g;
/** Bash commands that count as writing memory (the cortex_update tool counts too). */
const MEMORY_WRITE = /\bcortex\s+(?:edit|add)\b/;
const CHECKPOINT_MIN_FILES = 3;
const CHECKPOINT_CANDIDATES = 3;
const CHECKPOINT_FILES_SHOWN = 10;
const BREADCRUMB_STREAMS = 2;
const BREADCRUMB_CHARS = 4000;
/**
 * A later prompt that asks for earlier or current work: recency words,
 * continue/resume/pick up/left off/remember/previous/earlier/again,
 * "where/what was|were|did|is", or an `@<id>` reference.
 */
export const RECALL_CUE =
  /\b(last|latest|recent(ly)?|current(ly)?|lately|newest|yesterday|today|continu(e|ing)|resum(e|ing)|pick(ed)? up|left off|remember|previous(ly)?|earlier|again)\b|\b(where|what)\s+(was|were|did|is)\b|(?<![\w@])@\d+\b/i;
/** How injected hits tell the model to load one. */
const LOAD_HINT = 'cortex_recall "@<id>"';
/** The longest a prompt waits for its report to the Cortex bb plugin, the only setter of CORTEX_BB_MEMORY_URL. */
const BB_REPORT_TIMEOUT_MS = 500;

/**
 * Who keeps memory in this session: the one human-driven session writes;
 * headless ones (minions, `pi -p`, any SDK sub-session) only read. `hasUI` is
 * pi's own generic "a human is attached" bit, so no harness is special-cased.
 */
export function memoryRole(
  ctx: { hasUI: boolean },
  env: Record<string, string | undefined> = process.env,
): "writer" | "reader" | "off" {
  switch (env.CORTEX_MEMORY) {
    case "write":
      return "writer";
    case "read":
      return "reader";
    case "off":
      return "off";
    default:
      return ctx.hasUI ? "writer" : "reader";
  }
}

/** The stream ids a bash command touched: named ids, plus the new id a `cortex add` printed. */
export function focusFromBash(command: string, output: string): number[] {
  const ids = [...command.matchAll(FOCUS_COMMAND)].map(m => Number(m[1]));
  if (/\bcortex\s+add\b/.test(command)) {
    const added = /^\[(\d+)\]/m.exec(output) ?? /"id":(\d+)/.exec(output);
    if (added) ids.push(Number(added[1]));
  }
  return ids;
}

/**
 * Whether a finished request earns ONE memory checkpoint turn: a writer's
 * completed request that changed files and wrote no memory, either with focus
 * streams to re-sync ("update") or, with none, big enough to be worth a stream
 * ("attach"). Everything else, including the checkpoint turn itself, is null.
 */
export function shouldCheckpoint(s: {
  role: string;
  outcome: string;
  checkpointed: boolean;
  wroteMemory: boolean;
  edited: number;
  focus: number;
}): "update" | "attach" | null {
  if (s.role !== "writer" || s.outcome !== "completed" || s.checkpointed || s.wroteMemory) return null;
  if (s.edited > 0 && s.focus > 0) return "update";
  if (s.focus === 0 && s.edited >= CHECKPOINT_MIN_FILES) return "attach";
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
  const files = input.edited.slice(0, CHECKPOINT_FILES_SHOWN).map(path => `- ${path}`);
  const more = input.edited.length - CHECKPOINT_FILES_SHOWN;
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

/** Leading dashes and whitespace carry no terms, and a dash-leading value would read as a flag. */
function sanitize(text: string): string {
  return text.replace(/^[\s-]+/, "");
}

/** Deliberately crude: "yes", "ok continue" and "do it" spawn nothing; the CLI's memoryTerms filters for real. */
function contentWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]{3,}/gu) ?? []).length;
}

/** pi.exec never rejects: a spawn failure is `code: 1`, a timeout/abort resolves `code: 0, killed: true`. */
function failed(r): boolean {
  return r.killed || r.code !== 0;
}

function failureText(r, what: string): string {
  const text = r.stderr.trim() || r.stdout.trim();
  if (text) return text;
  return r.killed ? `${what} timed out or was aborted` : `${what} failed`;
}

/** The changed/missing/old part of a `staleness: stale · synced … · …` line. */
function staleDetail(line: string): string {
  return line.split(" \u00b7 ").slice(2).join(" \u00b7 ") || "stale";
}

/** The `cortex memory context --json` shape, or null when the output is not it. */
function parseContext(stdout: string) {
  let out: unknown;
  try {
    out = JSON.parse(stdout);
  } catch {
    return null;
  }
  const ok =
    out !== null &&
    typeof out === "object" &&
    typeof out.lane === "string" &&
    typeof out.primer === "string" &&
    typeof out.hitsText === "string" &&
    Array.isArray(out.primerIds) &&
    Array.isArray(out.hits);
  return ok ? out : null;
}

function freshRequest() {
  return { edited: new Set<string>(), wroteMemory: false, checkpointed: false, query: "" };
}

function freshStats() {
  return {
    prompts: 0,
    lookups: 0,
    lastMs: 0,
    /** Characters memory put into context: the primer (per fetch), injected hits and recall outputs. */
    chars: 0,
    /** The last memory call's failure; the next successful call clears it. */
    lastError: "",
    silentRuns: 0,
    checkpoints: 0,
    breadcrumbs: 0,
  };
}

export default function (pi: ExtensionAPI): void {
  // Session state: reset on session_start; the primer and shown hits also on compaction.
  let primer: string | null = null;
  let lane: string | null = null;
  const shown = new Set<number>();
  let pendingInput: string | null = null;
  let recalls = 0;
  const recalled = new Set<string>();
  let sawPrompt = false;
  let stats = freshStats();
  let roleWarned = false;
  // Writer tracking: focus streams live for the session (most recent last); `request` per user prompt.
  let focus: number[] = [];
  let request = freshRequest();
  let lastQuery = "";
  // The /memory ledger: the FIRST reason each stream entered context (insertion = oldest first).
  // Reset with `shown` on session_start and compaction; `shown` stays the --exclude source.
  const inContext = new Map<number, { via: "summary" | "prompt" | "recall"; query?: string }>();
  // A stale stream in use this request (from a recall's staleness line; no spawn).
  let stale: { id: number; detail: string } | null = null;
  // The checkpoint turn is running: the footer's arc spins (the only timer).
  let saving = false;
  let frame = 0;
  let spinner: ReturnType<typeof setInterval> | null = null;
  // Reports to the Cortex bb plugin: the last view sent, whether the last report was
  // answered, and the newest re-read request applied.
  let bbSent = "";
  let bbAnswered = true;
  let bbRefreshSeen = 0;

  function enter(id: number, via: "summary" | "prompt" | "recall", query?: string) {
    if (!Number.isInteger(id) || id <= 0 || inContext.has(id)) return;
    inContext.set(id, query === undefined ? { via } : { via, query });
  }

  /** The plain state memory-view.ts renders (newest first). */
  function viewState(ctx) {
    return {
      role: roleOf(ctx),
      lane,
      error: stats.lastError,
      stale,
      saving,
      frame,
      recallBudget: READER_RECALL_BUDGET,
      focus: [...focus].reverse(),
      inContext: [...inContext].reverse().map(([id, entry]) => ({ id, ...entry })),
      stats: {
        prompts: stats.prompts,
        lookups: stats.lookups,
        lastMs: stats.lastMs,
        chars: stats.chars,
        checkpoints: stats.checkpoints,
        breadcrumbs: stats.breadcrumbs,
        silentRuns: stats.silentRuns,
      },
    };
  }

  /** Recompute the footer after every memory event (a UI-less session has no footer). */
  function showStatus(ctx) {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, memoryStatus(viewState(ctx), ctx.ui.theme));
    void reportToBb(ctx, false);
  }

  /** The primer and hits are fetched again on the next prompt (`/memory refresh`, or a re-read asked in bb). */
  function reread(ctx) {
    primer = null;
    shown.clear();
    inContext.clear();
    showStatus(ctx);
  }

  /**
   * Sends the view to the Cortex bb plugin. Only bb's own pi reports: a `pi -p`
   * started from the thread's shell inherits both variables but runs in print
   * mode. `wait` sends an unchanged view too; any answer with a newer
   * `refreshAt` re-reads memory. Never throws and never sets the memory error.
   */
  async function reportToBb(ctx, wait: boolean): Promise<void> {
    const url = process.env.CORTEX_BB_MEMORY_URL ?? "";
    const threadId = process.env.BB_THREAD_ID ?? "";
    if (ctx.mode !== "rpc" || !/^https?:\/\//.test(url) || !BB_THREAD_ID.test(threadId)) return;
    try {
      const view = memoryReport(viewState(ctx));
      const key = JSON.stringify(view);
      if (!wait && key === bbSent) return;
      bbSent = key;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, sentAt: Date.now(), view }),
        signal: AbortSignal.timeout(BB_REPORT_TIMEOUT_MS),
      });
      bbAnswered = res.ok;
      if (!res.ok) {
        // An unread error body would keep its connection open.
        await res.body?.cancel();
        return;
      }
      const refreshAt = (await res.json().catch(() => null))?.refreshAt;
      if (typeof refreshAt === "number" && Number.isFinite(refreshAt) && refreshAt > bbRefreshSeen) {
        bbRefreshSeen = refreshAt;
        reread(ctx);
      }
    } catch {
      bbAnswered = false;
    }
  }

  function startSpinner(ctx) {
    if (spinner !== null || !ctx.hasUI) return;
    spinner = setInterval(() => {
      frame++;
      showStatus(ctx);
    }, SPINNER_MS);
  }

  function stopSpinner() {
    if (spinner === null) return;
    clearInterval(spinner);
    spinner = null;
  }

  function addFocus(ids: number[]) {
    for (const id of ids) {
      if (!Number.isInteger(id) || id <= 0) continue;
      focus = [...focus.filter(f => f !== id), id];
    }
    focus = focus.slice(-FOCUS_CAP);
  }

  /** memoryRole for this event; an unknown CORTEX_MEMORY is ignored and reported once. */
  function roleOf(ctx) {
    const value = process.env.CORTEX_MEMORY;
    if (value && !ROLE_OVERRIDES.includes(value) && !roleWarned) {
      roleWarned = true;
      stats.lastError = `CORTEX_MEMORY=${value} is not write|read|off; ignored`;
    }
    return memoryRole(ctx);
  }

  pi.on("session_start", (_event, ctx) => {
    stopSpinner();
    primer = null;
    lane = null;
    shown.clear();
    pendingInput = null;
    recalls = 0;
    recalled.clear();
    sawPrompt = false;
    stats = freshStats();
    focus = [];
    request = freshRequest();
    lastQuery = "";
    inContext.clear();
    stale = null;
    saving = false;
    frame = 0;
    bbSent = "";
    bbAnswered = true;
    bbRefreshSeen = 0;
    showStatus(ctx);
  });

  pi.on("session_shutdown", () => {
    stopSpinner();
  });

  // pi's own compaction summary becomes a breadcrumb on the newest focus streams:
  // an append-only update, never a body rewrite, and no extra model call.
  pi.on("session_compact", async (event, ctx) => {
    primer = null;
    shown.clear();
    inContext.clear();
    showStatus(ctx);
    const summary = event.compactionEntry?.summary ?? "";
    if (!summary.trim() || roleOf(ctx) !== "writer") return;
    try {
      const author = sessionAuthor(ctx.sessionManager.getSessionId());
      for (const id of focus.slice(-BREADCRUMB_STREAMS).reverse()) {
        const args = [
          "update",
          String(id),
          "-m",
          "auto: progress snapshot at compaction",
          "-b",
          summary.slice(0, BREADCRUMB_CHARS),
          "--as",
          author,
        ];
        const r = await pi.exec("cortex", args, { cwd: ctx.cwd, timeout: MEMORY_TIMEOUT_MS });
        if (failed(r)) {
          stats.lastError = failureText(r, `cortex update ${id}`);
        } else {
          stats.lastError = "";
          stats.breadcrumbs++;
        }
      }
    } catch (err) {
      stats.lastError = String(err?.message ?? err);
    }
    showStatus(ctx);
  });

  // The RAW text, before `/skill:` and prompt-template expansion (before_agent_start
  // sees the expanded text, which starts with the whole skill body). Steer/followUp
  // messages never reach before_agent_start, so they must not leak into its query.
  pi.on("input", event => {
    if (event.source !== "extension" && !event.streamingBehavior) {
      pendingInput = event.text.replace(/^\/\S+\s*/, "");
    }
  });

  pi.on("agent_start", () => {
    if (!sawPrompt) stats.silentRuns++;
  });

  pi.on("agent_end", (_event, ctx) => {
    sawPrompt = false;
    saving = false;
    stopSpinner();
    showStatus(ctx);
  });

  async function injectMemory(event, ctx, query: string, reader: boolean) {
    stats.prompts++;
    // Readers never fetch or inject the primer: their hits ride alone.
    const first = !reader && primer === null;
    // After the session's first prompt, only a recall cue searches memory.
    const cued = first || stats.prompts === 1 || RECALL_CUE.test(query);
    const withQuery = cued && contentWords(query) >= 2;
    let ids: number[] = [];
    let hitsText = "";

    if (first || withQuery) {
      const args = [
        "memory",
        "context",
        "--json",
        `--author=${sessionAuthor(ctx.sessionManager.getSessionId())}`,
        `--limit=${reader ? READER_HITS : first ? FIRST_HITS : LATER_HITS}`,
        `--load-hint=${LOAD_HINT}`,
      ];
      if (withQuery) args.push(`--query=${query}`);
      if (shown.size > 0) args.push(`--exclude=${[...shown].join(",")}`);
      if (!first) args.push("--no-primer");
      stats.lookups++;
      const started = Date.now();
      const r = await pi.exec("cortex", args, { cwd: ctx.cwd, timeout: MEMORY_TIMEOUT_MS });
      stats.lastMs = Date.now() - started;
      const out = failed(r) ? null : parseContext(r.stdout);
      if (out === null) {
        // Fail open but visibly, and never retry the primer this session (no retry storm).
        if (first) primer = "";
        stats.lastError = failed(r)
          ? failureText(r, "cortex memory context")
          : "cortex memory context printed unreadable JSON";
      } else {
        stats.lastError = "";
        if (first) {
          primer = out.primer;
          stats.chars += out.primer.length;
          for (const id of out.primerIds) enter(id, "summary");
        }
        lane = out.lane;
        ids = out.hits.map(hit => hit.id);
        for (const id of ids) {
          shown.add(id);
          enter(id, "prompt", query.slice(0, REASON_CHARS));
        }
        hitsText = out.hitsText;
      }
    }

    const result: { systemPrompt?: string; message?: unknown } = {};
    if (primer) {
      // A forced system prompt (an earlier extension returned one) hides sections,
      // so append to it instead. Sections must be re-set every run, or pi records a removal.
      if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
        result.systemPrompt = `${event.systemPrompt}\n\n<cortex_memory>\n${primer}\n</cortex_memory>`;
      } else {
        event.systemPromptOptions.sections.cortex_memory = primer;
      }
    }
    if (hitsText) {
      // Returned ONLY with new hits: every returned message is persisted.
      result.message = { customType: "cortex-memory", content: hitsText, display: false, details: { ids } };
      stats.chars += hitsText.length;
    }
    return result.systemPrompt !== undefined || result.message !== undefined ? result : undefined;
  }

  pi.on("before_agent_start", async (event, ctx) => {
    sawPrompt = true;
    recalls = 0;
    recalled.clear();
    const query = sanitize((pendingInput ?? event.prompt).slice(0, QUERY_CHARS));
    pendingInput = null;
    request = freshRequest();
    request.query = query;
    if (contentWords(query) >= 2) lastQuery = query;
    // Stale memory is flagged for the request that recalled it.
    stale = null;
    const role = roleOf(ctx);
    if (role === "off") return undefined;
    // In bb, a re-read asked while the thread was idle must apply before this prompt injects.
    if (bbAnswered) await reportToBb(ctx, true);
    try {
      return await injectMemory(event, ctx, query, role === "reader");
    } catch (err) {
      // Never fail the user's prompt over memory.
      if (role === "writer") primer ??= "";
      stats.lastError = String(err?.message ?? err);
      return undefined;
    } finally {
      showStatus(ctx);
    }
  });

  // Deterministic and cheap: in-memory bookkeeping only, never a spawn per tool.
  pi.on("tool_result", (event, ctx) => {
    if (event.isError || roleOf(ctx) !== "writer") return;
    const input = event.input ?? {};
    if (event.toolName === "edit" || event.toolName === "write") {
      if (input.path !== undefined) request.edited.add(String(input.path));
    } else if (event.toolName === "bash") {
      const command = String(input.command ?? "");
      const output = (event.content ?? []).map(c => (c.type === "text" ? c.text : "")).join("\n");
      addFocus(focusFromBash(command, output));
      if (MEMORY_WRITE.test(command)) request.wroteMemory = true;
      if (stale && [...command.matchAll(BODY_EDIT)].some(m => Number(m[1]) === stale.id)) {
        stale = null;
        showStatus(ctx);
      }
    } else if (event.toolName === "cortex_update") {
      addFocus([Number(input.task_id)]);
      request.wroteMemory = true;
    }
  });

  // At most ONE extra turn per request: `checkpointed` survives the continuation
  // (it is the same run, no before_agent_start), so the turn's own settle is a no-op.
  pi.on("agent_before_settle", async (event, ctx) => {
    const kind = shouldCheckpoint({
      role: roleOf(ctx),
      outcome: event.outcome,
      checkpointed: request.checkpointed,
      wroteMemory: request.wroteMemory,
      edited: request.edited.size,
      focus: focus.length,
    });
    if (kind === null) return undefined;
    request.checkpointed = true;
    let candidates = "";
    if (kind === "attach" && lastQuery) {
      const args = [
        "memory",
        "context",
        "--json",
        "--no-primer",
        `--query=${lastQuery}`,
        `--limit=${CHECKPOINT_CANDIDATES}`,
      ];
      const r = await pi.exec("cortex", args, { cwd: ctx.cwd, timeout: MEMORY_TIMEOUT_MS });
      const out = failed(r) ? null : parseContext(r.stdout);
      // No candidates on failure: the checkpoint still offers CREATE and NOTHING.
      if (out === null) {
        stats.lastError = failed(r)
          ? failureText(r, "cortex memory context")
          : "cortex memory context printed unreadable JSON";
      } else {
        stats.lastError = "";
        candidates = out.hitsText;
      }
    }
    stats.checkpoints++;
    // The continuation emits agent_start again; it belongs to this request, not a silent run.
    sawPrompt = true;
    const content = checkpointPrompt({
      kind,
      edited: [...request.edited],
      focus: [...focus].reverse(),
      candidates,
      author: sessionAuthor(ctx.sessionManager.getSessionId()),
    });
    // The arc spins until the turn ends (agent_end).
    saving = true;
    frame = 0;
    startSpinner(ctx);
    showStatus(ctx);
    return {
      entries: [
        {
          type: "custom_message",
          customType: "cortex-memory-checkpoint",
          content,
          display: false,
          details: { kind, focus: [...focus] },
        },
      ],
      continue: true,
    };
  });

  pi.registerTool(
    defineTool({
      name: "cortex_update",
      label: "Cortex Update",
      description:
        "Post an update on a cortex task with author attribution to the active pi session. Mirrors `cortex update <id> -m <message> [-s <status>] [-b <body>]`.",
      promptSnippet: "Post a cortex task update with attribution to your active pi session.",
      promptGuidelines: [
        "Use cortex_update for every cortex task update — it auto-attributes to your active pi session.",
        "Pass task_id (positive integer), message (one or two plain sentences on what changed and what it means; ≤4096 chars, no newlines), and optionally status (draft|open|review|blocked|done) and body (numbers, lists, logs and other detail).",
        "Prefer this tool over shelling `cortex update <id> --as ... -m ...` — manually-attributed updates are NOT resumable by the user.",
        "If status is set, both a message row AND a `status → <status>` audit-trail row are written, both attributed to your session.",
      ],
      parameters: Type.Object({
        task_id: Type.Integer({
          description: "Task id (positive integer; see `cortex ls`)",
        }),
        message: Type.String({
          description: "What changed and what it means, in one or two plain sentences; max 4096 chars, no newlines",
        }),
        status: Type.Optional(
          Type.Union(
            [
              Type.Literal("draft"),
              Type.Literal("open"),
              Type.Literal("review"),
              Type.Literal("blocked"),
              Type.Literal("done"),
            ],
            {
              description: "Optional status flip",
            },
          ),
        ),
        body: Type.Optional(
          Type.String({
            description: "Optional detail shown in `cortex show`: numbers, lists, logs, evidence",
          }),
        ),
      }),

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const sessionId = ctx.sessionManager.getSessionId();
        const args: string[] = [
          "update",
          String(params.task_id),
          "-m",
          params.message,
          "--as",
          sessionAuthor(sessionId),
        ];
        if (params.status !== undefined) {
          args.push("-s", params.status);
        }
        if (params.body !== undefined) {
          args.push("-b", params.body);
        }

        const result = await pi.exec("cortex", args, { cwd: ctx.cwd, signal });
        if (failed(result)) {
          stats.lastError = failureText(result, "cortex update");
          showStatus(ctx);
          throw new Error(stats.lastError);
        }
        stats.lastError = "";
        showStatus(ctx);
        return { content: [{ type: "text", text: result.stdout }], details: undefined };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "cortex_recall",
      label: "Cortex Recall",
      description:
        'Load one cortex memory stream by id ("@<id>" leads with its Next/Open questions/Decisions, names the latest linked stream and reports staleness; "@<id>#<section>" loads one section) or search cortex memory by keywords (every lane, this repo first). Budget: 3 calls per request.',
      promptSnippet:
        "Load a cortex memory stream (@id or @id#section, with staleness check) or search memory in every lane by keywords.",
      promptGuidelines: [
        "Relevant cortex memory is injected automatically (<cortex_memory> and cortex-memory messages): do NOT search memory at the start of a request.",
        'Call cortex_recall only when the user refers to earlier work you cannot see, or before continuing/relying on a stream: "@<id>" loads it with its staleness report, leading with its Next/Open questions/Decisions and naming its latest linked stream (continue THAT one); "@<id>#<section>" loads one section in full.',
        "Keyword recall searches every lane (this repo first): work spans repos.",
        "Use cortex_recall, not `cortex show`/`cortex ls` in bash, for memory lookups.",
        "At most 3 cortex_recall calls per request and never the same query twice; then work with what you have.",
        "Memory is a hint, the code and the user are the truth: re-read changed/missing files before acting, then re-sync the stream (cortex skill, recipes/memory.md).",
        "When continuing a stream, follow its Next section and honour its Decisions (user preferences, constraints, rejected options).",
      ],
      parameters: Type.Object({
        query: Type.String({
          description:
            '"@<id>" loads one stream with a staleness check, "@<id>#<section>" one section of it; otherwise keywords (every lane)',
        }),
      }),

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const text = (message: string) => ({ content: [{ type: "text", text: message }], details: undefined });
        const budget = roleOf(ctx) === "reader" ? READER_RECALL_BUDGET : RECALL_BUDGET;
        if (++recalls > budget) {
          return text("Recall budget for this request is spent; continue the task with what you have.");
        }
        const query = params.query.trim();
        // The section is part of the query text, so `@12#next` and `@12` are distinct recalls.
        const key = query.toLowerCase().replace(/\s+/g, " ");
        if (recalled.has(key)) return text("Already recalled in this request; see the earlier result.");

        const byId = /^@?(\d+)(?:#(.+))?$/.exec(query);
        const section = byId?.[2]?.trim();
        const args = byId
          ? ["memory", "show", byId[1], ...(section ? [`--section=${section}`] : [])]
          : ["memory", "search", sanitize(query), "--limit=5", ...(lane ? [`--boost=${lane}`] : [])];
        // Claimed BEFORE the exec: pi runs one assistant message's tool calls in
        // parallel, so a duplicate must see it in flight. A failure releases it.
        recalled.add(key);
        const r = await pi.exec("cortex", args, { cwd: ctx.cwd, timeout: RECALL_TIMEOUT_MS, signal });
        if (failed(r)) {
          recalled.delete(key);
          stats.lastError = failureText(r, `cortex ${args.slice(0, 2).join(" ")}`);
          showStatus(ctx);
          throw new Error(stats.lastError);
        }
        stats.lastError = "";
        stats.chars += r.stdout.length;
        if (byId) {
          const id = Number(byId[1]);
          shown.add(id);
          addFocus([id]);
          enter(id, "recall");
          const staleness = STALENESS_LINE.exec(r.stdout);
          if (staleness?.[1] === "stale") stale = { id, detail: staleDetail(staleness[0]) };
          else if (staleness && stale?.id === id) stale = null;
        } else {
          for (const m of r.stdout.matchAll(SEARCH_ROW)) enter(Number(m[1]), "recall");
        }
        showStatus(ctx);
        return text(r.stdout);
      },
    }),
  );

  /**
   * Current title, status and lane of the listed streams from ONE `cortex ls
   * --json` (bodiless, every lane and status); null when it fails (the view
   * then shows ids only).
   */
  async function streamInfo(ctx, ids: Set<number>) {
    const r = await pi.exec("cortex", ["ls", "--json"], { cwd: ctx.cwd, timeout: MEMORY_TIMEOUT_MS });
    if (failed(r)) return null;
    let rows: unknown;
    try {
      rows = JSON.parse(r.stdout);
    } catch {
      return null;
    }
    if (!Array.isArray(rows)) return null;
    const info = new Map();
    for (const row of rows) {
      if (!ids.has(row?.id)) continue;
      info.set(row.id, { title: String(row.title), status: String(row.status), lane: String(row.lane) });
    }
    return info;
  }

  pi.registerCommand("memory", {
    description: "cortex memory: what your agent was given from memory and why; `/memory refresh` re-reads it",
    handler: async (args, ctx) => {
      const refresh = () => reread(ctx);
      if (args.trim() === "refresh") {
        refresh();
        ctx.ui.notify("cortex memory: the primer and hits are re-read on the next prompt", "info");
        return;
      }
      const ids = new Set([...focus, ...inContext.keys()]);
      const info = ids.size > 0 ? await streamInfo(ctx, ids) : new Map();
      const state = viewState(ctx);
      if (ctx.mode === "tui" && ctx.hasUI) {
        await ctx.ui.custom(
          (_tui, theme, _keybindings, done) =>
            new MemoryPanel(
              state,
              info,
              theme,
              () => done(undefined),
              () => {
                refresh();
                ctx.ui.notify("cortex memory: re-read on the next prompt", "info");
              },
            ),
        );
        return;
      }
      ctx.ui.notify(memoryViewText(state, info), "info");
    },
  });
}

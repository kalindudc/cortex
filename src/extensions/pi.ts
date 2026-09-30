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
 * hits, `cortex_recall`, `/memory`).
 *   - `cortex_update` wraps `cortex update` with auto-attribution from the
 *     active pi session (`pi-<full-uuidv7>`), resumable via `cortex resume`.
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
 *   - `/memory` shows exactly what was injected, the last latency and the
 *     injected characters.
 *   - Tool failures THROW (on a non-zero exit OR a killed process): pi
 *     ignores a returned `isError`, and `pi.exec` resolves a timeout as
 *     `code: 0, killed: true`.
 *
 * The `cortex update --as <id>` CLI behavior is unchanged. Humans and
 * fallback agents (no pi session) continue to pass `--as` directly.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
 * A later prompt that asks for earlier or current work (plan @422): recency
 * words, continue/resume/pick up/left off/remember/previous/earlier/again,
 * "where/what was|were|did|is", or an `@<id>` reference.
 */
export const RECALL_CUE =
  /\b(last|latest|recent(ly)?|current(ly)?|lately|newest|yesterday|today|continu(e|ing)|resum(e|ing)|pick(ed)? up|left off|remember|previous(ly)?|earlier|again)\b|\b(where|what)\s+(was|were|did|is)\b|(?<![\w@])@\d+\b/i;
/** How injected hits tell the model to load one. */
const LOAD_HINT = 'cortex_recall "@<id>"';

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
    Array.isArray(out.hits);
  return ok ? out : null;
}

function freshRequest() {
  return { edited: new Set<string>(), wroteMemory: false, checkpointed: false, query: "" };
}

function freshStats() {
  return {
    prompts: 0,
    execs: 0,
    lastMs: 0,
    injectedChars: 0,
    lastError: "",
    lastHits: "",
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

  pi.on("session_start", () => {
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
  });

  // pi's own compaction summary becomes a breadcrumb on the newest focus streams:
  // an append-only update, never a body rewrite, and no extra model call.
  pi.on("session_compact", async (event, ctx) => {
    primer = null;
    shown.clear();
    const summary = event.compactionEntry?.summary ?? "";
    if (!summary.trim() || roleOf(ctx) !== "writer") return;
    try {
      const author = `pi-${ctx.sessionManager.getSessionId()}`;
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
        if (failed(r)) stats.lastError = failureText(r, `cortex update ${id}`);
        else stats.breadcrumbs++;
      }
    } catch (err) {
      stats.lastError = String(err?.message ?? err);
    }
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

  pi.on("agent_end", () => {
    sawPrompt = false;
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
    let status: string | undefined;

    if (first || withQuery) {
      const args = [
        "memory",
        "context",
        "--json",
        `--author=pi-${ctx.sessionManager.getSessionId()}`,
        `--limit=${reader ? READER_HITS : first ? FIRST_HITS : LATER_HITS}`,
        `--load-hint=${LOAD_HINT}`,
      ];
      if (withQuery) args.push(`--query=${query}`);
      if (shown.size > 0) args.push(`--exclude=${[...shown].join(",")}`);
      if (!first) args.push("--no-primer");
      stats.execs++;
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
        status = "memory: unavailable";
      } else {
        if (first) primer = out.primer;
        lane = out.lane;
        ids = out.hits.map(hit => hit.id);
        for (const id of ids) shown.add(id);
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
      stats.injectedChars += hitsText.length;
      stats.lastHits = hitsText;
      status = `memory: ${ids.length} new`;
    }
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, status);
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
    const role = roleOf(ctx);
    if (role === "off") return undefined;
    try {
      return await injectMemory(event, ctx, query, role === "reader");
    } catch (err) {
      // Never fail the user's prompt over memory.
      if (role === "writer") primer ??= "";
      stats.lastError = String(err?.message ?? err);
      return undefined;
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
      author: `pi-${ctx.sessionManager.getSessionId()}`,
    });
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "memory: checkpoint");
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
        "Pass task_id (positive integer), message (≤4096 chars, no newlines), and optionally status (draft|open|review|blocked|done) and body (longer detail shown).",
        "Prefer this tool over shelling `cortex update <id> --as ... -m ...` — manually-attributed updates are NOT resumable by the user.",
        "If status is set, both a message row AND a `status → <status>` audit-trail row are written, both attributed to your session.",
      ],
      parameters: Type.Object({
        task_id: Type.Integer({
          description: "Task id (positive integer; see `cortex ls`)",
        }),
        message: Type.String({
          description: "Short summary, max 4096 chars; no newlines",
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
            description: "Optional longer detail shown in `cortex show`",
          }),
        ),
      }),

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const sessionId = ctx.sessionManager.getSessionId();
        const args: string[] = ["update", String(params.task_id), "-m", params.message, "--as", `pi-${sessionId}`];
        if (params.status !== undefined) {
          args.push("-s", params.status);
        }
        if (params.body !== undefined) {
          args.push("-b", params.body);
        }

        const result = await pi.exec("cortex", args, { cwd: ctx.cwd, signal });
        if (failed(result)) throw new Error(failureText(result, "cortex update"));
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
          throw new Error(failureText(r, `cortex ${args.slice(0, 2).join(" ")}`));
        }
        if (byId) {
          shown.add(Number(byId[1]));
          addFocus([Number(byId[1])]);
        }
        return text(r.stdout);
      },
    }),
  );

  pi.registerCommand("memory", {
    description: "show injected cortex memory; `/memory refresh` re-reads it",
    handler: async (args, ctx) => {
      if (args.trim() === "refresh") {
        primer = null;
        shown.clear();
        ctx.ui.notify("cortex memory: the primer and hits are re-read on the next prompt", "info");
        return;
      }
      const focusText =
        focus.length > 0
          ? [...focus]
              .reverse()
              .map(id => `@${id}`)
              .join(", ")
          : "(none)";
      const lines = [
        `cortex memory — lane: ${lane ?? "(unknown)"}`,
        `primer (${primer?.length ?? 0} chars):`,
        primer || "(none)",
        `shown streams: ${shown.size > 0 ? [...shown].map(id => `@${id}`).join(", ") : "(none)"}`,
        "last injected hits:",
        stats.lastHits || "(none)",
        `prompts ${stats.prompts} · context spawns ${stats.execs} · last ${stats.lastMs} ms · ` +
          `injected ${stats.injectedChars} chars · runs without memory ${stats.silentRuns}`,
        `role: ${roleOf(ctx)} · focus streams: ${focusText} · files changed this request: ${request.edited.size}`,
        `checkpoints: ${stats.checkpoints} · breadcrumbs: ${stats.breadcrumbs}`,
        `last error: ${stats.lastError || "(none)"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

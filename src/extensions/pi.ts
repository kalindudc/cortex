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
 *   - Every session starts with a frozen primer of the repo's memory streams;
 *     every substantive prompt surfaces only NEW relevant streams.
 *   - `cortex_recall` loads one stream with its staleness check, or searches.
 *
 * Overhead contract (memory must speed agents up, not make them loop):
 *   - A user prompt costs at most ONE `cortex memory context` spawn (3 s
 *     timeout; a failure never blocks or throws). After the session's first
 *     prompt (which fetches the primer) it costs ZERO when the prompt has
 *     fewer than 2 content words, and later spawns pass `--no-primer`.
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

function freshStats() {
  return { prompts: 0, execs: 0, lastMs: 0, injectedChars: 0, lastError: "", lastHits: "", silentRuns: 0 };
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

  pi.on("session_start", () => {
    primer = null;
    lane = null;
    shown.clear();
    pendingInput = null;
    recalls = 0;
    recalled.clear();
    sawPrompt = false;
    stats = freshStats();
  });

  pi.on("session_compact", () => {
    primer = null;
    shown.clear();
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

  async function injectMemory(event, ctx, query: string) {
    stats.prompts++;
    const first = primer === null;
    const withQuery = contentWords(query) >= 2;
    let ids: number[] = [];
    let hitsText = "";
    let status: string | undefined;

    if (first || withQuery) {
      const args = [
        "memory",
        "context",
        "--json",
        `--author=pi-${ctx.sessionManager.getSessionId()}`,
        `--limit=${first ? FIRST_HITS : LATER_HITS}`,
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
        primer ??= "";
        stats.lastError = failed(r)
          ? failureText(r, "cortex memory context")
          : "cortex memory context printed unreadable JSON";
        status = "memory: unavailable";
      } else {
        primer ??= out.primer;
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
    try {
      return await injectMemory(event, ctx, query);
    } catch (err) {
      // Never fail the user's prompt over memory.
      primer ??= "";
      stats.lastError = String(err?.message ?? err);
      return undefined;
    }
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
        'Load one cortex memory stream by id ("@<id>", with a staleness report) or search cortex memory by keywords. Budget: 3 calls per request.',
      promptSnippet: "Load a cortex memory stream (@id, with staleness check) or search memory by keywords.",
      promptGuidelines: [
        "Relevant cortex memory is injected automatically (<cortex_memory> and cortex-memory messages): do NOT search memory at the start of a request.",
        'Call cortex_recall only when the user refers to earlier work you cannot see, or before continuing/relying on a stream: "@<id>" loads it with its staleness report.',
        "At most 3 cortex_recall calls per request and never the same query twice; then work with what you have.",
        "Memory is a hint, the code and the user are the truth: re-read changed/missing files before acting, then re-sync the stream (cortex skill, recipes/memory.md).",
        "When continuing a stream, follow its Next section and honour its Decisions (user preferences, constraints, rejected options).",
      ],
      parameters: Type.Object({
        query: Type.String({ description: '"@<id>" loads one stream with a staleness check; otherwise keywords' }),
        all_lanes: Type.Optional(Type.Boolean({ description: "search every lane, not only this repo's" })),
      }),

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const text = (message: string) => ({ content: [{ type: "text", text: message }], details: undefined });
        if (++recalls > RECALL_BUDGET) {
          return text("Recall budget for this request is spent; continue the task with what you have.");
        }
        const query = params.query.trim();
        const key = `${params.all_lanes ? "all:" : ""}${query.toLowerCase().replace(/\s+/g, " ")}`;
        if (recalled.has(key)) return text("Already recalled in this request; see the earlier result.");

        const byId = /^@?(\d+)$/.exec(query);
        const args = byId
          ? ["memory", "show", byId[1]]
          : [
              "memory",
              "search",
              sanitize(query),
              "--limit=5",
              ...(!params.all_lanes && lane ? [`--lane=${lane}`] : []),
            ];
        // Claimed BEFORE the exec: pi runs one assistant message's tool calls in
        // parallel, so a duplicate must see it in flight. A failure releases it.
        recalled.add(key);
        const r = await pi.exec("cortex", args, { cwd: ctx.cwd, timeout: RECALL_TIMEOUT_MS, signal });
        if (failed(r)) {
          recalled.delete(key);
          throw new Error(failureText(r, `cortex ${args.slice(0, 2).join(" ")}`));
        }
        if (byId) shown.add(Number(byId[1]));
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
      const lines = [
        `cortex memory — lane: ${lane ?? "(unknown)"}`,
        `primer (${primer?.length ?? 0} chars):`,
        primer || "(none)",
        `shown streams: ${shown.size > 0 ? [...shown].map(id => `@${id}`).join(", ") : "(none)"}`,
        "last injected hits:",
        stats.lastHits || "(none)",
        `prompts ${stats.prompts} · context spawns ${stats.execs} · last ${stats.lastMs} ms · ` +
          `injected ${stats.injectedChars} chars · runs without memory ${stats.silentRuns}`,
        `last error: ${stats.lastError || "(none)"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

import { defineCommand } from "citty";
import { HttpError } from "../api.ts";
import type { MemorySearchResult } from "../contracts.ts";
import { withClient } from "../daemon.ts";
import {
  breadcrumbs,
  checkStaleness,
  MEMORY_LIMITS,
  memoryLane,
  renderHits,
  renderPrimer,
  renderStream,
} from "../memory.ts";
import { emitError, printJson } from "../output.ts";
import type { MemoryStream, MemoryStreamRow } from "../store.ts";

/**
 * `cortex memory` — agent memory over cortex tasks (plan @414). A task is a
 * memory stream: body = current state, updates = breadcrumbs, lane = repo.
 *
 *   search <query>  ranked recall (derived FTS5 index; punctuation ignored)
 *   show <id>       staleness since the last BODY sync + body + breadcrumb trail
 *   context         the one call a harness makes per prompt: primer + hits
 *   lane            the lane of the current checkout (git's common dir)
 *
 * Every read goes through withClient (the verified daemon, or the same
 * handlers in-process). git runs only OUTSIDE withClient: `context` resolves
 * the lane first and `show` checks staleness after the lease is released.
 * Nested subcommands skip normalizeArgv, so harnesses pass `--flag=value`.
 */

const jsonArg = {
  type: "boolean" as const,
  default: false,
  description: "emit JSON instead of the text an agent reads",
};

function positiveInt(raw: string | undefined, name: string, json: boolean): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) emitError(json, new Error(`${name} must be a positive integer`));
  return value;
}

function taskIds(raw: string | undefined, json: boolean): number[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw
    .split(",")
    .map(part => positiveInt(part, "exclude", json) ?? emitError(json, new Error("empty exclude id")));
}

const search = defineCommand({
  meta: { name: "search", description: "rank memory streams for free text (titles, tags, bodies, update logs)" },
  args: {
    query: { type: "positional", required: true, description: "free text; punctuation and filler words are ignored" },
    lane: { type: "string", alias: "l", valueHint: "name", description: "only streams in this lane" },
    limit: {
      type: "string",
      alias: "n",
      valueHint: "int",
      description: `max hits (default ${MEMORY_LIMITS.hits}, at most ${MEMORY_LIMITS.maxHits})`,
    },
    json: jsonArg,
  },
  async run({ args }) {
    const json = args.json;
    const limit = positiveInt(args.limit, "limit", json);
    let result: MemorySearchResult;
    try {
      result = await withClient(client => client.memorySearch({ q: args.query, lane: args.lane || undefined, limit }));
    } catch (err) {
      emitError(json, err);
    }
    if (json) {
      printJson(result);
      return;
    }
    console.log(renderHits(result.terms, result.hits) || "(no matching memory)");
  },
});

const show = defineCommand({
  meta: {
    name: "show",
    description: "one stream: staleness since its last body sync, the body, and the breadcrumb trail since then",
  },
  args: {
    id: { type: "positional", required: true, valueHint: "task-id", description: "task id (see `cortex ls`)" },
    json: jsonArg,
  },
  async run({ args }) {
    const json = args.json;
    const id = Number.parseInt(args.id, 10);
    if (!Number.isFinite(id) || id <= 0 || String(id) !== args.id.trim()) {
      emitError(json, new Error("id must be a positive integer"));
    }
    let stream: MemoryStream;
    try {
      stream = await withClient(client => client.memoryStream(id));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) emitError(json, new Error(`task ${id} not found`));
      emitError(json, err);
    }
    // After withClient: the lease is released before git runs.
    const staleness = checkStaleness(stream, process.cwd());
    if (json) {
      const trail = breadcrumbs(stream.updates, stream.syncedUpdateId).slice(-MEMORY_LIMITS.trail);
      printJson({ task: stream.task, synced: stream.synced, trail, staleness });
      return;
    }
    console.log(renderStream(stream, staleness));
  },
});

const context = defineCommand({
  meta: {
    name: "context",
    description: "one-call agent context: the lane's primer plus hits for --query (use --flag=value)",
  },
  args: {
    lane: { type: "string", alias: "l", valueHint: "name", description: "lane (default: this checkout's lane)" },
    author: { type: "string", valueHint: "tag", description: "author tag whose touched streams lead the primer" },
    query: { type: "string", alias: "q", valueHint: "text", description: "free text to recall hits for" },
    exclude: { type: "string", valueHint: "1,2", description: "task ids already shown to the caller" },
    limit: { type: "string", alias: "n", valueHint: "int", description: `max hits (default ${MEMORY_LIMITS.hits})` },
    primer: {
      type: "boolean",
      default: true,
      description: "include the primer; --no-primer returns hits only (no stream reads)",
    },
    json: jsonArg,
  },
  async run({ args }) {
    const json = args.json;
    const limit = positiveInt(args.limit, "limit", json);
    const exclude = taskIds(args.exclude, json);
    // git runs before withClient takes the lease.
    const lane = args.lane || memoryLane(process.cwd());
    const author = args.author || undefined;
    const query = (args.query ?? "").trim();
    let active: MemoryStreamRow[] = [];
    let authored: MemoryStreamRow[] = [];
    let found: MemorySearchResult = { terms: [], hits: [] };
    try {
      await withClient(async client => {
        if (args.primer) {
          // Up to 50 rows so the primer can say how many more exist.
          active = await client.memoryStreams({ lane, active: true, limit: 50 });
          if (author) authored = await client.memoryStreams({ author, limit: MEMORY_LIMITS.primerStreams });
        }
        if (query) found = await client.memorySearch({ q: query, lane, limit: limit ?? MEMORY_LIMITS.hits, exclude });
      });
    } catch (err) {
      emitError(json, err);
    }
    const primer = args.primer ? renderPrimer({ lane, author, active, authored }) : "";
    const hitsText = renderHits(found.terms, found.hits);
    if (json) {
      printJson({ lane, terms: found.terms, primer, hits: found.hits, hitsText });
      return;
    }
    console.log([primer, hitsText].filter(Boolean).join("\n\n") || `(no memory in lane ${lane})`);
  },
});

const laneCmd = defineCommand({
  meta: { name: "lane", description: "print this checkout's memory lane (git's common dir; worktrees share it)" },
  run() {
    console.log(memoryLane(process.cwd()));
  },
});

export default defineCommand({
  meta: {
    name: "memory",
    description: "agent memory: ranked recall, staleness since the last body sync, breadcrumbs, one-call context",
  },
  subCommands: { search, show, context, lane: laneCmd },
});

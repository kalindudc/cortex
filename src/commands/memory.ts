import { defineCommand } from "citty";
import { HttpError } from "../api.ts";
import type { MemorySearchResult, MemoryWriteResult } from "../contracts.ts";
import { requireMemoryWrites, withClient } from "../daemon.ts";
import { authorForBbThread } from "../lib/bbAuthor.ts";
import {
  breadcrumbs,
  checkStaleness,
  isoDay,
  MEMORY_LIMITS,
  matchingSections,
  memoryLane,
  primerRows,
  renderHits,
  renderPrimer,
  renderStream,
  repoInfo,
} from "../memory.ts";
import { emitError, printJson } from "../output.ts";
import { type MemoryStream, type MemoryStreamRow, type Task, validateAuthorTag } from "../store.ts";

/**
 * `cortex memory` — agent memory over cortex tasks. A task is a memory
 * stream: body = current state, updates = breadcrumbs, lane = the project
 * (derived from the ask; recall spans every lane).
 *
 *   search <query>  ranked recall across lanes (derived FTS5 index; punctuation, paths, URLs and filler ignored)
 *   show <id>       staleness since the last BODY sync + body (section-first when long) + breadcrumb trail
 *   context         the one call a harness makes per prompt: primer + hits (this lane boosted)
 *   streams         the streams one author posted updates to (e.g. a bb thread's tasks)
 *   lane            the lane of the current checkout (git's common dir)
 *   exclude <id>    keep a task out of what memory offers; reading it by id still works
 *   include <id>    let memory offer it again
 *   excluded        the tasks kept out of memory
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

function taskId(raw: string, json: boolean): number {
  const id = Number.parseInt(raw, 10);
  if (!Number.isFinite(id) || id <= 0 || String(id) !== raw.trim()) {
    emitError(json, new Error("id must be a positive integer"));
  }
  return id;
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
    query: {
      type: "positional",
      required: true,
      description: "free text; punctuation, filler words, URLs, paths, emails, ids and fenced code are ignored",
    },
    lane: {
      type: "string",
      alias: "l",
      valueHint: "name",
      description: "only streams in this lane (default: every lane)",
    },
    boost: {
      type: "string",
      valueHint: "lane",
      description: `rank this lane's streams higher (\u00d7${MEMORY_LIMITS.laneBoost}); use --boost=<lane>`,
    },
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
      result = await withClient(client =>
        client.memorySearch({ q: args.query, lane: args.lane || undefined, boost: args.boost || undefined, limit }),
      );
    } catch (err) {
      emitError(json, err);
    }
    if (json) {
      printJson(result);
      return;
    }
    console.log(renderHits(result.terms, result.hits, Date.now(), { recent: result.recent }) || "(no matching memory)");
  },
});

const show = defineCommand({
  meta: {
    name: "show",
    description:
      "one stream: staleness since its last body sync, the body (Next/Decisions first when long), and the breadcrumb trail since then",
  },
  args: {
    id: { type: "positional", required: true, valueHint: "task-id", description: "task id (see `cortex ls`)" },
    section: {
      type: "string",
      valueHint: "text",
      description: "only the sections whose heading slug contains this text, in full; use --section=<text>",
    },
    json: jsonArg,
  },
  async run({ args }) {
    const json = args.json;
    const id = taskId(args.id, json);
    let stream: MemoryStream;
    try {
      stream = await withClient(client => client.memoryStream(id));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) emitError(json, new Error(`task ${id} not found`));
      emitError(json, err);
    }
    // After withClient: the lease is released before git runs.
    const staleness = checkStaleness(stream, process.cwd());
    const section = args.section?.trim() || undefined;
    if (json) {
      const trail = breadcrumbs(stream.updates, stream.syncedUpdateId).slice(-MEMORY_LIMITS.trail);
      const out = { task: stream.task, synced: stream.synced, latest: stream.latest, trail, staleness };
      printJson(section ? { ...out, sections: matchingSections(stream.task.body ?? "", section) } : out);
      return;
    }
    console.log(renderStream(stream, staleness, { section }));
  },
});

const context = defineCommand({
  meta: {
    name: "context",
    description:
      "one-call agent context: the lane's primer plus hits for --query from every lane, this lane first (use --flag=value)",
  },
  args: {
    lane: {
      type: "string",
      alias: "l",
      valueHint: "name",
      description: "the primer's lane and the boosted lane for hits (default: this checkout's lane)",
    },
    author: {
      type: "string",
      valueHint: "tag",
      description:
        "author tag whose touched streams lead the primer and come back as hits only when the query names them",
    },
    parent: {
      type: "string",
      valueHint: "tag",
      description:
        "with --query, the author tag of the thread that started this one: its streams are linked and keyword hits are left out (its brief carries the context)",
    },
    query: { type: "string", alias: "q", valueHint: "text", description: "free text to recall hits for" },
    exclude: { type: "string", valueHint: "1,2", description: "task ids already shown to the caller" },
    limit: { type: "string", alias: "n", valueHint: "int", description: `max hits (default ${MEMORY_LIMITS.hits})` },
    "load-hint": {
      type: "string",
      valueHint: "text",
      description: "how the hits text tells the reader to load a hit (default: `cortex memory show <id>`)",
    },
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
    const cwd = process.cwd();
    const checkout = args.lane ? null : repoInfo(cwd);
    const lane = args.lane || memoryLane(cwd, checkout);
    const author = args.author || undefined;
    const parent = args.parent?.trim() || undefined;
    const query = (args.query ?? "").trim();
    const loadHint = args["load-hint"]?.trim() || undefined;
    let active: MemoryStreamRow[] = [];
    let authored: MemoryStreamRow[] = [];
    let elsewhere: MemoryStreamRow[] = [];
    let found: MemorySearchResult = { terms: [], recent: false, hits: [] };
    try {
      await withClient(async client => {
        if (args.primer) {
          // Up to 50 rows so the primer can say how many more exist.
          active = await client.memoryStreams({ lane, active: true, limit: 50 });
          if (author) authored = await client.memoryStreams({ author, limit: MEMORY_LIMITS.primerStreams });
          elsewhere = await client.memoryStreams({
            excludeLane: lane,
            active: true,
            limit: MEMORY_LIMITS.elsewhereStreams + MEMORY_LIMITS.primerStreams,
          });
        }
        // Every lane, this one boosted: work spans repos. The author's own streams come back only when named.
        if (query) {
          found = await client.memorySearch({
            q: query,
            boost: lane,
            limit: limit ?? MEMORY_LIMITS.hits,
            exclude,
            self: author,
            related: parent,
            linkedOnly: parent !== undefined,
          });
        }
      });
    } catch (err) {
      emitError(json, err);
    }
    const input = { lane, author, active, authored, elsewhere };
    const primer = args.primer ? renderPrimer(input) : "";
    const hitsText = renderHits(found.terms, found.hits, Date.now(), { recent: found.recent, loadHint });
    if (json) {
      // The ids of exactly the streams the primer lists (the pi extension's /memory ledger).
      const rows = args.primer ? primerRows(input) : null;
      const primerIds = rows ? [...rows.touched, ...rows.active, ...rows.elsewhere].map(row => row.id) : [];
      printJson({
        lane,
        checkoutLane: checkout?.lane ?? null,
        terms: found.terms,
        recent: found.recent,
        primer,
        primerIds,
        hits: found.hits,
        hitsText,
      });
      return;
    }
    console.log([primer, hitsText].filter(Boolean).join("\n\n") || `(no memory in lane ${lane})`);
  },
});

const STREAMS_DEFAULT_LIMIT = 20;

const streams = defineCommand({
  meta: {
    name: "streams",
    description: "the streams an author posted updates to, newest activity first, without bodies (use --flag=value)",
  },
  args: {
    author: { type: "string", required: true, valueHint: "tag", description: "exact author tag, e.g. bb-<thread id>" },
    "with-excluded": {
      type: "boolean",
      default: false,
      description: "also list tasks excluded from memory (for the user's own views, such as bb's Cortex tab)",
    },
    limit: {
      type: "string",
      alias: "n",
      valueHint: "int",
      description: `max rows (default ${STREAMS_DEFAULT_LIMIT}, at most 50)`,
    },
    json: jsonArg,
  },
  async run({ args }) {
    const json = args.json;
    const author = args.author.trim();
    if (!author) emitError(json, new Error("--author must not be blank"));
    const limit = positiveInt(args.limit, "limit", json) ?? STREAMS_DEFAULT_LIMIT;
    let rows: MemoryStreamRow[];
    try {
      rows = await withClient(client => client.memoryStreams({ author, limit, withExcluded: args["with-excluded"] }));
    } catch (err) {
      emitError(json, err);
    }
    if (json) {
      printJson(rows);
      return;
    }
    if (rows.length === 0) {
      console.log(`(no streams with updates by ${author})`);
      return;
    }
    for (const row of rows) {
      const excluded = row.memory_excluded ? EXCLUDED_NOTE : "";
      console.log(
        `[${row.id}] ${row.status} \u00b7 ${row.lane} \u00b7 active ${isoDay(row.activity)} \u00b7 ${row.title}${excluded}`,
      );
    }
  },
});

const EXCLUDED_NOTE = " \u00b7 excluded from memory";

/** `exclude` and `include` commit the change and optional audit update together. */
function exclusionCommand(excluded: boolean) {
  return defineCommand({
    meta: {
      name: excluded ? "exclude" : "include",
      description: excluded
        ? "keep a task out of what memory offers agents (search, primer, latest linked); reading it by id still works"
        : "let memory offer a task again after `cortex memory exclude`",
    },
    args: {
      id: { type: "positional", required: true, valueHint: "task-id", description: "task id (see `cortex ls`)" },
      message: {
        type: "string",
        alias: "m",
        valueHint: "reason",
        description: "post an attributed reason for the change",
      },
      as: { type: "string", valueHint: "id", description: "author tag; defaults to bb-<thread id> with --message" },
      json: jsonArg,
    },
    async run({ args }) {
      const json = args.json;
      const id = taskId(args.id, json);
      let result: MemoryWriteResult;
      try {
        const reason = args.message;
        const selected = reason === undefined ? args.as : authorForBbThread(args.as, process.env.BB_THREAD_ID);
        if (reason !== undefined && selected === undefined) throw new Error("--as is required outside a bb thread");
        const author = selected === undefined ? undefined : validateAuthorTag(selected);
        result = await withClient((client, target) => {
          if (author !== undefined || reason !== undefined) requireMemoryWrites(target);
          return client.versioned.setMemory(id, { excluded, author, reason });
        });
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) emitError(json, new Error(`task ${id} not found`));
        emitError(json, err);
      }
      if (json) {
        printJson({ ...result.task, changed: result.changed });
        return;
      }
      if (result.changed === false) {
        console.log(`\u2713 @${id} already ${excluded ? "excluded from" : "included in"} memory; no change`);
        return;
      }
      console.log(
        excluded
          ? `\u2713 @${id} excluded from memory; reading it by id still works`
          : `\u2713 @${id} included in memory`,
      );
    },
  });
}

const excludedCmd = defineCommand({
  meta: {
    name: "excluded",
    description: "list the tasks kept out of memory (`cortex memory include <id>` undoes one)",
  },
  args: { json: jsonArg },
  async run({ args }) {
    const json = args.json;
    let tasks: Task[];
    try {
      tasks = await withClient(client => client.tasks());
    } catch (err) {
      emitError(json, err);
    }
    const rows = tasks.filter(task => task.memory_excluded).map(({ body: _body, ...row }) => row);
    if (json) {
      printJson(rows);
      return;
    }
    if (rows.length === 0) {
      console.log("(no tasks are excluded from memory)");
      return;
    }
    for (const row of rows) {
      const { excluded_by, excluded_at, reason } = row.memory_exclusion ?? {};
      const details = [excluded_by, excluded_at == null ? null : isoDay(excluded_at), reason].filter(Boolean);
      console.log(
        `[${row.id}] ${row.status} \u00b7 ${row.lane} \u00b7 ${row.title}${details.length ? ` \u00b7 ${details.join(" \u00b7 ")}` : ""}`,
      );
    }
  },
});

const laneCmd = defineCommand({
  meta: { name: "lane", description: "print this checkout's memory lane (git's common dir; worktrees share it)" },
  args: {
    checkout: { type: "boolean", default: false, description: "only print a lane inside a Git checkout" },
  },
  run({ args }) {
    const cwd = process.cwd();
    if (!args.checkout) {
      console.log(memoryLane(cwd));
      return;
    }
    const checkout = repoInfo(cwd);
    if (checkout) console.log(checkout.lane);
  },
});

export default defineCommand({
  meta: {
    name: "memory",
    description: "agent memory: ranked recall, staleness since the last body sync, breadcrumbs, one-call context",
  },
  subCommands: {
    search,
    show,
    context,
    streams,
    lane: laneCmd,
    exclude: exclusionCommand(true),
    include: exclusionCommand(false),
    excluded: excludedCmd,
  },
});

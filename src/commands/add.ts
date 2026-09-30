import { defineCommand } from "citty";
import type { CreateTaskRequest } from "../contracts.ts";
import { withClient } from "../daemon.ts";
import { validateAuthorTag, validateTagName, type Task, type TaskStatus } from "../store.ts";
import { emitError, emitOk, resolveBody } from "../output.ts";

/** Parse a comma-separated tag list and validate each name. Empty/blank entries
 *  are silently dropped (e.g. `-t a,,b` becomes `["a","b"]`). */
function parseTags(raw: string): string[] {
  const names = raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  return names.map(n => validateTagName(n));
}

function parsePriority(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== raw.trim()) {
    console.error(`error: --priority must be a non-negative integer (0 = highest); got '${raw}'`);
    process.exit(1);
  }
  return n;
}

export default defineCommand({
  meta: { name: "add", description: "add a task" },
  args: {
    title: {
      type: "positional",
      required: true,
      description: "task title (quote it if it has spaces)",
    },
    lane: {
      type: "string",
      alias: "l",
      default: "now",
      valueHint: "name",
      description: "lane to put the task in (auto-created if missing)",
    },
    priority: {
      type: "string",
      alias: "p",
      valueHint: "int",
      description:
        "priority as a non-negative integer; 0 = highest. Optional — leave unset for archive/research/document tasks.",
    },
    body: {
      type: "string",
      alias: "b",
      valueHint: "text",
      description: "longer description shown by `cortex show`",
    },
    bodyFile: {
      type: "string",
      valueHint: "path",
      description: "read body from file (mutually exclusive with -b)",
    },
    status: {
      type: "string",
      alias: "s",
      valueHint: "draft|open|review|blocked|done",
      description: "initial status (default: open)",
    },
    tags: {
      type: "string",
      alias: "t",
      valueHint: "a,b,c",
      description: "comma-separated tag names; auto-creates missing tags",
    },
    json: {
      type: "boolean",
      default: false,
      description: "emit the created task as JSON instead of the human line",
    },
    as: {
      type: "string",
      alias: "author",
      valueHint: "id",
      description:
        "optional attribution tag; when set, records the first 'created' update so the task is not anonymous (create + attribute in one call)",
    },
  },
  async run({ args }) {
    const json = args.json;
    const raw = await resolveBody(json, args.body, args.bodyFile);
    const body: string | null = raw || null;
    // Parse + validate tags BEFORE opening the daemon connection or store
    // so a bad tag name fails fast without persisting a half-tagged task.
    let tagNames: string[] = [];
    if (args.tags) {
      try {
        tagNames = parseTags(args.tags);
      } catch (e) {
        emitError(json, e);
      }
    }
    // Validate the optional --as attribution up front (Store + server also
    // validate) so a bad tag fails before we persist a task.
    let author: string | undefined;
    if (args.as !== undefined) {
      try {
        author = validateAuthorTag(args.as);
      } catch (e) {
        emitError(json, e);
      }
    }
    // ONE create request: tags and the optional `created` attribution row
    // commit in the task's own transaction, through the verified daemon
    // or, without one, the same handler in-process.
    const payload: CreateTaskRequest = {
      title: args.title,
      lane: args.lane,
      body,
      ...(args.priority !== undefined ? { priority: parsePriority(args.priority) } : {}),
      ...(args.status ? { status: args.status as TaskStatus } : {}),
      ...(tagNames.length > 0 ? { tags: tagNames } : {}),
      ...(author !== undefined ? { author } : {}),
    };
    let task: Task;
    try {
      task = await withClient(client => client.addTask(payload));
    } catch (err) {
      emitError(json, err);
    }
    emitOk(json, task, `[${task.id}] ${task.title}`);
  },
});

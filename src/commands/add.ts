import { defineCommand } from "citty";
import { Store, validateAuthorTag, validateTagName, type Task, type TaskStatus } from "../store.ts";
import { Client, daemonUrl } from "../client.ts";
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
    const payload = {
      title: args.title,
      lane: args.lane,
      body,
      ...(args.priority !== undefined ? { priority: parsePriority(args.priority) } : {}),
      ...(args.status ? { status: args.status as TaskStatus } : {}),
    };
    const url = daemonUrl();
    if (url) {
      try {
        let task = (await Client.addTask(url, payload)) as Task;
        if (tagNames.length > 0) {
          task = (await Client.setTaskTags(url, task.id, tagNames)) as Task;
        }
        if (author !== undefined) {
          await Client.addUpdate(url, task.id, { author, summary: "created" });
        }
        emitOk(json, task, `[${task.id}] ${task.title}`);
        return;
      } catch (err) {
        emitError(json, err);
      }
    }
    const store = Store.open();
    try {
      let task = store.addTask(payload);
      if (tagNames.length > 0) {
        task = store.setTaskTags(task.id, tagNames);
      }
      if (author !== undefined) {
        store.addUpdate({ task_id: task.id, author, summary: "created" });
      }
      emitOk(json, task, `[${task.id}] ${task.title}`);
    } catch (err) {
      emitError(json, err);
    } finally {
      store.close();
    }
  },
});

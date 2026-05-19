import fs from "node:fs";
import { defineCommand } from "citty";
import { Store, validateTagName, type Task, type TaskStatus } from "../store.ts";
import { Client, daemonUrl } from "../client.ts";

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
  },
  async run({ args }) {
    if (args.bodyFile && args.body) {
      console.error("error: use --body-file OR -b, not both");
      process.exit(1);
    }
    let body: string | null = args.body || null;
    if (args.bodyFile) {
      try {
        body = fs.readFileSync(args.bodyFile, "utf8");
      } catch (e) {
        console.error(`error: --body-file: ${(e as Error).message}`);
        process.exit(1);
      }
    }
    // Parse + validate tags BEFORE opening the daemon connection or store
    // so a bad tag name fails fast without persisting a half-tagged task.
    let tagNames: string[] = [];
    if (args.tags) {
      try {
        tagNames = parseTags(args.tags);
      } catch (e) {
        console.error(`error: ${(e as Error).message}`);
        process.exit(1);
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
        console.log(`[${task.id}] ${task.title}`);
        return;
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    }
    const store = Store.open();
    try {
      let task = store.addTask(payload);
      if (tagNames.length > 0) {
        task = store.setTaskTags(task.id, tagNames);
      }
      console.log(`[${task.id}] ${task.title}`);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    } finally {
      store.close();
    }
  },
});

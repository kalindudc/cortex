import fs from "node:fs";
import { defineCommand } from "citty";
import { Store, validateTagName, type Task } from "../store.ts";
import { Client, daemonUrl } from "../client.ts";

function parsePriority(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== raw.trim()) {
    console.error(`error: --priority must be a non-negative integer (0 = highest); got '${raw}'`);
    process.exit(1);
  }
  return n;
}

export default defineCommand({
  meta: { name: "edit", description: "edit a task's title/body/priority" },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "task id (see `cortex ls`)",
    },
    title: {
      type: "string",
      alias: "t",
      valueHint: "text",
      description: "new title",
    },
    body: {
      type: "string",
      alias: "b",
      valueHint: "text",
      description: "new body (use empty string to clear)",
    },
    bodyFile: {
      type: "string",
      valueHint: "path",
      description: "read new body from file (mutually exclusive with -b)",
    },
    bodySearch: {
      type: "string",
      valueHint: "text",
      description:
        "anchor text to find in the body (must be unique); paired with --body-replace. Mutually exclusive with -b and --body-file. Fails 409 if anchor is missing or matches multiple times \u2014 agent should re-read and refine.",
    },
    bodyReplace: {
      type: "string",
      valueHint: "text",
      description:
        "replacement for the matched --body-search anchor. Empty string deletes the anchor. Use this for safe partial body edits without read-then-write races.",
    },
    priority: {
      type: "string",
      alias: "p",
      valueHint: "int",
      description: "new priority (non-negative integer; 0 = highest)",
    },
    setTags: {
      type: "string",
      valueHint: "a,b,c",
      description: "replace all tags with this comma-separated list",
    },
    addTag: {
      type: "string",
      valueHint: "name",
      description: "add a single tag (use --set-tags for bulk replace)",
    },
    rmTag: {
      type: "string",
      valueHint: "name",
      description: "remove a single tag",
    },
  },
  async run({ args }) {
    const id = Number.parseInt(args.id, 10);
    if (!Number.isFinite(id)) {
      console.error("error: id must be a number");
      process.exit(1);
    }
    if (args.bodyFile && args.body !== undefined) {
      console.error("error: use --body-file OR -b, not both");
      process.exit(1);
    }
    // bodySearch + bodyReplace must be present together AND mutually
    // exclusive with -b / --body-file. Both rules are also enforced server-
    // side, but checking here gives a fast local exit before round-trip.
    const hasSearch = args.bodySearch !== undefined;
    const hasReplace = args.bodyReplace !== undefined;
    if (hasSearch !== hasReplace) {
      console.error("error: --body-search and --body-replace must be used together");
      process.exit(1);
    }
    if (hasSearch && (args.body !== undefined || args.bodyFile !== undefined)) {
      console.error("error: --body-search/--body-replace cannot be combined with -b or --body-file");
      process.exit(1);
    }
    if (hasSearch && args.bodySearch === "") {
      console.error("error: --body-search cannot be empty");
      process.exit(1);
    }
    const patch: {
      title?: string;
      body?: string | null;
      bodySearch?: string;
      bodyReplace?: string;
      priority?: number;
    } = {};
    if (args.title) patch.title = args.title;
    if (args.bodyFile) {
      try {
        patch.body = fs.readFileSync(args.bodyFile, "utf8");
      } catch (e) {
        console.error(`error: --body-file: ${(e as Error).message}`);
        process.exit(1);
      }
    } else if (args.body !== undefined && args.body !== "") {
      // Preserve existing semantic: empty -b is a no-op (cf. Plan-1 add.ts).
      patch.body = args.body;
    }
    if (hasSearch) {
      patch.bodySearch = args.bodySearch;
      patch.bodyReplace = args.bodyReplace;
    }
    if (args.priority) patch.priority = parsePriority(args.priority);
    // Tag mutations: exactly one of --set-tags / --add-tag / --rm-tag may be
    // present per invocation. Mirrors the HTTP route's `set | add | remove`
    // exclusivity check; any combination yields a hard exit.
    const tagModes = [args.setTags, args.addTag, args.rmTag].filter(v => v !== undefined).length;
    if (tagModes > 1) {
      console.error("error: --set-tags, --add-tag, and --rm-tag are mutually exclusive");
      process.exit(1);
    }
    let tagOp: { mode: "set" | "add" | "rm"; names: string[] } | null = null;
    try {
      if (args.setTags !== undefined) {
        const names = args.setTags
          .split(",")
          .map(s => s.trim())
          .filter(Boolean)
          .map(n => validateTagName(n));
        tagOp = { mode: "set", names };
      } else if (args.addTag !== undefined) {
        tagOp = { mode: "add", names: [validateTagName(args.addTag)] };
      } else if (args.rmTag !== undefined) {
        tagOp = { mode: "rm", names: [validateTagName(args.rmTag)] };
      }
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    }
    if (Object.keys(patch).length === 0 && tagOp === null) {
      console.error("error: provide at least one of --title, --body, --priority, --set-tags, --add-tag, --rm-tag");
      process.exit(1);
    }
    const url = daemonUrl();
    if (url) {
      try {
        let task: Task | null = null;
        if (Object.keys(patch).length > 0) {
          task = (await Client.editTask(url, id, patch)) as Task;
        }
        if (tagOp) {
          const newSet = await resolveTagSet(tagOp, async () => (await Client.getTask(url, id)) as Task);
          task = (await Client.setTaskTags(url, id, newSet)) as Task;
        }
        if (!task) throw new Error("no fields changed");
        console.log(`✓ edited [${task.id}] ${task.title}`);
        if (tagOp) console.log(`✓ tags: ${task.tags.join(",")}`);
        return;
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    }
    const store = Store.open();
    try {
      let task: Task | null = null;
      if (Object.keys(patch).length > 0) {
        task = store.editTask(id, patch);
      }
      if (tagOp) {
        const newSet = await resolveTagSet(tagOp, async () => {
          const t = store.getTask(id);
          if (!t) throw new Error(`task ${id} not found`);
          return t;
        });
        task = store.setTaskTags(id, newSet);
      }
      if (!task) throw new Error("no fields changed");
      console.log(`✓ edited [${task.id}] ${task.title}`);
      if (tagOp) console.log(`✓ tags: ${task.tags.join(",")}`);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    } finally {
      store.close();
    }
  },
});

/** Compute the new tag set for a single edit invocation.
 *  - set: caller-supplied list IS the new set.
 *  - add: existing ∪ {name} (deduped via Set).
 *  - rm:  existing ∖ {name}.
 *  Reads existing tags only when needed (add/rm), never in set mode. */
async function resolveTagSet(
  op: { mode: "set" | "add" | "rm"; names: string[] },
  fetchExisting: () => Promise<Task>,
): Promise<string[]> {
  if (op.mode === "set") return op.names;
  const existing = await fetchExisting();
  if (op.mode === "add") {
    return Array.from(new Set([...existing.tags, ...op.names]));
  }
  const drop = new Set(op.names);
  return existing.tags.filter(n => !drop.has(n));
}

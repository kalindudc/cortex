import { defineCommand } from "citty";
import type { CortexClient, EditTaskRequest } from "../contracts.ts";
import { requireAtomicEdit, withClient } from "../daemon.ts";
import { STATUS } from "../lib/constants.ts";
import { type EditedTask, validateEditNote, validateTagName, type Task } from "../store.ts";
import { emitError, printJson, resolveBody } from "../output.ts";

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
    clearPriority: {
      type: "boolean",
      description: "clear the task's priority back to unset (mutually exclusive with --priority)",
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
    message: {
      type: "string",
      valueHint: "text",
      description: "post an update with this summary atomically with the title/body/priority edit (requires --as)",
    },
    as: {
      type: "string",
      valueHint: "id",
      description: "author tag for the edit's --message",
    },
    "unless-status": {
      type: "string",
      valueHint: "review,done",
      description: "refuse the title/body/priority edit if the task has any of these comma-separated statuses",
    },
    json: {
      type: "boolean",
      default: false,
      description: "emit the edited task as JSON instead of the human line",
    },
  },
  async run({ args }) {
    const json = args.json;
    const id = Number.parseInt(args.id, 10);
    if (!Number.isFinite(id)) {
      emitError(json, new Error("id must be a number"));
    }
    // bodySearch + bodyReplace must be present together AND mutually
    // exclusive with -b / --body-file. Both rules are also enforced server-
    // side, but checking here gives a fast local exit before round-trip.
    const hasSearch = args.bodySearch !== undefined;
    const hasReplace = args.bodyReplace !== undefined;
    if (hasSearch !== hasReplace) {
      emitError(json, new Error("--body-search and --body-replace must be used together"));
    }
    if (hasSearch && (args.body !== undefined || args.bodyFile !== undefined)) {
      emitError(json, new Error("--body-search/--body-replace cannot be combined with -b or --body-file"));
    }
    if (hasSearch && args.bodySearch === "") {
      emitError(json, new Error("--body-search cannot be empty"));
    }
    const patch: EditTaskRequest = {};
    if (args.title) patch.title = args.title;
    if (!hasSearch) {
      // --body-file (incl. "-" stdin) always sets the body, even empty (a
      // clear); an empty -b stays a no-op (cf. add.ts). resolveBody enforces
      // the -b/--body-file mutex and routes read errors through emitError.
      const raw = await resolveBody(json, args.body, args.bodyFile);
      if (args.bodyFile !== undefined) {
        patch.body = raw ?? "";
      } else if (raw !== undefined && raw !== "") {
        patch.body = raw;
      }
    } else {
      patch.bodySearch = args.bodySearch;
      patch.bodyReplace = args.bodyReplace;
    }
    if (args.priority !== undefined && args.clearPriority) {
      emitError(json, new Error("--priority and --clear-priority are mutually exclusive"));
    }
    if (args.priority) patch.priority = parsePriority(args.priority);
    if (args.clearPriority) patch.priority = null;
    // Tag mutations: exactly one of --set-tags / --add-tag / --rm-tag may be
    // present per invocation. Mirrors the HTTP route's `set | add | remove`
    // exclusivity check; any combination yields a hard exit.
    const tagModes = [args.setTags, args.addTag, args.rmTag].filter(v => v !== undefined).length;
    if (tagModes > 1) {
      emitError(json, new Error("--set-tags, --add-tag, and --rm-tag are mutually exclusive"));
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
      emitError(json, e);
    }
    const hasFields = Object.keys(patch).length > 0;
    if (!hasFields && tagOp === null) {
      emitError(
        json,
        new Error(
          "provide at least one of --title, --body, --priority, --clear-priority, --set-tags, --add-tag, --rm-tag",
        ),
      );
    }
    if (args["unless-status"] !== undefined) {
      const unlessStatus = args["unless-status"]
        .split(",")
        .map(value => STATUS.find(status => status === value.trim()));
      if (!unlessStatus.every(status => status !== undefined)) {
        emitError(json, new Error("--unless-status needs valid task statuses"));
      }
      patch.unlessStatus = unlessStatus;
    }
    if ((args.message === undefined) !== (args.as === undefined)) {
      emitError(json, new Error("--message and --as must be used together"));
    }
    try {
      if (args.message !== undefined) patch.note = validateEditNote({ author: args.as, summary: args.message });
    } catch (err) {
      emitError(json, err);
    }
    const atomic = patch.note !== undefined || patch.unlessStatus !== undefined;
    if (atomic && tagOp !== null) {
      emitError(
        json,
        new Error("--message and --unless-status apply only to title, body, or priority edits; edit tags separately"),
      );
    }
    // Field edits, then the tag change as an atomic membership delta (or a
    // whole-set replace for --set-tags), through the verified daemon or,
    // without one, the same handlers in-process under one ownership lease.
    const tagChange = tagOp;
    let task: EditedTask;
    try {
      task = await withClient(async (client, target) => {
        if (atomic) requireAtomicEdit(target);
        let edited: EditedTask | null = null;
        if (hasFields) edited = await client.editTask(id, patch);
        if (tagChange) edited = await applyTagOp(client, id, tagChange);
        if (!edited) throw new Error("no fields changed");
        return edited;
      });
    } catch (err) {
      emitError(json, err);
    }
    emitEdited(json, task, tagOp !== null);
  },
});

/** Emit an edited task: JSON object, or the human ✓ line(s). */
function emitEdited(json: boolean, task: EditedTask, showTags: boolean): void {
  if (json) {
    printJson(task);
    return;
  }
  console.log(`✓ edited [${task.id}] ${task.title}`);
  if (showTags) console.log(`✓ tags: ${task.tags.join(",")}`);
  if (task.update) console.log(`✓ update [${task.update.id}] posted on task ${task.id}`);
}

/**
 * Apply one edit invocation's tag change.
 *  - set: the caller-supplied list IS the new set (whole-set replace).
 *  - add: existing ∪ {name}, as an atomic membership delta on the server;
 *  - rm:  existing ∖ {name}, likewise; so a concurrent unrelated tag change
 *    survives (no read-then-replace).
 */
function applyTagOp(
  client: CortexClient,
  id: number,
  op: { mode: "set" | "add" | "rm"; names: string[] },
): Promise<Task> {
  if (op.mode === "set") return client.setTags(id, op.names);
  const [name] = op.names;
  if (name === undefined) throw new Error("no tag given");
  return op.mode === "add" ? client.addTaskTag(id, name) : client.removeTaskTag(id, name);
}

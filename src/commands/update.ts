import { defineCommand } from "citty";
import type { PostUpdateRequest } from "../contracts.ts";
import { withClient } from "../daemon.ts";
import { authorForBbThread } from "../lib/bbAuthor.ts";
import { validateAuthorTag, type TaskStatus, type Update } from "../store.ts";
import { emitError, printJson } from "../output.ts";

const STATUSES: TaskStatus[] = ["draft", "open", "review", "blocked", "done"];

export default defineCommand({
  meta: {
    name: "update",
    description: "post an update on a task (and optionally change its status)",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "task id (see `cortex ls`)",
    },
    message: {
      type: "string",
      alias: "m",
      required: true,
      valueHint: "text",
      description: `short summary, max 4096 chars`,
    },
    status: {
      type: "string",
      alias: "s",
      valueHint: "draft|open|review|blocked|done",
      description: `change task status to one of: ${STATUSES.join(", ")}`,
    },
    body: {
      type: "string",
      alias: "b",
      valueHint: "text",
      description: "longer detail shown in `cortex show`",
    },
    as: {
      type: "string",
      alias: "author",
      valueHint: "id",
      description: "author tag; defaults to bb-<thread id> in a bb thread; required otherwise",
    },
    json: {
      type: "boolean",
      default: false,
      description: "emit { update, status? } as JSON instead of the human lines",
    },
  },
  async run({ args }) {
    const json = args.json;
    const id = Number.parseInt(args.id, 10);
    if (!Number.isFinite(id)) {
      emitError(json, new Error("id must be a number"));
    }
    if (args.status && !STATUSES.includes(args.status as TaskStatus)) {
      emitError(json, new Error(`status must be one of ${STATUSES.join(",")}`));
    }
    // Validate the explicit or bb-default tag before contacting the daemon.
    let author: string;
    try {
      const selected = authorForBbThread(args.as, process.env.BB_THREAD_ID);
      if (selected === undefined) emitError(json, new Error("--as is required outside a bb thread"));
      author = validateAuthorTag(selected);
    } catch (err) {
      emitError(json, err);
    }
    // ONE request: the message row, and with --status the status change
    // plus its `status → x` audit row by the same author, commit together or
    // not at all. `notify` marks it an attributed agent
    // change, so a real transition persists its notification.
    const status = args.status ? (args.status as TaskStatus) : undefined;
    const request: PostUpdateRequest = {
      author,
      summary: args.message,
      body: args.body || null,
      ...(status ? { status, notify: true } : {}),
    };
    let update: Update;
    try {
      update = await withClient(client => client.postUpd(id, request));
    } catch (err) {
      emitError(json, err);
    }
    if (json) {
      printJson({ update, ...(status ? { status } : {}) });
      return;
    }
    console.log(`✓ update [${update.id}] posted on task ${id}`);
    if (status) console.log(`✓ status → ${status}`);
  },
});

import { defineCommand } from "citty";
import type { PostUpdateRequest } from "../contracts.ts";
import { withClient } from "../daemon.ts";
import { authorForBbThread } from "../lib/bbAuthor.ts";
import { resolveAuthor } from "../lib/userAuthor.ts";
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
      valueHint: "text",
      description: "short summary, max 4096 chars (required unless --as-me -s changes only the status)",
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
    "as-me": {
      type: "boolean",
      default: false,
      description:
        "record it as the user's own change, like the desktop app: credited to the user, never notifying (for tools acting for the user, not agents)",
    },
    json: {
      type: "boolean",
      default: false,
      description: "emit { update, status? } as JSON instead of the human lines",
    },
  },
  async run({ args }) {
    const json = args.json;
    const asMe = args["as-me"] === true;
    const id = Number.parseInt(args.id, 10);
    if (!Number.isFinite(id)) {
      emitError(json, new Error("id must be a number"));
    }
    if (args.status && !STATUSES.includes(args.status as TaskStatus)) {
      emitError(json, new Error(`status must be one of ${STATUSES.join(",")}`));
    }
    const status = args.status ? (args.status as TaskStatus) : undefined;
    if (asMe && args.as !== undefined) emitError(json, new Error("--as-me cannot be combined with --as"));
    if (args.message === undefined && !(asMe && status)) {
      emitError(json, new Error("--message is required (only --as-me -s <status> may omit it)"));
    }
    if (asMe && args.message === undefined && args.body) {
      emitError(json, new Error("--body needs --message"));
    }
    if (asMe && args.message === undefined && status) {
      await statusAsMe(id, status, json);
      return;
    }
    // Validate the explicit, bb-default or user tag before contacting the daemon.
    let author: string;
    try {
      const selected = asMe ? resolveAuthor() : authorForBbThread(args.as, process.env.BB_THREAD_ID);
      if (selected === undefined) emitError(json, new Error("--as is required outside a bb thread"));
      author = validateAuthorTag(selected);
    } catch (err) {
      emitError(json, err);
    }
    // ONE request: the message row, and with --status the status change
    // plus its `status → x` audit row by the same author, commit together or
    // not at all. `notify` marks it an attributed agent change, so a real
    // transition persists its notification; the user's own post never notifies.
    const request: PostUpdateRequest = {
      author,
      summary: args.message ?? "",
      body: args.body || null,
      ...(status ? { status, ...(asMe ? {} : { notify: true }) } : {}),
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

/**
 * The desktop app's own status write: no author, so the daemon credits the user
 * (GET /api/me) and records no notification. The status route answers with
 * the task only, so `update` is its `status → x` audit row, found by the
 * timestamp the write stamped on both.
 */
async function statusAsMe(id: number, status: TaskStatus, json: boolean): Promise<void> {
  let audit: Update | null;
  try {
    audit = await withClient(async client => {
      const { task } = await client.versioned.setStatus(id, { status });
      const summary = `status \u2192 ${status}`;
      const rows = (await client.updates(id)).filter(u => u.summary === summary && u.created === task.updated);
      return rows.reduce<Update | null>((best, u) => (best === null || u.id > best.id ? u : best), null);
    });
  } catch (err) {
    emitError(json, err);
  }
  if (json) {
    printJson({ update: audit, status });
    return;
  }
  console.log(`✓ status → ${status}${audit ? ` (update [${audit.id}])` : ""}`);
}

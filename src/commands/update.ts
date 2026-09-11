import { defineCommand } from "citty";
import { Store, validateAuthorTag, type TaskStatus, type Update } from "../store.ts";
import { Client, daemonUrl } from "../client.ts";
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
      description: `short summary, max 1024 chars`,
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
      required: true,
      valueHint: "id",
      description:
        "REQUIRED attribution tag for this update. Generate once per session via ${ROLE}-$(openssl rand -hex 4); see ~/.agents/skills/cortex/recipes/session-id.md.",
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
    // citty `required: true` rejects missing --as at parse time, but we
    // also validate the value here (defense in depth: matches Store +
    // server validation, single error format).
    let author: string;
    try {
      author = validateAuthorTag(args.as);
    } catch (err) {
      emitError(json, err);
    }
    const updatePayload = {
      author,
      summary: args.message,
      body: args.body || null,
    };
    const url = daemonUrl();
    if (url) {
      try {
        const u = (await Client.addUpdate(url, id, updatePayload)) as Update;
        if (!json) console.log(`✓ update [${u.id}] posted on task ${id}`);
        if (args.status) {
          // Pass author through so the server's audit-trail row inside
          // setStatus is attributed to the same session, not the cascade.
          await Client.setStatus(url, id, args.status, author);
          if (!json) console.log(`✓ status → ${args.status}`);
        }
        if (json) printJson({ update: u, ...(args.status ? { status: args.status } : {}) });
        return;
      } catch (err) {
        emitError(json, err);
      }
    }
    const store = Store.open();
    try {
      const update = store.addUpdate({ task_id: id, ...updatePayload });
      if (!json) console.log(`✓ update [${update.id}] posted on task ${id}`);
      if (args.status) {
        store.setStatus(id, args.status as TaskStatus, { author });
        if (!json) console.log(`✓ status → ${args.status}`);
      }
      if (json) printJson({ update, ...(args.status ? { status: args.status } : {}) });
    } catch (err) {
      emitError(json, err);
    } finally {
      store.close();
    }
  },
});

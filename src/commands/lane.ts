import { defineCommand } from "citty";
import { withClient } from "../daemon.ts";
import type { Lane } from "../store.ts";
import { emitError, emitOk } from "../output.ts";

/**
 * Every mutating subcommand accepts `--json`: success emits the resulting
 * Lane (or `{ ok, name }` for rm) on stdout; failures route through
 * emitError for the shared machine-readable error envelope. Every
 * subcommand goes through withClient: the verified daemon, or the same
 * handlers in-process while owning the database (plan @400 N6).
 */

const jsonArg = {
  type: "boolean" as const,
  default: false,
  description: "emit the result as JSON instead of the human line",
};

const add = defineCommand({
  meta: { name: "add", description: "create a lane" },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "lane name (also the FK target for tasks)",
    },
    color: {
      type: "string",
      alias: "c",
      valueHint: "#hex",
      description: "display color hex (e.g. #fe8019)",
    },
    json: jsonArg,
  },
  async run({ args }) {
    const json = args.json;
    const payload = {
      name: args.name,
      color: args.color || null,
    };
    let lane: Lane;
    try {
      lane = await withClient(client => client.addLane(payload));
    } catch (err) {
      emitError(json, err);
    }
    emitOk(json, lane, `✓ lane ${lane.name} created`);
  },
});

const ls = defineCommand({
  meta: { name: "ls", description: "list lanes" },
  args: {
    json: {
      type: "boolean",
      default: false,
      description: "emit raw JSON instead of a table",
    },
  },
  async run({ args }) {
    let lanes: Lane[];
    try {
      lanes = await withClient(client => client.lanes());
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
    if (args.json) {
      console.log(JSON.stringify(lanes));
      return;
    }
    console.table(
      lanes.map(l => ({
        name: l.name,
        color: l.color ?? "",
      })),
    );
  },
});

const edit = defineCommand({
  meta: { name: "edit", description: "edit a lane" },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "current lane name",
    },
    color: {
      type: "string",
      alias: "c",
      valueHint: "#hex",
      description: "new display color",
    },
    rename: {
      type: "string",
      valueHint: "new-name",
      description: "rename the lane (cascades to all tasks via FK)",
    },
    json: jsonArg,
  },
  async run({ args }) {
    const json = args.json;
    const fields: {
      color?: string | null;
      rename?: string;
    } = {};
    if (args.color) fields.color = args.color;
    if (args.rename) fields.rename = args.rename;
    if (Object.keys(fields).length === 0) {
      emitError(json, new Error("provide at least one of --color, --rename"));
    }
    let lane: Lane;
    try {
      lane = await withClient(client => client.editLane(args.name, fields));
    } catch (err) {
      emitError(json, err);
    }
    emitOk(json, lane, `✓ lane ${lane.name} updated`);
  },
});

const rm = defineCommand({
  meta: { name: "rm", description: "remove an empty lane (refuses 'now' or non-empty lanes)" },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "lane name",
    },
    json: jsonArg,
  },
  async run({ args }) {
    const json = args.json;
    try {
      await withClient(client => client.delLane(args.name));
    } catch (err) {
      emitError(json, err);
    }
    emitOk(json, { ok: true, name: args.name }, `✓ lane ${args.name} removed`);
  },
});

export default defineCommand({
  meta: { name: "lane", description: "manage lanes" },
  subCommands: { add, ls, edit, rm },
});

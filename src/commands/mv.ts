import { defineCommand } from "citty";
import { Store, type Task } from "../store.ts";
import { Client, daemonUrl } from "../client.ts";
import { emitError, emitOk } from "../output.ts";

export default defineCommand({
  meta: { name: "mv", description: "move a task to a different lane (auto-creates lane if missing)" },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "task id",
    },
    lane: {
      type: "positional",
      required: true,
      description: "destination lane name",
    },
    json: {
      type: "boolean",
      default: false,
      description: "emit the moved task as JSON instead of the human line",
    },
  },
  async run({ args }) {
    const json = args.json;
    const id = Number.parseInt(args.id, 10);
    if (!Number.isFinite(id)) {
      emitError(json, new Error("id must be a number"));
    }
    const url = daemonUrl();
    if (url) {
      try {
        const task = (await Client.moveTask(url, id, args.lane)) as Task;
        emitOk(json, task, `✓ [${task.id}] → ${task.lane}`);
        return;
      } catch (err) {
        emitError(json, err);
      }
    }
    const store = Store.open();
    try {
      const task = store.moveTask(id, args.lane);
      emitOk(json, task, `✓ [${task.id}] → ${task.lane}`);
    } catch (err) {
      emitError(json, err);
    } finally {
      store.close();
    }
  },
});

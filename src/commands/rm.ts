import { defineCommand } from "citty";
import readline from "node:readline";
import { Store } from "../store.ts";
import { Client, daemonUrl } from "../client.ts";
import { emitError, emitOk } from "../output.ts";

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

export default defineCommand({
  meta: { name: "rm", description: "remove a task (and its updates, via cascade)" },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "task id",
    },
    force: {
      type: "boolean",
      alias: "f",
      default: false,
      description: "skip the y/N confirmation prompt",
    },
    json: {
      type: "boolean",
      default: false,
      description: "emit { ok, id } as JSON instead of the human line",
    },
  },
  async run({ args }) {
    const json = args.json;
    const id = Number.parseInt(args.id, 10);
    if (!Number.isFinite(id)) {
      emitError(json, new Error("id must be a number"));
    }
    if (!args.force) {
      // --json callers can't answer an interactive prompt; requiring --force
      // keeps stdout clean and never hangs. Human (non-json) callers still get
      // the y/N prompt: piped stdin answers it, and EOF aborts safely.
      if (json) {
        emitError(json, new Error(`refusing to prompt in --json mode; pass --force to delete task ${id}`));
      }
      const answer = await prompt(`delete task ${id}? [y/N] `);
      if (answer.trim().toLowerCase() !== "y") {
        console.log("aborted");
        return;
      }
    }
    const url = daemonUrl();
    if (url) {
      try {
        await Client.removeTask(url, id);
        emitOk(json, { ok: true, id }, `✓ removed task ${id}`);
        return;
      } catch (err) {
        emitError(json, err);
      }
    }
    const store = Store.open();
    try {
      store.removeTask(id);
      emitOk(json, { ok: true, id }, `✓ removed task ${id}`);
    } catch (err) {
      emitError(json, err);
    } finally {
      store.close();
    }
  },
});

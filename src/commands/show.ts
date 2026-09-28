import { defineCommand } from "citty";
import { HttpError } from "../api.ts";
import type { CortexClient } from "../contracts.ts";
import { withClient } from "../daemon.ts";
import type { Task, Update } from "../store.ts";

/**
 * Render the formatted `cortex show` text view for one task and its
 * updates. Exported so `cortex search` can print the selected task
 * byte-for-byte identical to `cortex show <id>` — keep the two commands
 * in lockstep by construction, not by convention.
 */
export function renderTaskView(task: Task, updates: Update[]): string {
  const lines: string[] = [];
  lines.push(`[${task.id}] ${task.title}`);
  lines.push(`  lane:     ${task.lane}`);
  lines.push(`  status:   ${task.status}`);
  if (task.priority !== null) lines.push(`  priority: ${task.priority}`);
  // Tags line: full alphabetical list (no truncation in `show` since the
  // user explicitly asked for the details of one task). Skipped entirely
  // when the task has no tags.
  if (task.tags && task.tags.length > 0) {
    lines.push(`  tags:     ${task.tags.map(n => `#${n}`).join(" ")}`);
  }
  lines.push(`  created:  ${new Date(task.created).toISOString()}`);
  lines.push(`  updated:  ${new Date(task.updated).toISOString()}`);
  if (task.body) {
    lines.push("", task.body);
  }
  if (updates.length > 0) {
    lines.push("", "updates:");
    for (const u of updates) {
      const ts = new Date(u.created).toISOString();
      lines.push(`  [${u.severity}] ${ts} ${u.author}: ${u.summary}`);
      if (u.body) {
        for (const line of u.body.split("\n")) {
          lines.push(`    ${line}`);
        }
      }
    }
  }
  return lines.join("\n");
}

export default defineCommand({
  meta: { name: "show", description: "show a task and its updates" },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "task id",
    },
    json: {
      type: "boolean",
      default: false,
      description: "emit raw JSON instead of the formatted view",
    },
  },
  async run({ args }) {
    const id = Number.parseInt(args.id, 10);
    if (!Number.isFinite(id)) {
      console.error("error: id must be a number");
      process.exit(1);
    }
    const found = await readTaskOrExit(id);
    if (args.json) {
      console.log(JSON.stringify(found));
      return;
    }
    console.log(renderTaskView(found.task, found.updates));
  },
});

/** One task and its updates, from ONE read (GET /api/tasks/:id/state), or null when it does not exist. */
export async function readTask(client: CortexClient, id: number): Promise<{ task: Task; updates: Update[] } | null> {
  try {
    const { task, updates } = await client.taskState(id);
    return { task, updates };
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

/**
 * readTask through withClient (the verified daemon, or offline under the
 * ownership lease), printing `task <id> not found` (no `error:` prefix, the
 * historical show/search/resume wording) or `error: <message>` and exiting 1
 * when there is nothing to show.
 */
export async function readTaskOrExit(id: number): Promise<{ task: Task; updates: Update[] }> {
  let found: { task: Task; updates: Update[] } | null;
  try {
    found = await withClient(client => readTask(client, id));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
  if (found === null) {
    console.error(`task ${id} not found`);
    process.exit(1);
  }
  return found;
}

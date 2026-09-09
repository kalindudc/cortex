import { defineCommand } from "citty";
import { Store, type Task, type Update } from "../store.ts";

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
  run({ args }) {
    const id = Number.parseInt(args.id, 10);
    if (!Number.isFinite(id)) {
      console.error("error: id must be a number");
      process.exit(1);
    }
    const store = Store.open();
    try {
      const task = store.getTask(id);
      if (!task) {
        console.error(`task ${id} not found`);
        process.exit(1);
      }
      const updates = store.listUpdates(id);
      if (args.json) {
        console.log(JSON.stringify({ task, updates }));
        return;
      }
      console.log(renderTaskView(task, updates));
    } finally {
      store.close();
    }
  },
});

import { defineCommand } from "citty";
import { withClient } from "../daemon.ts";
import { validateTagName, type TaskStatus, type Task } from "../store.ts";

const STATUSES: TaskStatus[] = ["draft", "open", "review", "blocked", "done"];

// Max tags to print inline per task in the `cortex ls` text view. Beyond
// this we render `+N` to keep rows scannable. Picked by visual budget: 3
// short tags fit comfortably in a typical 100-col terminal alongside the
// task title. Bump if your titles are short and you want to see more.
const LS_TAG_LIMIT = 3;

/** Render a task's tag list for the `cortex ls` text view: first N as
 *  `#name`, then `+M` if more remain. Returns "" when the list is empty so
 *  the caller can string-concat without conditional spaces. ANSI gray is
 *  applied at call time via the `c()` helper, not here — keep this pure for
 *  testability. */
export function renderTagsTruncated(tags: string[]): string {
  if (!tags || tags.length === 0) return "";
  const head = tags.slice(0, LS_TAG_LIMIT).map(n => `#${n}`);
  const more = tags.length - LS_TAG_LIMIT;
  if (more > 0) head.push(`+${more}`);
  return ` [${head.join(" ")}]`;
}

const useColor = (): boolean => !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code: string, s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);

export const STATUS_BADGE: Record<TaskStatus, string> = {
  draft: "○",
  open: "○",
  review: "◐",
  blocked: "■",
  done: "✓",
};

export const STATUS_COLOR: Record<TaskStatus, string> = {
  draft: "36",
  open: "37",
  review: "33",
  blocked: "31",
  done: "32",
};

export default defineCommand({
  meta: { name: "ls", description: "list tasks (grouped by lane, sorted by id)" },
  args: {
    lane: {
      type: "string",
      alias: "l",
      valueHint: "name",
      description: "only show tasks in this lane",
    },
    status: {
      type: "string",
      alias: "s",
      valueHint: "draft|open|review|blocked|done",
      description: `only show tasks with this status (one of: ${STATUSES.join(", ")})`,
    },
    json: {
      type: "boolean",
      default: false,
      description: "emit raw JSON instead of the grouped text view",
    },
    tags: {
      type: "string",
      alias: "t",
      valueHint: "a,b,c",
      description: "filter to tasks that carry every listed tag (AND)",
    },
    search: {
      type: "string",
      alias: "q",
      valueHint: "text",
      description: "search task titles and bodies. @text searches titles only, #text searches tags",
    },
    full: {
      type: "boolean",
      default: false,
      description: "with --json, include task bodies (default omits them for scannable, token-efficient output)",
    },
  },
  async run({ args }) {
    if (args.status && !STATUSES.includes(args.status as TaskStatus)) {
      console.error(`error: status must be one of ${STATUSES.join(",")}`);
      process.exit(1);
    }
    let tagFilter: string[] | undefined;
    if (args.tags) {
      try {
        tagFilter = args.tags
          .split(",")
          .map(s => s.trim())
          .filter(Boolean)
          .map(n => validateTagName(n));
      } catch (e) {
        console.error(`error: ${(e as Error).message}`);
        process.exit(1);
      }
      if (tagFilter.length === 0) tagFilter = undefined;
    }
    const formatTagsForLs = (tags: string[]): string => {
      const raw = renderTagsTruncated(tags);
      return raw ? c("90", raw) : "";
    };
    // The filters travel as GET /api/tasks query parameters (the server
    // applies the same @title / #tag / substring search grammar and the AND
    // tag filter through Store.listTasks), to the verified daemon or, without
    // one, the same handler in-process. The human view also needs per-task
    // update counts, read in the same call.
    let rows: Task[];
    const updateCounts = new Map<number, number>();
    try {
      rows = await withClient(async client => {
        const listed = await client.tasks({
          lane: args.lane || undefined,
          status: (args.status as TaskStatus) || undefined,
          search: args.search || undefined,
          tags: tagFilter,
        });
        if (!args.json) {
          for (const t of listed) updateCounts.set(t.id, (await client.updates(t.id)).length);
        }
        return listed;
      });
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
    // `cortex ls` sorts by task id (ascending) by default — stable and
    // scannable when ids are the primary handle for agent handoffs. The
    // priority ORDER BY inside Store.listTasks is untouched so the
    // server/UI keep their priority-first ordering; only the CLI re-sorts.
    rows.sort((a, b) => a.id - b.id);
    if (args.json) {
      // List views are for scanning: omit the (potentially large) body by
      // default so an agent can enumerate tasks without spending its context
      // budget on full prose. `--full` includes bodies; read one body with
      // `cortex show <id> --json`.
      const out = args.full
        ? rows
        : rows.map(t => ({
            id: t.id,
            lane: t.lane,
            title: t.title,
            status: t.status,
            priority: t.priority,
            created: t.created,
            updated: t.updated,
            tags: t.tags,
          }));
      console.log(JSON.stringify(out));
      return;
    }
    const byLane = new Map<string, Task[]>();
    for (const t of rows) {
      const list = byLane.get(t.lane) ?? [];
      list.push(t);
      byLane.set(t.lane, list);
    }
    if (byLane.size === 0) {
      console.log("(no tasks)");
      return;
    }
    for (const [lane, tasks] of byLane) {
      console.log(c("1", `\n${lane}`));
      for (const t of tasks) {
        const updates = updateCounts.get(t.id) ?? 0;
        const badge = c(STATUS_COLOR[t.status], STATUS_BADGE[t.status]);
        const idStr = c("90", `[${t.id}]`);
        const updStr = updates > 0 ? c("90", ` (${updates} updates)`) : "";
        // Tag chips appear after the title in gray, truncated to keep the
        // line scannable. With many-tag tasks, showing every tag dominated
        // the row and pushed the updates count off-screen. Show first
        // LS_TAG_LIMIT tags then '+N' for the rest. Use `cortex show <id>`
        // for the full list.
        const tagStr = formatTagsForLs(t.tags);
        console.log(`  ${idStr} ${badge} ${t.title}${tagStr}${updStr}`);
      }
    }
  },
});

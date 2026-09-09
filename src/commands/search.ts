import { defineCommand } from "citty";
import { Store, type Task } from "../store.ts";
import { searchTasks } from "../ui/lib/fuzzy.ts";
import { renderTagsTruncated, STATUS_BADGE, STATUS_COLOR } from "./ls.ts";
import { renderTaskView } from "./show.ts";

// cortex search — interactive fuzzy task finder.
//
// Ranks tasks with the SAME scorer as the dashboard command palette
// (src/ui/lib/fuzzy.ts) so `@123` (exact id), `@text` (title-only) and
// `#tag` (tag) prefixes behave identically in both surfaces, then hands the
// ranked list to fzf for further interactive narrowing. Selecting a row
// copies the task id to the system clipboard and prints the task exactly
// like `cortex show <id>` (shared renderTaskView). `--json` skips fzf and
// emits the ranked matches — the scriptable/CI-friendly path.

/**
 * Rank tasks for the search picker. Empty/blank query returns every task
 * sorted by id (matching the `cortex ls` default) so bare `cortex search`
 * is a browse-everything picker; otherwise defer to the UI fuzzy scorer's
 * relevance order.
 */
export function rankTasks(tasks: Task[], text: string): Task[] {
  const q = text.trim();
  if (!q) return [...tasks].sort((a, b) => a.id - b.id);
  return searchTasks(tasks, q).map(r => r.task);
}

/**
 * One fzf input line per task: `<id>\t<display>`. Field 1 is the bare id —
 * fzf's `--delimiter=\t` makes it addressable as `{1}` in the preview
 * command and trivially parseable from the accepted line. The display field
 * mirrors a `cortex ls` row (id, status badge, title, truncated tags) plus
 * the lane, colorized for `--ansi` unless the caller disables it.
 */
export function formatSearchLine(task: Task, colorize: boolean): string {
  const c = (code: string, s: string) => (colorize ? `\x1b[${code}m${s}\x1b[0m` : s);
  const badge = c(STATUS_COLOR[task.status], STATUS_BADGE[task.status]);
  const idStr = c("90", `[${task.id}]`);
  const rawTags = renderTagsTruncated(task.tags);
  const tagStr = rawTags ? c("90", rawTags) : "";
  const laneStr = c("36", ` (${task.lane})`);
  return `${task.id}\t${idStr} ${badge} ${task.title}${tagStr}${laneStr}`;
}

/** Recover the task id from an fzf-accepted line (field 1, see above). */
export function parseSelectedId(line: string): number | null {
  const id = Number.parseInt(line.split("\t")[0] ?? "", 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Argv prefix that re-invokes THIS cortex for the fzf preview. Same probe
 * as commands/serve.ts: in a `bun build --compile` binary argv[1] is the
 * embedded virtual path (/$bunfs/…) and process.execPath IS the cortex
 * binary; from source (`bun index.ts`) execPath is bun itself, so the
 * entry script must be carried along.
 */
function selfCommand(): string[] {
  return process.argv[1]?.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, process.argv[1]];
}

/** POSIX single-quote for embedding a path in the fzf preview command. */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Platform-ordered clipboard writer candidates (first hit on PATH wins). */
function clipboardCommands(): string[][] {
  if (process.platform === "darwin") return [["pbcopy"]];
  if (process.platform === "win32") return [["clip"]];
  return [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
}

async function copyToClipboard(text: string): Promise<boolean> {
  for (const cmd of clipboardCommands()) {
    if (!Bun.which(cmd[0])) continue;
    const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(text);
    await proc.stdin.end();
    if ((await proc.exited) === 0) return true;
  }
  return false;
}

export default defineCommand({
  meta: {
    name: "search",
    description: "fuzzy-search tasks in an fzf picker (enter copies the task id and prints the task)",
  },
  args: {
    text: {
      type: "positional",
      required: false,
      description: "fuzzy query — @123 jumps to an id, @text searches titles only, #text searches tags",
    },
    json: {
      type: "boolean",
      default: false,
      description: "emit the ranked matches as JSON instead of opening fzf",
    },
  },
  async run({ args }) {
    const store = Store.open();
    let tasks: Task[];
    try {
      tasks = store.listTasks({});
    } finally {
      // Close before the (potentially long) interactive fzf session; the
      // selected task is re-read afterwards with a fresh handle.
      store.close();
    }

    const query = args.text ?? "";
    const ranked = rankTasks(tasks, query);

    if (args.json) {
      console.log(JSON.stringify(ranked));
      return;
    }
    if (ranked.length === 0) {
      console.error("(no matching tasks)");
      process.exit(1);
    }
    if (!Bun.which("fzf")) {
      console.error("error: `cortex search` requires fzf on PATH — https://github.com/junegunn/fzf");
      process.exit(1);
    }

    const colorize = !process.env.NO_COLOR;
    const lines = ranked.map(t => formatSearchLine(t, colorize));
    const preview = `${selfCommand().map(shQuote).join(" ")} show {1}`;
    const header = query.trim()
      ? `filter: ${query.trim()} · enter: copy task id to clipboard`
      : "enter: copy task id to clipboard";

    const fzf = Bun.spawn(
      [
        "fzf",
        "--ansi",
        "--delimiter=\t",
        "--with-nth=2..",
        "--no-multi",
        // Ties in fzf's own match score fall back to our relevance order.
        "--tiebreak=index",
        "--prompt=search> ",
        `--header=${header}`,
        `--preview=${preview}`,
        "--preview-window=right:60%:wrap",
      ],
      // fzf draws its UI on /dev/tty, so piping stdout only captures the
      // accepted line; stderr is inherited for fzf's own error reporting.
      { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
    );
    fzf.stdin.write(lines.join("\n"));
    await fzf.stdin.end();
    const out = await new Response(fzf.stdout).text();
    const code = await fzf.exited;
    // Propagate fzf's exit code (1 = no match, 130 = cancelled) so shell
    // chains like `cortex search x && …` don't run after a cancel.
    if (code !== 0) process.exit(code);

    const id = parseSelectedId(out.trimEnd());
    if (id === null) {
      console.error("error: could not parse a task id from the fzf selection");
      process.exit(1);
    }

    const reread = Store.open();
    try {
      const task = reread.getTask(id);
      if (!task) {
        console.error(`task ${id} not found`);
        process.exit(1);
      }
      console.log(renderTaskView(task, reread.listUpdates(id)));
    } finally {
      reread.close();
    }

    // Clipboard last, and its status goes to stderr — stdout stays
    // byte-identical to `cortex show <id>` for piping.
    if (await copyToClipboard(String(id))) {
      console.error(`\ncopied task id ${id} to clipboard`);
    } else {
      console.error(`\nwarning: no clipboard tool found — task id is ${id}`);
    }
  },
});

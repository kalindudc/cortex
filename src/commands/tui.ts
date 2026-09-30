import { isatty } from "node:tty";
import { defineCommand } from "citty";
import type { RunTuiOptions } from "../tui/app.ts";

// `cortex tui [id] [--heading slug] [--profile name] [--theme name]` (plan
// @400 N5), and plain `cortex` on an interactive terminal. Every argument and
// the terminal itself are checked BEFORE the alternate screen, so a mistake
// prints one line and exits non-zero on the normal screen. This module stays
// light on purpose (src/cli.ts imports entryArgs for every command): the
// terminal runtime and its validators load only when the TUI actually runs.

/**
 * The argv citty runs: `["tui"]` for plain `cortex` on an interactive
 * terminal, otherwise `argv` unchanged (no-TTY usage/exit code, --help,
 * --version and every command). `interactive` is consulted only when argv is
 * empty, so ordinary commands never inspect the terminal.
 */
export function entryArgs(argv: readonly string[], interactive: () => boolean): string[] {
  return argv.length === 0 && interactive() ? ["tui"] : [...argv];
}

export type TuiArgCheck = { ok: true; options: RunTuiOptions } | { ok: false; message: string };

/** The terminal the TUI would take over. */
export interface TuiTerminal {
  stdin: boolean;
  stdout: boolean;
  term: string | undefined;
}

// Heading anchors are slugified ASCII ids (src/lib/slug.ts): the reader resolves them (src/tui/reader.ts)
// as a bare slug (`plan`, `plan-2`) or the full `task-<id>-plan`.
const HEADING_SLUG = /^[a-z0-9-]{1,256}$/i;

const CLI_GUIDANCE = "use the CLI instead (cortex ls, cortex show <id>, cortex --help)";

/** Validate `cortex tui`'s arguments, then the terminal; the first problem wins. */
export async function checkTuiArgs(
  args: { id?: unknown; heading?: unknown; profile?: unknown; theme?: unknown },
  terminal: TuiTerminal,
): Promise<TuiArgCheck> {
  const fail = (message: string): TuiArgCheck => ({ ok: false, message });
  const options: RunTuiOptions = {};

  if (args.id !== undefined) {
    const raw = String(args.id);
    const id = /^@?\d+$/.test(raw) ? Number(raw.replace(/^@/, "")) : Number.NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
      return fail(`invalid task id ${JSON.stringify(raw)}: expected a positive integer such as 42`);
    }
    options.taskId = id;
  }

  if (args.heading !== undefined) {
    if (options.taskId === undefined) return fail("--heading needs a task id: cortex tui <id> --heading <slug>");
    // A web URL's fragment (`#task-42-plan`) works as written.
    const heading = typeof args.heading === "string" ? args.heading.replace(/^#/, "") : null;
    if (heading === null || !HEADING_SLUG.test(heading)) {
      return fail("--heading must be a heading anchor: letters, digits and '-', for example plan or task-42-plan");
    }
    options.heading = heading;
  }

  const { tuiStatePath, themesDir } = await import("../paths.ts");
  const profile = args.profile === undefined ? "default" : String(args.profile);
  try {
    tuiStatePath(profile);
  } catch (err) {
    return fail(`--profile: ${(err as Error).message}`);
  }
  options.profile = profile;

  if (args.theme !== undefined) {
    const name = String(args.theme);
    const [{ isThemeName }, { BUNDLED_THEME_NAMES, loadCustomTheme }] = await Promise.all([
      import("../tui/config.ts"),
      import("../tui/theme.ts"),
    ]);
    if (!isThemeName(name)) {
      return fail(`--theme ${JSON.stringify(name)}: theme names are lowercase letters, digits, '-' or '_'`);
    }
    if (!(BUNDLED_THEME_NAMES as readonly string[]).includes(name)) {
      const dir = themesDir();
      const loaded = loadCustomTheme(name, dir);
      if (loaded.theme === null) {
        const why = loaded.problems.find(p => p.severity === "error");
        return fail(
          why === undefined
            ? `--theme ${JSON.stringify(name)} not found: it is not bundled (${BUNDLED_THEME_NAMES.join(", ")}) and ${dir}/${name}.toml does not exist`
            : `--theme ${JSON.stringify(name)} is unusable: ${why.keyPath ? `${why.keyPath}: ` : ""}${why.reason} (${why.file})`,
        );
      }
    }
    options.theme = name;
  }

  if (!terminal.stdin || !terminal.stdout) {
    return fail(`cortex tui needs an interactive terminal (stdin and stdout must both be a TTY); ${CLI_GUIDANCE}`);
  }
  if (terminal.term === "dumb") {
    return fail(`TERM=dumb cannot run the terminal UI (it needs cursor control); ${CLI_GUIDANCE}`);
  }
  return { ok: true, options };
}

export default defineCommand({
  meta: {
    name: "tui",
    description:
      "open the terminal workspace for this database (plain `cortex` does too, in an interactive terminal); starts a headless daemon if none runs",
  },
  args: {
    id: {
      type: "positional",
      required: false,
      description: "task id to open",
    },
    heading: {
      type: "string",
      valueHint: "slug",
      description:
        "open at this heading of that task: its slug or web anchor, e.g. plan, plan-2 or task-42-plan (needs an id)",
    },
    profile: {
      type: "string",
      valueHint: "name",
      description: "view-state profile (default: default); settings in tui.toml are shared",
    },
    theme: {
      type: "string",
      valueHint: "name",
      description:
        "theme for this session: cortex-dark, cortex-light, high-contrast-dark, high-contrast-light, ansi or a custom one",
    },
  },
  async run({ args }) {
    const check = await checkTuiArgs(args, { stdin: isatty(0), stdout: isatty(1), term: process.env.TERM });
    if (!check.ok) {
      console.error(`error: ${check.message}`);
      process.exit(1);
    }
    const { runTui } = await import("../tui/app.ts");
    let code: number;
    try {
      code = await runTui(check.options);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
    process.exit(code);
  },
});

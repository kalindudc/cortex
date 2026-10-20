import { isatty } from "node:tty";
import { defineCommand, runMain } from "citty";
import pkg from "../package.json" with { type: "json" };
import { normalizeArgv } from "./args.ts";
import { entryArgs } from "./commands/app.ts";
import { routeConsoleThroughStreams } from "./stdio.ts";

// Before any command prints: Bun 1.4.2's console.log silently truncates at
// 64 KiB on a non-blocking pipe (see src/stdio.ts).
routeConsoleThroughStreams();

// `cortex tui` was removed. For an unknown command citty prints its whole usage, so say why in one line first.
if (process.argv[2] === "tui") {
  console.error("cortex tui was removed: the desktop app replaced the terminal workspace (run `cortex app`)");
  process.exit(1);
}

// Lazy-import registry, shared between citty's subCommands resolution and
// normalizeArgv (which loads only the detected subcommand's module).
const subCommands = {
  init: () => import("./commands/init.ts").then(m => m.default),
  add: () => import("./commands/add.ts").then(m => m.default),
  ls: () => import("./commands/ls.ts").then(m => m.default),
  show: () => import("./commands/show.ts").then(m => m.default),
  search: () => import("./commands/search.ts").then(m => m.default),
  schema: () => import("./commands/schema.ts").then(m => m.default),
  doctor: () => import("./commands/doctor.ts").then(m => m.default),
  update: () => import("./commands/update.ts").then(m => m.default),
  edit: () => import("./commands/edit.ts").then(m => m.default),
  mv: () => import("./commands/mv.ts").then(m => m.default),
  rm: () => import("./commands/rm.ts").then(m => m.default),
  lane: () => import("./commands/lane.ts").then(m => m.default),
  tag: () => import("./commands/tag.ts").then(m => m.default),
  app: () => import("./commands/app.ts").then(m => m.default),
  serve: () => import("./commands/serve.ts").then(m => m.default),
  stop: () => import("./commands/stop.ts").then(m => m.default),
  reset: () => import("./commands/reset.ts").then(m => m.default),
  resume: () => import("./commands/resume.ts").then(m => m.default),
  watch: () => import("./commands/watch.ts").then(m => m.default),
  backup: () => import("./commands/backup.ts").then(m => m.default),
  restore: () => import("./commands/restore.ts").then(m => m.default),
  memory: () => import("./commands/memory.ts").then(m => m.default),
  agents: () => import("./commands/agents.ts").then(m => m.default),
};

const main = defineCommand({
  meta: {
    name: "cortex",
    version: pkg.version,
    description: "personal task tracker for parallel-agent supervision",
  },
  subCommands,
});

// Plain `cortex` on an interactive terminal (stdin AND stdout) opens the
// desktop app; everything else, including no arguments without a TTY,
// --help and --version, runs exactly as before. Then citty 0.1.x never
// consumes a dash-leading token as a string flag's value (see src/args.ts):
// rewrite `--flag -value` into `--flag=-value` first so anchors like
// `--body-search "- item"` parse as values, not flags.
runMain(main, {
  rawArgs: await normalizeArgv(
    entryArgs(process.argv.slice(2), () => isatty(0) && isatty(1)),
    subCommands,
  ),
});

import { defineCommand, runMain } from "citty";
import pkg from "../package.json" with { type: "json" };
import { normalizeArgv } from "./args.ts";

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
  serve: () => import("./commands/serve.ts").then(m => m.default),
  open: () => import("./commands/open.ts").then(m => m.default),
  stop: () => import("./commands/stop.ts").then(m => m.default),
  reset: () => import("./commands/reset.ts").then(m => m.default),
  resume: () => import("./commands/resume.ts").then(m => m.default),
  backup: () => import("./commands/backup.ts").then(m => m.default),
  restore: () => import("./commands/restore.ts").then(m => m.default),
};

const main = defineCommand({
  meta: {
    name: "cortex",
    version: pkg.version,
    description: "personal task tracker for parallel-agent supervision",
  },
  subCommands,
});

// citty 0.1.x never consumes a dash-leading token as a string flag's value
// (see src/args.ts); rewrite `--flag -value` into `--flag=-value` first so
// anchors like `--body-search "- item"` parse as values, not flags.
runMain(main, { rawArgs: await normalizeArgv(process.argv.slice(2), subCommands) });

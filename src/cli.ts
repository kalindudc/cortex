import { defineCommand, runMain } from "citty";
import pkg from "../package.json" with { type: "json" };

const main = defineCommand({
  meta: {
    name: "cortex",
    version: pkg.version,
    description: "personal task tracker for parallel-agent supervision",
  },
  subCommands: {
    init: () => import("./commands/init.ts").then(m => m.default),
    add: () => import("./commands/add.ts").then(m => m.default),
    ls: () => import("./commands/ls.ts").then(m => m.default),
    show: () => import("./commands/show.ts").then(m => m.default),
    search: () => import("./commands/search.ts").then(m => m.default),
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
  },
});

runMain(main);

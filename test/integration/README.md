# Integration tests (`test/integration/`)

End-to-end tests that exercise built artifacts: the `bin/cortex` binary,
the in-process Hono server bound to a real TCP port, and the full
embedded UI bundle.

Run: `pnpm run test:integration` (or `pnpm test` for the full unit + integration suite).

## Layout

```
test/integration/
├── helpers.ts                  ← runCli, mkTmpEnv, BIN constant
├── concurrency.test.ts         ← startServer + 8 parallel POSTs
├── isolation.test.ts           ← Plan-15 hermetic-env canary (snapshots ~/.config/cortex)
├── ui-bundle.test.ts           ← /, /bundle.js, /bundle.css, /api/me + src/ui/** lint guards
└── cli/
    ├── author.test.ts          ← --as flag (CLI integration half of validateAuthorTag)
    ├── body-file.test.ts       ← add/edit --body-file flag (CLI integration half of skills)
    ├── init.test.ts            ← init idempotency, skills + extensions on disk
    ├── lane.test.ts            ← lane add/ls/edit/rm
    ├── resume.test.ts          ← resume input validation + dispatch arms
    ├── rm.test.ts              ← rm prompt arms (y/n/Y/empty/--force/bad id)
    ├── serve-stop.test.ts      ← serve daemon shutdown via SIGTERM (skip-if-present for `cortex stop`)
    ├── tag.test.ts             ← tag add/ls/edit
    └── update.test.ts          ← audit-trail status rows (-s flag)
```

The legacy `test/integration/cli.test.ts` covers the round-trip
(`init → add → ls → update → edit → mv → rm`) and the
add/edit/ls/show/rm command surfaces inline. New per-command files only
exist where they add coverage that the round-trip does not.

## Conventions

- EVERY test that spawns the CLI binary MUST go through `runCli({args, env})`
  from `helpers.ts`. The helper handles env scrubbing
  (`mkTmpEnv` deletes inherited `XDG_CONFIG_HOME`, `CORTEX_DB`,
  `CORTEX_SKILL_DIR` before re-setting them to tmp paths) and stdin piping.
- ALL spawn invocations (including direct `Bun.spawn(...)` for cases that
  need to hold the process handle, e.g. `cli/serve-stop.test.ts`) MUST
  receive the scrubbed env from `mkTmpEnv()`. NEVER inherit parent env.
- The binary path is `path.join(REPO_ROOT, "bin/cortex")` and resolves via
  `helpers.ts`'s `BIN` constant. `pnpm test` and `pnpm run test:integration`
  build it first; running raw `bun test` requires `pnpm run build` first
  (helpers.ts throws an actionable error if `bin/cortex` is missing).

## When a test needs a running daemon

Two patterns exist:

1. In-process (preferred for testing server routes only):

   ```ts
   import { Store } from "../../src/store.ts";
   import { startServer } from "../../src/server.ts";
   const store = Store.open(":memory:");
   const handle = startServer({ port: 0, store });
   // ... use handle.url ...
   await handle.stop();
   store.close();
   ```

   Used by `concurrency.test.ts` and `ui-bundle.test.ts`.

2. Spawned daemon (when the test must validate the daemon-detect arm of
   write commands or the serve/stop lifecycle):

   - Spawn `BIN serve --foreground --port 0 --no-open` via `Bun.spawn(...)`
     with the hermetic env from `mkTmpEnv()`.
   - Poll for `<tmpDir>/cortex/cortex.{pid,url}` to appear (signal that
     `startServer()` bound and the SIGTERM handler is wired).
   - On teardown, SIGTERM the daemon directly (NOT via `cortex stop`,
     which uses host-wide `pgrep -f 'cortex serve'` and would race with
     the developer's real daemon — see `cli/serve-stop.test.ts` header
     for the full rationale). `afterAll` MUST also SIGKILL as a
     safety-net so a test crash never leaves a daemon running on the
     developer's machine.

## Hermetic isolation rules

The integration suite MUST be safe to run on a developer machine with a
live `cortex serve` daemon and real production tasks. Three rules, no
exceptions:

1. EVERY test that touches the filesystem or starts an HTTP server goes
   through `mkTmpEnv()` (or the equivalent env-pinning pattern that
   DELETES inherited `XDG_CONFIG_HOME` / `CORTEX_DB` /
   `CORTEX_SKILL_DIR` before re-setting them).
2. EVERY child process (`runCli`, `Bun.spawn`, or `startServer` running
   in a forked daemon mode) receives the scrubbed env, never the parent
   env.
3. Tests that mutate `process.env` directly (e.g. fake pidfile writes)
   set the env BEFORE calling the function under test AND restore via
   `try/finally` AND ONLY ever point at a `fs.mkdtempSync()` directory
   — never at the live `homedir()`.

`test/unit/_layout.test.ts` enforces these rules via static text-scan +
mtime+size snapshots of `~/.config/cortex/cortex.{db,pid,url}`.
`test/integration/isolation.test.ts` does the runtime canary check on
the CLI helpers themselves.

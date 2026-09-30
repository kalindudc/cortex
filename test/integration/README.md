# Integration tests (`test/integration/`)

End-to-end tests that exercise built artifacts: the `bin/cortex` binary and
the in-process Hono server bound to a real TCP port.

Run: `pnpm run test:integration` (or `pnpm test` for the full unit + integration suite).

## Layout

```
test/integration/
├── helpers.ts                  ← runCli, mkTmpEnv, BIN constant
├── concurrency.test.ts         ← startServer + 8 parallel POSTs
├── isolation.test.ts           ← Plan-15 hermetic-env canary (snapshots ~/.config/cortex)
├── ownership.test.ts           ← multi-process database ownership (one owner per canonical DB)
├── related.test.ts             ← GET /api/tasks/:id/related over real HTTP
├── tui.test.ts                 ← the TUI in a real PTY: render, resize, modes, :q guards, signals, suspend, termios restore
├── tui-concurrency.test.ts     ← three TUIs + CLI writers on one daemon: convergence, conflicts, dedupe, restart
├── tui-safety.test.ts          ← hostile ESC/C0/C1/OSC/DCS/APC text in every TUI surface; OSC 52/8 rules; Unicode width
├── fixtures/daemon.ts          ← spawned daemons: startForeground, reap() of every process it started
├── fixtures/ownership-holder.ts ← a separate ownership contender process for ownership.test.ts
├── fixtures/pty.ts             ← Bun.Terminal harness: continuous drain, bounded waits, parent-side termios
└── cli/
    ├── author.test.ts          ← --as flag (CLI integration half of validateAuthorTag)
    ├── backup-restore.test.ts  ← backup/restore; live-daemon warning/refusal; read-only dry-runs
    ├── body-file.test.ts       ← add/edit --body-file flag (CLI integration half of skills)
    ├── daemon-routing.test.ts  ← withClient: scoped offline leases, daemon routing + SSE, legacy fence, doctor, prompts, reset
    ├── init.test.ts            ← init idempotency, skills + extensions on disk
    ├── lane.test.ts            ← lane add/ls/edit/rm
    ├── resume.test.ts          ← resume input validation + dispatch arms
    ├── rm.test.ts              ← rm prompt arms (y/n/Y/empty/--force/bad id)
    ├── serve-stop.test.ts      ← database-scoped serve/stop: metadata, instance-bound stop, legacy fence
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
  (`mkTmpEnv` deletes inherited `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`,
  `CORTEX_DB`, `CORTEX_SKILL_DIR`, `CORTEX_PI_EXTENSION_DIR` before
  re-setting them to tmp paths) and stdin piping.
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

   Used by `concurrency.test.ts` and `related.test.ts`.

2. Spawned daemon (when the test must validate the daemon-detect arm of
   write commands or the serve/stop lifecycle): use `fixtures/daemon.ts`.

   - `startForeground(env, args)` spawns `BIN serve --foreground`
     with the hermetic env from `mkTmpEnv()` and resolves once the daemon
     printed its success line, which it does only after publishing
     `<db>.daemon.json` (its identity: socket endpoint, instance, pid).
   - Stop it by SIGTERM to that spawned process, or with `cortex stop` in
     the same env: stop is instance-bound (it discovers THIS database's
     daemon through its metadata and uses the IPC-only shutdown route), so
     it never touches another database's daemon or a developer's live
     `cortex serve`. `reap()` in `afterEach`/`afterAll` SIGKILLs every
     process the fixture spawned, so a test crash never leaves a daemon
     running on the developer's machine.

## Terminal (PTY) suites

`tui.test.ts` and `tui-concurrency.test.ts` run the COMPILED `bin/cortex tui`
in real pseudo-terminals through `fixtures/pty.ts`
(`Bun.spawn(argv, { terminal })`; no python3):

- `spawnPty(argv, { env, cols, rows, replies })` drains the child's output
  CONTINUOUSLY through the terminal's `data` callback. A harness that stops
  reading blocks the app and delivers `Esc` and the next key merged into one
  Alt pair. `replies` answers terminal queries (for example a DSR 996
  appearance report) each time the child sends them.
- `expect(pattern, { from, timeoutMs })` waits for output after a `mark()`;
  every wait is bounded and fails with the output tail.
- `localFlags()` reads termios from the PARENT after the child exits (the
  PTY keeps the child's last settings), so restoration (`isCooked`) is
  checked from outside; a SIGKILLed child leaves raw flags behind, which is
  the negative control proving the check can fail.
- `reapPtys()` in `afterEach`/`afterAll` SIGKILLs only PTY children this
  module spawned.

`tui-concurrency.test.ts` uses ONE `mkTmpEnv()` sandbox for the whole file:
three sessions share the headless daemon the first one starts, while the CLI
writes as a fourth client. Its tests run in order and build on each other:
independent writes, a stale same-field write (conflict), post dedupe, shared
notification read state, blocked attention, a daemon stop and restart (then
an idle window longer than Bun's 10 s idle timeout: no spurious reconnect), a
slow subscriber and closing one session. `afterAll` stops the sandbox's
daemon with `cortex stop` in the SAME env (instance-bound).

`tui-safety.test.ts` (G5) seeds terminal control sequences into every
untrusted field the CLI accepts (title, Markdown body, lane name and color,
tag color, update summary/body/author) and pastes more into the prompt, the
search and the composer, walks every surface that shows them, then scans the
WHOLE raw PTY output: OSC/DCS/APC/PM/SOS must be the TUI's own (OSC 8 only
around the one safe URL, OSC 52 only after the explicit `:copy`), no C1, DEL
or stray C0 may appear, and each seeded control carries a unique marker so a
raw CSI is told apart from the TUI's own. Its positive control splices every
payload raw into the captured stream and requires the scan to report it. The
width test rebuilds the screen from pi-tui's row writes and checks CJK/emoji
rows against the terminal width (Bun.stringWidth) and the pane divider and
table borders for alignment. The TUI env drops terminal-identity variables
(`TERM_PROGRAM`, `KITTY_WINDOW_ID`, ...) so the stream is the same everywhere.

## Hermetic isolation rules

The integration suite MUST be safe to run on a developer machine with a
live `cortex serve` daemon and real production tasks. Three rules, no
exceptions:

1. EVERY test that touches the filesystem or starts an HTTP server goes
   through `mkTmpEnv()` (or the equivalent env-pinning pattern that
   DELETES inherited `XDG_CONFIG_HOME` / `XDG_RUNTIME_DIR` / `CORTEX_DB` /
   `CORTEX_SKILL_DIR` / `CORTEX_PI_EXTENSION_DIR` before re-setting them).
2. EVERY child process (`runCli`, `Bun.spawn`, or `startServer` running
   in a forked daemon mode) receives the scrubbed env, never the parent
   env.
3. Tests that mutate `process.env` directly (e.g. pinning `CORTEX_DB`)
   set the env BEFORE calling the function under test AND restore via
   `try/finally` AND ONLY ever point at a `fs.mkdtempSync()` directory
   — never at the live `homedir()`.

`test/unit/_layout.test.ts` enforces these rules via static text-scan +
mtime+size snapshots of `~/.config/cortex/cortex.{db,pid,url}`.
`test/integration/isolation.test.ts` does the runtime canary check on
the CLI helpers themselves.

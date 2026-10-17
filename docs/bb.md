---
budget: 120
sources: [integrations/bb/server.ts, integrations/bb/state.ts, integrations/bb/watch.ts, integrations/bb/app.tsx,
  integrations/bb/cli.ts, integrations/bb/detail.ts, integrations/bb/panel/, src/commands/agents.ts,
  src/commands/update.ts, src/bbPlugin.ts, src/bbPluginSource.ts]
---
# Cortex in bb

bb is an IDE that runs coding agents in threads. The Cortex bb plugin shows each thread's current task beside the
conversation, and gives every thread Cortex memory and updates credited to that thread, whatever agent provider it
runs on. This page covers installing it and what it does, then how it is built and the rules that keep it safe.

## Install

`cortex agents install` installs the plugin when bb is installed and running: it writes the plugin's source, which
ships inside the cortex binary, to `~/.config/cortex/bb-plugin`, installs its dependencies there with npm, and
registers it with bb. Run it again after upgrading cortex; it changes only what differs. `cortex agents reset` removes
the plugin from bb first, which also replaces one installed another way and resets its settings.

The plugin has one setting, `cortexPath`. Left empty, it finds `cortex` on your `PATH`, then in `~/bin` and
`~/.local/bin`. Settings are read when the plugin loads, so after `bb plugin config cortex set cortexPath <path>`
run `bb plugin reload cortex`. When cortex is missing or too old, the plugin reports that it needs configuration,
says how to fix it, and offers no tools; the tab and the chip show the same reason.

## What each provider gets

- Pi threads keep the Cortex pi extension (from `cortex agents install`) exactly as it is. The plugin adds no tools
  and no instructions to them; they still get the tab, the chip and the cards.
- Threads on other providers, such as Codex or Claude Code, get `cortex_update` and `cortex_recall` with the same
  names and arguments as the pi tools. Updates are credited to `bb-<thread id>`, the same author the CLI uses inside
  a bb thread. Their instructions also carry short usage notes and the project's memory primer, the summary of
  recent tasks that pi injects (see [docs/memory.md](memory.md#how-do-agents-find-memory)).

bb asks for a thread's tools and instructions when the thread starts and cannot wait for cortex at that moment, so
the plugin keeps one primer per project in a cache, filled when a thread in that project is created or starts a
turn, and on startup for running threads. A thread that starts before its project is cached gets only the usage
notes. Changes reach a provider the next time bb starts its session, never mid-session.

## The Cortex tab and the header chip

Open the tab from the thread's right panel (Cortex) or by clicking the chip in the thread header. Its switcher lists
the tasks this thread posted updates to, whether through `cortex_update` or `cortex update` in its shell, plus any
task you linked by search or id. The focus task is the one you pinned, or else the most active one. The chip names
it as `#<id> · <status>` with its status colour, reads plain `cortex` when the thread has no task, and warns when the
focus task is blocked or stale. Unlinking removes only a link you added: a task the thread posted to stays listed.

The header shows the task's status, its freshness and, for a plan, how many Low-Level Tasks were reported done.
Overview splits the body at its `##` headings and folds a long one to a line per section. Activity is the update
history, newest first, with a line where the body was last synced; an update from another bb thread links to it.

Click the status pill to pick any status, or take the next step in one click, with Undo in the toast that follows.
On Activity you can post a note, optionally changing the status in the same step. Both are recorded as you with
`cortex update --as-me`, exactly like a change in the terminal workspace: credited to you and notifying nobody. The
tab never edits a task's body or title; use the terminal workspace for that. A cortex whose `cortex doctor` names no
`author` predates `--as-me`, so the tab stays read-only and says to update cortex.

An agent can write `::cortex{id="529"}` on its own line in a reply; bb shows it as a card that opens task 529.
Stale means the files the task cites changed after its body was last brought up to date
([docs/memory.md](memory.md#when-is-memory-stale)). The plugin checks this only when the thread's checkout is on the
bb server's machine; otherwise the tab says it was not checked. Changes from any agent, shell or the terminal
workspace appear within moments, and after a reconnect every open tab and chip refetches.

Trying it live changes your bb: `bb plugin dev integrations/bb` rebuilds and reloads on every save. Check behavior
from a new, separate thread, because bb applies tools and instructions only when it starts a provider session.

## Under the hood

The plugin is its own npm package in `integrations/bb/`, with its own lockfile and Vitest tests, so the Git
subdirectory installs on its own. It runs inside the bb server's Node process and reads cortex only by running the
`cortex` CLI, so the rules for tasks, memory and staleness stay in cortex. Packages bb provides at runtime (React,
the SDK, portaling Radix components) are type-only development dependencies; zod and the other UI pieces are bundled.

- The binary embeds the plugin through a Bun macro (`src/bbPluginSource.ts#embeddedBbPlugin`), which reads the files
  as text at bundle time, so the root typecheck never compiles them. Why not install from git, or the checkout? Git
  needs the plugin pushed and installs what the remote holds; a checkout path breaks when its branch changes.
- `./integrations/bb/cli.ts#createCortexRunner` runs each command with `execFile` and an argument array, never a
  shell, with a short timeout (`./integrations/bb/cli.ts#DEFAULT_TIMEOUT_MS`), the caller's abort signal and typed
  `./integrations/bb/cli.ts#CortexCliError` failures. JSON output is validated before use, and an `{ error }`
  envelope fails even on exit 0. `./integrations/bb/cli.ts#verifyCortexFeatures` gates loading on `watch` and
  author streams.
- `./integrations/bb/state.ts#createCortexState` merges `cortex memory streams --author=bb-<thread>` with the manual
  links kept in this plugin's thread metadata, validated field by field on every read. Pin, link and unlink run one
  at a time per thread. A task's `show` and `memory show` are cached briefly
  (`./integrations/bb/state.ts#CACHE_MS`) and shared by every chip and tab, so a change costs one CLI round per task.
- A checkout is local when its environment's host is bb's primary host. Otherwise `memory show` runs in the OS temp
  directory, which is never a checkout, and staleness is reported as unverifiable.
- `cortex memory context --json` returns the lane and the primer in one call. Watch events refresh the primers of
  the affected lane after a short debounce; a removed task, whose lane is unknown, refreshes all of them.
- `./integrations/bb/server.ts#instructionsFor` caps usage plus primer at bb's 4,096-character instruction limit.
  The configure callback is synchronous, so a cache miss never runs the CLI.
- `cortex_recall` returns the text `cortex memory show` or `cortex memory search` prints, as the pi extension does
  (`./integrations/bb/server.ts#recall`). Why not render it from JSON? That would copy cortex's renderer into the
  plugin, where it would drift.
- `./integrations/bb/watch.ts#registerCortexWatch` follows `cortex watch --json` with `spawn`, because `execFile`
  buffers a stream that never ends. `./integrations/bb/watch.ts#routeCortexEvent` drops cached reads before it
  publishes, so a refetch never reads a stale copy.
- The frontend reads data only over the plugin's RPC methods and refetches on the `thread`, `task` and `all`
  realtime signals (`./integrations/bb/state.ts#CortexRealtimeChannel`). A write drops the task's cached reads and
  publishes both signals; the tab applies a status change at once and reverts it if the write fails.
- Plan progress copies the Herdr label's rule (`./integrations/bb/detail.ts#planProgress`); the body splitter
  (`./integrations/bb/panel/sections.ts#splitSections`) ignores `##` lines inside fenced code, as in plan bodies.

## Rules to keep

- The plugin imports only the public bb SDK, zod, Node and its own files, never cortex's source:
  `./integrations/bb/server.test.ts` (public SDK scan).
- Pi threads get no plugin tools, skills or instructions; other providers get both tools, and instructions stay
  within the limit without running the CLI: `./integrations/bb/server.test.ts` (agent configuration).
- Tool failures throw, `cortex_recall` keeps the pi extension's per-request budget, and every tool argument, RPC
  input, metadata value and CLI output is validated: `./integrations/bb/server.test.ts`, `./integrations/bb/cli.test.ts`.
- Staleness is checked only for a checkout on the bb server's own machine: `./integrations/bb/server.test.ts`.
- The tab never edits a task's body or title; its only task writes are status changes and notes through
  `cortex update --as-me`, which never notify, and only when doctor reports `author`:
  `./integrations/bb/server.test.ts` (writes as the user), `test/integration/cli/as-me.test.ts`.
- `cortex agents install` never changes the plugin's settings or touches a plugin bb installed from git or npm, and
  no test runs the real bb or npm (`CORTEX_BB_CLI=""` in every test env): `test/integration/cli/agents-bb.test.ts`,
  `test/integration/isolation.test.ts`.
- `pnpm run test:bb` runs the plugin's tests and typecheck after `npm ci --prefix integrations/bb`; CI does not run
  it yet.

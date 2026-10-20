---
budget: 160
sources: [integrations/bb/server.ts, integrations/bb/state.ts, integrations/bb/watch.ts, integrations/bb/app.tsx,
  integrations/bb/cli.ts, integrations/bb/detail.ts, integrations/bb/memory.ts, integrations/bb/panel/,
  src/commands/agents.ts, src/commands/update.ts, src/bbPlugin.ts, src/bbPluginSource.ts, src/extensions/pi.ts,
  src/extensions/memory-view.ts]
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

The plugin has four settings. The Cortex executable (`cortexPath`), left empty, finds `cortex` on your `PATH`, then in
`~/bin` and `~/.local/bin`; run `bb plugin reload cortex` after changing it. Agent memory is Automatic by default:
threads you start look up and save, and threads started by another thread, such as minions, only look up. The other
choices are Look up and save in every thread, Look up only, and Off; its description says what look up only leaves
out. Two switches hide the memory icon and the header task chip; these three settings apply without a reload. When
cortex is missing or too old, the plugin reports that it needs configuration, says how to fix it, and offers no tools;
the tabs and the chips show the same reason.

## What each provider gets

- Pi threads keep the Cortex pi extension (from `cortex agents install`) exactly as it is. The plugin adds no tools or
  instructions, only the address to report memory to and, for Look up only or Off, the `CORTEX_MEMORY` variable the
  extension already reads. They still get the tabs, the chips and the cards.
- Threads on other providers, such as Codex or Claude Code, get `cortex_update` and `cortex_recall` with the same
  names and arguments as the pi tools. Updates are credited to `bb-<thread id>`, the same author the CLI uses inside
  a bb thread. Their instructions also carry short usage notes and the project's memory primer, the summary of
  recent tasks that pi injects (see [docs/memory.md](memory.md#how-do-agents-find-memory)). Look up only leaves the
  primer out; Off also drops `cortex_recall` and its notes, keeping `cortex_update`.

bb asks for a thread's tools and instructions when the thread starts and cannot wait for cortex at that moment, so
the plugin keeps one primer per project in a cache, filled when a thread in that project is created or starts a
turn, and on startup for running threads. A thread that starts before its project is cached gets only the usage
notes. Changes reach a provider the next time bb starts its session, never mid-session.

## The Cortex tab and the header chip

Open the tab from the thread's right panel (Cortex) or by clicking the chip in the thread header; the chip, a card in
a reply and a Memory stream each switch the thread's one Cortex tab to their task. Its switcher lists the tasks this
thread posted updates to, whether through `cortex_update` or `cortex update` in its shell, plus any task you linked
by search or id. The focus task is the one you pinned, or else the most active one. The chip names it as
`#<id> · <status>` with its status colour, reads plain `cortex` when the thread has no task, and warns when the focus
task is blocked or stale. Unlinking removes only a link you added: a task the thread posted to stays listed.

The header shows the task's status, its freshness and, for a plan, how many Low-Level Tasks were reported done.
Overview splits the body at its `##` headings and folds a long one to a line per section. Activity is the update
history, newest first, with a line where the body was last synced; an update from another bb thread links to it.

Click the status pill to pick any status, or take the next step in one click, with Undo in the toast that follows.
On Activity you can post a note, optionally changing the status in the same step. Both are recorded as you with
`cortex update --as-me`: credited to you, notifying nobody. A cortex whose `cortex doctor` names no `author`
predates `--as-me`, so the tab stays read-only and says to update it. The tab never edits a body or title. The More
menu copies the body and excludes the task from memory or includes it again; the header marks an excluded task.

An agent can write `::cortex{id="529"}` on its own line in a reply; bb shows it as a card that opens task 529.
Stale means the files the task cites changed after its body was last brought up to date
([docs/memory.md](memory.md#when-is-memory-stale)). The plugin checks this only when the thread's checkout is on the
bb server's machine; otherwise the tab says it was not checked. Changes from any agent, shell or the desktop
app appear within moments, and after a reconnect every open tab and chip refetches.

Trying it live changes your bb: `bb plugin dev integrations/bb` rebuilds and reloads on every save. Check behavior
from a new, separate thread, because bb applies tools and instructions only when it starts a provider session.

## Memory in the prompt box and the Memory tab

A brain icon beside the context circle under each thread's prompt box, or in the thread header when that row is not on
screen, shows memory in pi's footer colours: accent once memory is in context, yellow for a stale stream, red after a
failed memory call, pulsing while pi's save turn runs. Hovering it summarises the thread's memory and Cortex task,
with a bar of where the streams in context came from; clicking it opens the Memory tab. The tab shows what pi's
`/memory` shows: health, the streams the thread works on, every stream in context and why, and the session's totals
(for another provider, what the plugin gave and the agent recalled). Each stream opens in the Cortex tab.

The tab's menu sets this thread's memory: follow the setting, Look up and save, Look up only, or Off. A pi thread
applies a change from its next message, when bb rebuilds the pi session and keeps its conversation; another provider
applies it when bb next starts its session. In a pi thread, Re-read memory works like `/memory refresh`. After a
plugin reload the tab waits for the thread's next memory event, and a checkout on another machine may never report.

## Under the hood

The plugin is its own npm package in `integrations/bb/`, with its own lockfile and Vitest tests, so the Git
subdirectory installs on its own. It runs inside the bb server's Node process and reads cortex only by running the
`cortex` CLI, so the rules for tasks, memory and staleness stay in cortex. Packages bb provides at runtime (React,
the SDK, portaling Radix components) are type-only development dependencies; zod and the other UI pieces are bundled.

- The binary embeds the plugin through a Bun macro (`src/bbPluginSource.ts#embeddedBbPlugin`), which reads the files
  as text at bundle time, so the root typecheck never compiles them. Why not install from git, or the checkout? Git
  needs the plugin pushed and installs what the remote holds; a checkout path breaks when its branch changes.
- `./integrations/bb/cli.ts#createCortexRunner` runs each command with `execFile` and an argument array, never a shell,
  with a short timeout (`./integrations/bb/cli.ts#DEFAULT_TIMEOUT_MS`), the caller's abort signal and typed
  `./integrations/bb/cli.ts#CortexCliError` failures. JSON output is validated before use, and an `{ error }` envelope
  fails even on exit 0. `./integrations/bb/cli.ts#verifyCortexFeatures` gates loading on `watch` and author streams.
- `./integrations/bb/state.ts#createCortexState` merges `memory streams --author=bb-<thread> --with-excluded` with
  the manual links kept in this plugin's thread metadata, validated field by field on every read. Pin, link and
  unlink run one at a time per thread. A task's `show` and `memory show` are cached briefly
  (`./integrations/bb/state.ts#CACHE_MS`) and shared by every chip and tab, so a change costs one CLI round per task.
- A checkout is local when its environment's host is bb's primary host. Otherwise `memory show` runs in the OS temp
  directory, which is never a checkout, and staleness is reported as unverifiable.
- `cortex memory context --json` returns the lane and the primer in one call. A watch event refreshes, after a short
  debounce, the primers of the task's lane and any that list the task; a removed task refreshes all of them.
- `./integrations/bb/server.ts#instructionsFor` caps usage plus primer at bb's 4,096-character instruction limit.
  The configure callback is synchronous, so a cache miss never runs the CLI.
- `cortex_recall` returns the text `cortex memory show` or `cortex memory search` prints, as the pi extension does
  (`./integrations/bb/server.ts#recall`). Why not render it from JSON? That copies cortex's renderer, which drifts.
- `./integrations/bb/watch.ts#registerCortexWatch` follows `cortex watch --json` with `spawn`, because `execFile`
  buffers a stream that never ends. `./integrations/bb/watch.ts#routeCortexEvent` drops cached reads before it
  publishes, so a refetch never reads a stale copy.
- The frontend reads data only over the plugin's RPC methods and refetches on the `thread`, `task`, `memory` and `all`
  realtime signals (`./integrations/bb/state.ts#CortexRealtimeChannel`). A write drops the task's cached reads and
  publishes both signals; the tab applies a status change at once and reverts it if the write fails.
- bb ignores a pi extension's footer status, so `src/extensions/pi.ts#reportToBb` posts
  `src/extensions/memory-view.ts#memoryReport` to the plugin's local route: awaited at most once per prompt
  (`src/extensions/pi.ts#BB_REPORT_TIMEOUT_MS`), otherwise only for a changed view, never throwing. Only bb's rpc-mode
  pi reports, since a `pi -p` in the thread's shell inherits its variables; the answer carries the last re-read request.
- `./integrations/bb/memory.ts#effectiveMode` picks the mode (the thread's choice, else the setting), which reaches pi
  as `CORTEX_MEMORY` beside the report address (`./integrations/bb/server.ts#memoryEnv`). Why not answer it in the
  report? A plugin that is down would let a child thread save again. `write` is never sent: the variable is
  process-wide, so pi's `pi -p` helpers would save too. A changed environment rebuilds the pi session, so a failed
  lookup repeats the thread's last entries.
- `./integrations/bb/memory.ts#createMemoryTracker` keeps pi's reports (`./integrations/bb/memory.ts#memoryViewSchema`)
  and other providers' views, built from configure and the tools; the `memory` RPC serves both and runs no CLI.
- The icon is a header action, since bb mounts only its three most-used plugins' prompt-box actions;
  `./integrations/bb/panel/footer.ts#useFooterMount` moves it beside the context circle, as Thread Spend does. It
  never moves a node already there, so two plugins beside the circle never loop.
- bb names a panel tab by its params, so every opener calls `./integrations/bb/panel/selection.ts#openCortexTab`: it
  opens the one tab without params, then sets its task in memory shared by every slot, so a reload shows the focus
  task. Why not a tab per task, as bb's Tasks plugin does? The tab's switcher already lists the thread's tasks.
- Plan progress copies the Herdr label's rule (`./integrations/bb/detail.ts#planProgress`); the body splitter
  (`./integrations/bb/panel/sections.ts#splitSections`) ignores `##` lines inside fenced code, as in plan bodies.

## Rules to keep

- The plugin imports only the public bb SDK, zod, Node and its own files, never cortex's source:
  `./integrations/bb/server.test.ts` (public SDK scan).
- Pi threads get no plugin tools, skills or instructions; other providers get both tools (only `cortex_update` with
  memory off), and instructions stay within the limit without running the CLI: `./integrations/bb/server.test.ts`.
- bb's pi never gets `CORTEX_MEMORY=write`, threads started by another thread look up only by default, and the report
  schema mirrors the extension's: `./integrations/bb/server.test.ts`, `./integrations/bb/memory.test.ts`,
  `test/unit/extensions-memory-view.test.ts`.
- Only bb's own pi reports, never blocking a prompt past its timeout, throwing or counting as a memory error:
  `test/unit/extensions-pi.test.ts`. The icon and the chip follow their settings, the icon never moves a node already
  in the footer, and every opener reuses the one Cortex tab: `./integrations/bb/app.test.tsx` (one Cortex tab).
- Tool failures throw, `cortex_recall` keeps the pi extension's per-request budget, and every tool argument, RPC
  input, metadata value and CLI output is validated: `./integrations/bb/server.test.ts`, `./integrations/bb/cli.test.ts`.
- Staleness is checked only for a checkout on the bb server's own machine: `./integrations/bb/server.test.ts`.
- The tab never edits a task's body or title; its only task writes are memory exclusion and, only when doctor
  reports `author`, status changes and notes through `cortex update --as-me`, which never notify:
  `./integrations/bb/server.test.ts` (writes as the user), `test/integration/cli/as-me.test.ts`.
- `cortex agents install` never changes the plugin's settings or touches a plugin bb installed from git or npm, and
  no test runs the real bb or npm (`CORTEX_BB_CLI=""` in every test env): `test/integration/cli/agents-bb.test.ts`,
  `test/integration/isolation.test.ts`.
- `pnpm run test:bb` runs the plugin's tests and typecheck after `npm ci --prefix integrations/bb`; CI does not run it.

---
budget: 202
sources: [src/tui/app.ts, src/tui/session.ts, src/tui/commands.ts, src/tui/keys.ts, src/tui/config.ts, src/tui/theme.ts,
  src/tui/help.ts, src/tui/drafts.ts, src/tui/reader.ts, src/tui/diagram.ts, src/tui/safety.ts, src/tui/mouse.ts,
  src/tui/dialogs.ts, src/tui/preferences.ts, src/tui/settings.ts, src/lib/refGrammar.ts, src/lib/catalogSearch.ts]
---
# The terminal workspace

The terminal workspace (the TUI: a full-screen app in your terminal) is where you read, edit and triage tasks while
your agents work on them. The first half of this page is for anyone using it; "Under the hood" and "Rules to keep"
are for engineers changing it. See also [architecture](architecture.md) and [memory](memory.md).

## Opening it

Run plain `cortex` in an interactive terminal (the same as `cortex tui`; `cortex tui --help` lists the options).
The workspace talks to your database's daemon (the one background process that serves that database) and starts it
if none is running. Quitting leaves the daemon running for the CLI, your agents and other workspaces.

```bash
cortex            # open the workspace
cortex tui 42     # open it on task 42
```

It needs a terminal of at least 80x24 cells. `NO_COLOR` turns colors off; every state still has a visible mark
(text, inverse, underline or bold). `TERM=dumb` is refused because the workspace needs cursor control: use the CLI
there. A startup problem, such as a task id that does not exist, is printed before the screen changes.

## What you see

The task list is on the left and the selected task on the right. The task's document has three views: Read renders
its Markdown, Edit is a text editor for the title and body, and Split puts the editor beside a live preview. Three
panels sit next to them: Activity (the task's updates, newest first, where you can post one), Related (tasks that
reference it, that it references or that share its tags) and Authors (who posted on it). The status line at the
bottom shows the mode, whether your text is saved, the connection and any messages.

## How you move around

The keys work like vi: NORMAL moves and acts, INSERT types, VISUAL selects, `:` opens a command line and `/` searches;
`Esc` goes back to NORMAL. Read, Edit and Split share one cursor: motions move it, `v`/`V` select from it, a view
change keeps it. `?` or `:help` lists every mode, command, key (as configured) and setting; `:commands` (Ctrl-p) lists
them by group. Panes open centred: small (forms), medium (pickers), large (feeds, help). The mouse is optional, on by
default (click to focus or place the cursor, drag to select, scroll); every action has a key or a command.

## Editing and saving

Titles and bodies save themselves shortly after you stop typing (`:w` saves now); "saved" means it was confirmed.

What if an agent changed the same field while you were typing? cortex keeps both versions, the status line says
"conflict", and that field stops autosaving until you choose: `:apply` takes theirs, `:keep` saves yours over it.
Changes to different fields never conflict. `:q` refuses to quit while text is unsaved, so you never silently lose
it. Status changes you make are human changes, never attributed to an agent.

## Staying in sync

Changes from agents, the CLI and other workspaces appear instantly. When a task becomes blocked, the status line
flashes (optionally with a bell). An agent's status change leaves an unread notification; `:notifications` lists them
(errors go to `:messages`). If the daemon restarts, the workspace shows as stale until it reconnects on its own.

## Making it yours

Settings live in `~/.config/cortex/tui.toml` (under `$XDG_CONFIG_HOME` when that is set). For example:

```toml
theme_dark = "high-contrast-dark"
bell = true
mouse = false
```

The bundled themes follow your terminal's light or dark appearance. `:config theme` picks one with a live preview
and writes it to tui.toml; `:config theme auto` removes it and follows the terminal again. A custom theme is
`themes/<name>.toml` in the same directory, usually extending a bundled theme and overriding a few colors:

```toml
extends = "cortex-dark"
accent = "#ffb86c"
status.blocked = "#ff7b72"
```

`:config` is where you change a default: it lists every setting by section (Enter changes one, `x` restores its
default) and writes only that line of tui.toml, at once, keeping your comments and layout; `:config <setting> <value>`
does the same from the command line. The mouse and the colors apply at the next start, the rest at once. Commands and
shortcuts (filters, the search, `:sort`, Read/Edit/Split, `;d` for done tasks, `;e` for the task list) last only for
the workspace you are in. `scroll` sets how far one wheel notch moves in every pane. Settings are global; a profile
(`--profile`) keeps only each database's last task. The pane also installs or resets the agent integrations, as
`cortex agents install|reset` does. cortex leaves a tui.toml that does not parse untouched, and a mistake in it or a
theme file keeps that entry's default; `:messages` lists both.

## Limits

- Images show as `[image: ...]` placeholders. Mermaid draws as text art, or as source when it cannot, saying why.
- The workspace is keyboard-first but has not been tested with screen readers.
- Copying to the clipboard and clickable links depend on your terminal (and on tmux or SSH passing them through).
- Unsaved text lives in the workspace's memory. On SIGTERM, SIGHUP or SIGINT it first tries to save every draft,
  but a SIGKILL, a crash or a power loss loses unsaved text.

## Under the hood

### Shell, session and data

`src/tui/app.ts#runTui` does everything that can fail with a message (tui.toml, the view state,
`src/daemon.ts#ensureDaemon`, the first snapshot) before it takes the terminal. `src/tui/app.ts#Shell` then owns
terminal I/O: key routing, overlays, the mouse modes, the appearance query (no answer means dark), lending the
terminal to another program (`src/tui/bridge.ts#withExternalProgram`) and restoring it on every exit path.
`src/tui/session.ts#TuiSession` is one workspace's state, with no process-wide singletons; input takes one route
whatever the toolkit focused: the open prompt, then the top dialog, then the shell. It also keeps each task's body
cursor (`src/tui/session.ts#bodyCursor`), the one position Read, Edit and Split show: the view with the keyboard writes
it and the others follow it, through the source anchors `src/tui/reader.ts#parseDocument` records for rendered text.

Data comes only from the daemon: a snapshot plus the live event stream (SSE, a long-lived HTTP response the daemon
pushes changes down) from `src/subscription.ts#subscribeChanges`. The stream applies every change, so a write never
patches the local copy from its answer. Why not `src/daemon.ts#withClient`, which may open the database
in-process? Events are published inside the daemon, so only a client attached to it sees other writers live.

### Help, settings and themes

Each reference list exists once: `src/tui/commands.ts#COMMANDS`, `src/tui/keys.ts#KEY_ACTIONS`,
`src/tui/theme.ts#THEME_TOKENS` and `src/tui/config.ts#SETTING_HELP`. Execution, completion, `:help` and `:commands`
read them (commands by `src/tui/commands.ts#COMMAND_GROUPS`, not registry order); `src/tui/app.ts#helpLines` adds the
user's keys and `src/tui/help.ts` only wraps and searches. A new entry needs no other edit.

`src/tui/config.ts#loadConfig` validates each section on its own, and file content never makes it throw. A custom
theme (`src/tui/theme.ts#loadCustomTheme`) must set every token or extend one bundled theme; bundled names win,
errors reject it, low contrast only warns. `src/tui/theme.ts#resolveTheme` picks the theme: `:config theme` in this
session, then `--theme`, then tui.toml's `theme`, then `theme_dark`/`theme_light` by appearance, then the bundled pair.

`src/tui/config.ts#saveSettings` writes tui.toml's `src/tui/config.ts#WRITABLE_SETTINGS`. It re-reads the file, adds,
replaces or removes only those top-level `key = value` lines, and renames a private temp file over the file (over a
symlink's target, so a dotfiles link stays a link). A guard parses the result and refuses it unless exactly those keys
changed, so an edit never lands inside a multi-line string. The `:config` pane (`src/tui/settings.ts`) saves through
`src/tui/session.ts#saveSetting`, then applies a live setting: a refused change never shows. The per-profile view state
(`src/tui/preferences.ts#openPreferences`) keeps each database's last task, merged over a fresh read and renamed from a
private temp file too (no lock; the narrow race is accepted). Before tui.toml is read,
`src/tui/preferences.ts#migrateSettings` moves the theme, density, line numbers, mode, sort and grouping an older
view-state file still holds into tui.toml, unless tui.toml sets them; the rest of its old view is dropped.

Why not rewrite tui.toml with `Bun.TOML.stringify`? It drops every comment. Why not a TOML library? A parse-equality
guard already catches a misplaced edit. Why not per-profile settings, or a copy in both files? One home per setting
keeps tui.toml, `:help` and the screen in agreement. Why not save a command's change? The last to quit would win.

### Drafts and guarded writes

A draft (`src/tui/drafts.ts`) starts editing only after an atomic baseline read and saves only through the
versioned `editTask` of `src/contracts.ts#VersionedWrites`, guarded by that field's version token. A rejected save
(HTTP 412) keeps both versions; `:keep` writes again against the incoming token, so it can conflict again. A live
copy of a drafted task only triggers a re-read; a stale read never reverts saved text.

Metadata and catalog commands (`src/tui/commands.ts`) send the version tokens of the scopes they change and no
mutation id: they never retry an uncertain write, so a receipt could never be replayed. The update composer
(`src/tui/activity.ts`) is the one idempotent write: re-posting the same text reuses its id, so it posts once.

Why not plain last-writer-wins? An autosave from a draft opened minutes ago would silently erase what an agent wrote
since. CLI and API writes (`src/store.ts#editTask`) stay last-writer-wins by design; do not drop the TUI's guards.

### Terminal safety

Task text is untrusted: an agent or a paste can put escape sequences in it. Every stored string passes
`src/tui/safety.ts#escapeTerminalText` before `src/tui/theme.ts#style` colors it, so control characters show as
text. `src/tui/reader.ts` is the only Markdown renderer: raw HTML shows as text, images are never fetched, and a
hyperlink wraps only a destination `src/tui/safety.ts#safeUrl` accepts. Why not pi-tui's Markdown component? It
is a renderer, not a security boundary: it emits links unchecked. `@id`/`#tag` references share
`src/lib/refGrammar.ts#REF_RE`; each consumer keeps its own RegExp instance because the `g` flag is stateful.
`src/tui/diagram.ts#drawMermaid` draws Mermaid with the `lovely-mermaid` library: escaped source in, every span
escaped again, roles mapped to existing theme pairs, diagram links and author colors dropped. Why not mermaid.js
or terminal images? One needs a browser DOM, the other a graphics terminal, and neither could be searched.

### Mouse and pickers

`src/tui/mouse.ts#parseMouse` is the one parser, and `src/tui/mouse.ts#filterMouseInput` drops unsupported reports
before the toolkit sees them. The Shell turns tracking on (`src/tui/mouse.ts#MOUSE_ON`) once it holds the terminal and
off on every path that gives it back. The toolkit's own mouse stays off: it would ask for any-motion tracking, which
nothing needs. A click or drag moves the keys' cursor and selection, not a second model; a wheel notch counts once
(`src/tui/mouse.ts#WheelNotches`). The lane and tag pickers search with `src/lib/catalogSearch.ts#searchCatalog`: every
entry for an empty query, else every case-insensitive match of all the words, in the caller's order, so every lane and
tag stays reachable. `src/tui/dialogs.ts#paneBox` sizes every centred pane; the Shell draws help and `:messages` into
its frame. Why not an overlay? It would need showing and hiding on every view change, and it would swallow the wheel.

## Rules to keep

- Startup failures print before the terminal is taken; every exit path restores it, mouse off first:
  `test/integration/tui.test.ts` through `test/integration/fixtures/pty.ts`, which checks the terminal from outside.
- Quitting never stops the shared daemon; workspaces converge: `test/integration/tui-concurrency.test.ts`.
- Writes go one at a time through `src/tui/session.ts#mutate`, only to the database they were submitted on, and
  never patch state from their answer: `test/unit/tui/session.test.ts`.
- Reference lists live only in their source, never in README or docs. `test/unit/tui/commands.test.ts` holds a
  FIXED command list, deliberately not derived from the registry, so removing a capability fails a test.
- Themes are never written; tui.toml only by `src/tui/settings.ts` and `migrateSettings`, through
  `src/tui/config.ts#saveSettings` (only the requested top-level lines, never into an unparsable file); an invalid
  section keeps ALL its defaults and is reported; the view state holds only each database's last task:
  `test/unit/tui/settings.test.ts`, `test/unit/tui/config.test.ts`, `test/unit/tui/theme.test.ts`,
  `test/unit/tui/preferences.test.ts`, `test/unit/tui/session.test.ts`.
- Drafts save only through guarded versioned writes; a conflict keeps both versions; "saved" means acknowledged,
  never merely sent: `test/unit/tui/drafts.test.ts`.
- Tag changes are add/remove deltas, never a whole-list replacement, and never delete a tag definition; TUI status
  changes carry no author: `test/unit/tui/commands.test.ts`.
- Every untrusted string is escaped before it is styled, the database keeps the raw text, Markdown renders only
  through `src/tui/reader.ts` (Mermaid via `src/tui/diagram.ts`), links only past `src/tui/safety.ts#safeUrl`:
  `test/unit/tui/reader.test.ts`, `test/unit/tui/diagram.test.ts` and `test/integration/tui-safety.test.ts`, which
  seeds control sequences everywhere and scans the raw output, with a positive control proving the scan can fail.
- One mouse parser, Shell-owned modes, no any-motion tracking, never the only path to an action:
  `test/unit/tui/mouse.test.ts`, `test/integration/tui.test.ts`.
- Picker search never caps, paginates, reorders or forces refinement: `test/unit/lib/catalogSearch.test.ts`.
- Every pane is centred and sized by `src/tui/dialogs.ts#paneBox`: `test/unit/tui/dialogs.test.ts`.

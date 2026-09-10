# cortex

> AI coding agents working on this repo: start with [AGENTS.md](./AGENTS.md). Run `pnpm run agents:check` before pushing.

Personal task tracker for engineers supervising parallel AI coding agents.
Single self-contained binary at `home/bin/cortex` with a complete CLI, REST + SSE
API on `127.0.0.1`, and a SQLite WAL store at `~/.config/cortex/cortex.db`.

## Quick start

```bash
pnpm run build                       # compile to bin/cortex
cortex init                          # create ~/.config/cortex/cortex.db
cortex add "ship plan 1" -p 0
cortex ls
cortex serve                         # start the dashboard on http://cortex.localhost:7777
cortex open                          # re-open the dashboard in your browser
cortex stop                          # stop the daemon
```

For development without compiling:

```bash
pnpm run dev -- ls --json
```

### Live UI dev loop

```bash
pnpm run serve:dev                   # bun --watch, port 7777, --no-open
PORT=7778 pnpm run serve:dev
```

- HTML edits to `src/ui/index.html` are picked up immediately — the
  server reads the file fresh on every request via `Bun.file().text()`. Just
  refresh the browser; no restart, no reload script.
- TypeScript edits to `src/cli.ts`/`src/server.ts`/`src/store.ts`/etc. trigger a
  `bun --watch` restart within ~1 s. The browser stays connected because
  the SSE `EventSource` reconnects automatically; refresh once to repopulate.
- The dev script stops any background daemon first so it owns the port.
- Use a different port if you also want the daemon running: `PORT=7778 pnpm run serve:dev`.

## Commands

| Command | Purpose |
| --- | --- |
| `init` | initialize the SQLite database |
| `add <title> [-l lane] [-p int] [-b body]` | create a task (auto-creates `lane` if missing) |
| `ls [-l lane] [-s status] [--json]` | list tasks, grouped by lane, sorted by id (`s` = `open\|review\|blocked\|done`) |
| `show <id> [--json]` | show one task with its updates |
| `search [text] [--json]` | fuzzy-search tasks (same scorer + `@id`/`@title`/`#tag` prefixes as the dashboard palette) in an fzf picker with a `show` preview; enter copies the task id to the clipboard and prints the task like `show`; `--json` emits ranked matches without fzf |
| `update <id> -m <msg> [-s status] [-b body]` | post an update; `status` = `open\|review\|blocked\|done` |
| `edit <id> [-t title] [-b body] [-p int]` | edit task fields |
| `mv <id> <lane>` | move a task to another lane (auto-creates `lane` if missing) |
| `rm <id> [-f]` | remove a task (prompts unless `-f`) |
| `lane add\|ls\|edit\|rm` | manage lanes |
| `serve [-p port] [--foreground] [--no-open] [--host name]` | run the HTTP daemon; serves the dashboard at `/`. Default printed URL uses the friendly host `http://cortex.localhost:<port>` (server still binds `127.0.0.1`). |
| `open` | open the cortex dashboard in your default browser |
| `reset` | stop the daemon (if running), wipe the DB + WAL sidecars + pid/url/browser-url files, then re-init an empty DB. Requires typing `RESET` to confirm. |
| `stop` | stop the running daemon |
| `backup [-o path] [--rotate N]` | export cortex's row data as a single JSON document inside a `.zip` (default `~/.config/cortex/backups/cortex-<host>-<ISO>.zip`). Safe to run while the daemon is up. |
| `restore <file> [--dry-run]` | re-insert backup rows into the live DB. Lanes/tags merge by name (existing wins). Tasks try to keep their original id; on collision they get the next available id. Updates, task_tags, and notifications follow the task-id remap. Refuses while the daemon is running — run `cortex stop` first. |

## Lanes

Lanes are flat strings (`now`, `later`, `blocked`, anything you want). `now`
is seeded automatically and cannot be removed. Any lane referenced by `cortex
add -l <name>` or `cortex mv <id> <name>` is created on the fly with no color
set. Use `cortex lane add <name> -c <color>` upfront when you want to assign
a color, and `cortex lane ls` to inspect.

## Priority

Priority is a non-negative integer where **0 is the highest priority**. There
is no upper bound — use whatever scale fits (`0/1/2`, `0..10`, etc.). Tasks
are listed by priority ascending, ties broken by oldest-created first.

```
cortex add "ship the thing" -p 0      # top of the list
cortex add "normal work"              # default priority = 1
cortex add "someday" -p 9             # bottom
cortex edit 42 -p 0                   # promote a task
```

For every flag that takes a fixed enum (`--status`, `--severity`), `cortex
<command> --help` shows the exact set of allowed values inline.

## Storage

- **DB file:** `~/.config/cortex/cortex.db` (XDG-aware via `$XDG_CONFIG_HOME`).
- **Override for tests:** `CORTEX_DB=/path/to/db cortex …`.
- **Mode:** SQLite WAL with `PRAGMA foreign_keys = ON`. The `-wal` and `-shm`
  sidecar files are normal and persistent.
- **PID file:** `~/.config/cortex/cortex.pid` while `cortex serve` runs.

## Backup & restore

`cortex backup` writes a single `.zip` containing `cortex-backup.json` — a flat data-only dump of cortex rows (lanes, tags, tasks, updates, task_tags, and notifications). The backup is taken inside a deferred SQLite read transaction so it is safe to run while the daemon is writing. The dashboard's sidebar system bar also has a `Back up now` button that writes the same default backup through the daemon.

`cortex restore <file>` re-inserts backup rows into the live DB inside one transaction:

- Lanes and tags merge by name; existing destination rows win.
- Tasks try to keep their original `id`. If the id is already taken, the task is inserted with the next available autoincrement id. The restore output reports how many ids were preserved vs bumped.
- Updates, task_tags, and notifications reference the remapped task ids automatically.
- Data-only restores are backwards-compatible with v1 backups: unknown row columns are ignored, missing optional tables are treated as empty, and missing nullable/defaulted destination columns are filled by the current schema defaults.

Restoring the same backup twice will duplicate tasks (each with a different id). Use `cortex restore <file> --dry-run` to preview the counts before committing. Restore refuses while `cortex serve` is running; stop the daemon first so the CLI is the only writer. Skills, extensions, and pid/url files are NOT backed up — they are regenerated by `cortex init`.

## API surface

Bound to `127.0.0.1` only.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | the cortex dashboard (single-page Preact UI) |
| GET | `/api/health` | `{ ok: true, version }` |
| GET | `/api/me` | resolved author identity (`gh` username → `git config user.name` → `os.hostname()` → `"me"`) |
| POST | `/api/backup` | write an on-demand data-only backup using the default backup path |
| GET | `/api/tasks?lane&status` | list tasks |
| POST | `/api/tasks` | create a task |
| GET | `/api/tasks/:id` | fetch one task |
| PATCH | `/api/tasks/:id` | edit title/body/priority |
| PATCH | `/api/tasks/:id/status` | change status |
| PATCH | `/api/tasks/:id/lane` | move lane |
| DELETE | `/api/tasks/:id` | remove a task |
| GET | `/api/tasks/:id/updates` | list updates for a task |
| POST | `/api/tasks/:id/updates` | post an update |
| GET | `/api/lanes` | list lanes |
| POST | `/api/lanes` | create a lane |
| PATCH | `/api/lanes/:name` | edit a lane (`rename` cascades to tasks) |
| DELETE | `/api/lanes/:name` | remove an empty lane (refuses `now`) |
| GET | `/events` | SSE stream of `task.added`, `task.updated`, `task.removed`, `update.posted`, `lane.changed` |

SSE clients receive a `heartbeat` event every 15 s.

## Dashboard

`cortex serve` opens a document-first single-page dashboard at
`http://127.0.0.1:7777/` (two columns on desktop; a navigation drawer at
≤ 900 px):

- **Navigation** (left, 280 px) — a workspace identity and ONE filter surface:
  a search box (`@id`, `@title-only`, `#tag`, body/title text), status and
  lane selectors, `Filter by tags` (multi-select, OR semantics, plus an
  `untagged` sentinel), an include-done toggle and `Clear all`.
  Status, lane and tags open matching **attached sidebar panels**, not
  browser-native dropdowns or a centered filtering dialog. Panels align to
  the sidebar, highlight their trigger, and stay within the available
  viewport. Lane and tag dropdowns have optional keyword search: an empty
  query shows every entry, and typing filters the full catalog using
  case-insensitive AND matching (for example, `platform api` matches both
  words anywhere in the name). There is no result cap or forced narrowing.
  The task-header lane/tag pickers use the same search behavior. Typing
  does not change a filter or task membership until you choose an entry.
  Tag selection stays open for batch picking, even when the
  filtered list's fallback task changes. Selected tags render as removable tokens. Search runs against
  the full task pool first, then intersects with the structured filters, so
  `#tag` still resolves exactly even when matching tasks live in another
  lane. The **Tasks** section lists the filtered tasks (status dot, title,
  `Pn` chip, task ID and status) with a `+` for a new untitled task.
  Theme, `Manage lanes`, `Manage tags` and `Back up now` stay at the foot of
  the sidebar. Filters govern the list
  only — the explicitly selected task never changes under you; if it falls
  outside the filters the workspace says so and offers `Clear filters`.
  `Manage lanes` / `Manage tags` are explicit modes (rename, color, sort,
  delete with safety: cannot delete `now` or non-empty lanes; tag deletion
  shows the cascade count) with a `Back to tasks` affordance; entering them
  never changes filters.
- **Document** (center) — tasks open in your saved Read/Edit/Split mode
  (Read is the default for a new browser). The header
  shows `[id]` once and a large wrapping title—click it (or focus it and
  press Enter/Space) to edit in place. Enter/Escape finish editing and return
  focus to the title; blur flushes without stealing focus. The quiet property
  row has `Lane: …`, `Priority: Pn` / `Set priority` (integer or blank to
  clear), removable tag pills, and a single `+` button to add tags. Each
  rounded pill is compact at rest and smoothly expands its `×` control on
  hover or keyboard focus—no reserved empty remove-button space. Touch
  devices keep the remove target visible. Clicking (or keyboard-activating) a
  tag pill's label appends that tag to the sidebar tag filter (idempotent,
  never toggles it off); the `×` instead detaches the tag from this task, not
  the tag definition. Tag additions
  and removals use the API's delta modes rather than replacing a stale tag list. The workspace toolbar keeps the smart next-status action
  (`Move to review` / `Mark done` / `Unblock` / `Reopen`), status popup,
  `Focus reading` / `Show navigation`, and a `⋯` task-actions menu holding
  `Delete task` (confirmed). The title and prose share an inset reading column.
  One tablist — **Document / Activity / Related / Authors** — and, on the
  Document tab, a **Read / Edit / Split** switch. Your choice is saved in
  browser localStorage and reused across task switches, reloads and new tabs;
  only the preference enum is stored, never raw task drafts. Heading links
  temporarily reveal Read without changing the saved preference. Read renders sanitized
  Markdown (GFM tables, task lists, code with copy controls, Mermaid
  diagrams, clickable `@id`/`#tag` refs) with an outline rail; Edit and
  Split use the same CodeMirror instance, which stays mounted (cursor, undo
  and pending edits survive switching modes or tabs). Edits autosave
  (600 ms idle / 3 s max; `Cmd/Ctrl + S` flushes), external changes to a
  dirty field show Apply / Keep my changes, and unsaved drafts are kept in
  memory per task while you navigate.
- **Activity** (a Document tab, not a third column) — the task's updates as
  newest-first expandable cards (summary, author, time, severity, rendered
  body + Markdown source). A collapsed `+ Post update` composer sits after
  the thread; drafts are kept per task. **Related** shows referenced-by /
  references / shared-tag buckets with an explicit loading, error + retry
  and confirmed-empty state; **Authors** is the per-task rollup.

Rendering is a single sanitized boundary: Markdown → `marked` → DOMPurify
(HTML profile: no scripts, styles, forms, iframes, raw SVG/MathML,
`javascript:`/`data:` URLs) and Mermaid → `mermaid.render` in an inert
staging element → DOMPurify (SVG profile) → the reader. Documents without
diagrams never load the Mermaid chunk.

Motion is deliberately short: 90 ms for control feedback, 140 ms for menus
and content, and 180 ms for drawers. State and focus changes never wait for
animation; dismissal removes the live surface immediately. Reduced-motion
preferences disable decorative animations and transitions, including when
changed while a surface is open. Metadata/SSE refreshes don't replay the
unchanged document's reveal animation. Tag remove controls use a localized
140 ms width/fade reveal; this does not animate document/editor dimensions.

### Keyboard

No single-key hotkeys (they hijack typing in inputs). Globals:

- `Cmd/Ctrl + P` or `Cmd/Ctrl + K` — command palette (command / search mode)
- `Cmd/Ctrl + /` — reveal Activity, expand the composer and focus it
- `Cmd/Ctrl + Enter` — post the update (while focused in the composer)
- `Cmd/Ctrl + S` — flush the description/title autosave now (inside the editor)
- `Esc` — close palette → modal → popovers / drawer / drag tray

Quick body-mode shortcuts follow the controls' left-to-right order:

| Mode | Mac | Windows / Linux |
| --- | --- | --- |
| Read | `Cmd + Option + 1` | `Ctrl + Alt + 1` |
| Edit | `Cmd + Option + 2` | `Ctrl + Alt + 2` |
| Split | `Cmd + Option + 3` | `Ctrl + Alt + 3` |

Use the number row and **left Alt** on Windows/Linux; AltGr character input
is left untouched. The shortcuts work from CodeMirror, focus the selected
surface, and save your mode preference. They are suspended while dialogs,
menus or navigation own the keyboard, and ignore IME/handled events and
held-key repeats. The mode control shows the chord modifier once as a
"super key" (⌘⌥ / Ctrl+Alt) with a per-button digit (1/2/3); full hints
stay in tooltips and palette commands.

These avoid the common browser tab-selection (`Cmd/Ctrl + 1–9`), reload,
search and save shortcuts listed by [Chrome](https://support.google.com/chrome/answer/157179),
[Safari](https://support.apple.com/guide/safari/keyboard-and-other-shortcuts-cpsh003/mac)
and [Edge](https://support.microsoft.com/en-us/microsoft-edge/keyboard-shortcuts-in-microsoft-edge-50d3edab-30d9-c7e4-21ce-37fe2713cfad).
Custom OS/extension mappings can still intercept them. Alt-key handling follows
[the documented platform differences](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/getModifierState).

Inside the Document tablist: `←`/`→`/`Home`/`End` move focus between tabs,
`Enter`/`Space` activate the focused tab. Sidebar filter panels are nonmodal:
`↑`/`↓`/`Home`/`End` navigate choices, `Enter`/`Space` choose, and `Esc` closes
the panel and returns focus to its trigger. Outside clicks dismiss without
stealing focus. The palette's `Filter by tags…` command reveals this same
sidebar panel, including on phones and from focus reading.

Dialogs (palette, lane/tag editors, confirmations, the mobile navigation
drawer) remain native modal dialogs: Tab is trapped, the background is inert,
and focus returns to the opener on close. Opening a filter inside mobile
navigation does not open another dialog or dismiss the drawer.

The command palette is the primary interface for everything: new task,
switch task (global search — selecting a result keeps your filters), Read
document / Edit description / Split / Edit title, Post an update, change
status / priority / tags, lane filter / edit / delete, Manage lanes /
Manage tags, theme. Type to filter, `↑`/`↓` to navigate, `Enter` to execute.

### Drag & drop

Start dragging a task row and a transient **Move to lane** tray appears at
the bottom of the navigation column; drop the task on a lane to move it.
The tray is not a filter list and disappears when the drag ends (or on
`Esc`). The `Lane:` control in the header is the click/keyboard/touch
alternative.


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
| `ls [-l lane] [-s status] [--json]` | list tasks, grouped by lane, sorted by priority (`s` = `open\|review\|blocked\|done`) |
| `show <id> [--json]` | show one task with its updates |
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

`cortex serve` opens a 3-pane single-page dashboard at `http://127.0.0.1:7777/`:

- **Lanes** (left, 220 px) — the top system bar includes theme, tag-management, show-done, `Back up now`, and reset-filters controls. Below it: colored dot + name + open-count for each lane.
  Hover any lane row for an inline `⋮` button that opens the lane editor
  (rename, color picker, sort, delete — with safety: cannot delete `now` or
  non-empty lanes). Below the lanes: a list of tasks in the current filter
  (or all tasks), each with a status dot and `Pn` priority chip. Rows span
  the full sidebar width so the priority chips line up. New-task input is
  pinned to the bottom.
- **Active task** (center) — one task at a time. `[id]` + lane chip (with
  lane color) + `Pn` priority chip + status pill (one pill, click for popover).
  Click-to-edit title and body. Smart primary action button
  (`Move to review` / `Mark done` / `Unblock` / `Reopen`) plus a `…` overflow
  menu (Edit / Delete) that opens upward to avoid overflowing the pane.
  Post-update compose box with author defaulting to the resolved identity
  from `/api/me`.
- **Inbox** (right, 340 px) — reverse-chronological updates for the active
  task with author avatar + relative timestamps.

### Keyboard

No single-key hotkeys (they hijack typing in inputs). Three globals:

- `Cmd/Ctrl + P` or `Cmd/Ctrl + K` — toggle command palette
- `Cmd/Ctrl + /` — jump cursor into the post-update textarea from anywhere
- `Cmd/Ctrl + Enter` — post the update (works while focused in the textarea)
- `Esc` — close palette → modal → popover → editing mode

The command palette is the primary interface for everything: new task, switch
task, edit, change status, change priority, lane edit/delete/filter, etc.
Type to filter, `↑`/`↓` to navigate, `Enter` to execute.

### Drag & drop

Drag a task title onto a lane button to move it; drag onto a status pill to
change status.


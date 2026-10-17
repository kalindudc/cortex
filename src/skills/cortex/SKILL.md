---
name: cortex
description: Personal task tracker for engineers supervising parallel AI coding agents. Use to add tasks, post updates with a required session-id author tag, change task status (draft/open/review/blocked/done), or install (agents install) / tear down (reset) cortex on a fresh repo.
---

# Cortex

Cortex is a single-binary, single-user task tracker designed for one human supervising several AI coding agents at once. Tasks live in a SQLite file under `~/.config/cortex/` (or `CORTEX_DB`). An optional daemon (`cortex serve`) serves one database over a private Unix socket, for the CLI and the terminal workspace. While it runs, every command goes through it; without it, each command owns the database just for its own work, so agents can run commands concurrently either way.

Humans usually work in the terminal workspace (TUI): plain `cortex` in an interactive terminal, the same as `cortex tui`. It starts the daemon when none runs, and quitting it leaves that daemon running. Agents should NOT launch it (it needs a TTY and takes over the terminal): use the CLI with `--json`, whose writes every open TUI shows live.

## Key Principles

- **Single-user, local-only, no auth.** The daemon listens only on a private Unix socket. Anyone with shell access as your user has full CRUD. Do not expose the socket. There are no bearer tokens.
- **Every update has an author.** A valid bb thread defaults to `bb-<thread id>`; explicit `--as` wins. Outside bb, use the `cortex_update` tool or the [session-id recipe](recipes/session-id.md). Without either, update exits 1. `--as-me` records a change as the user's own, like the TUI; it is for tools acting for the user (the bb plugin, the user's scripts), and agents never pass it: it hides their status changes from the blocked notification.
- **No severity flag. Message text describes urgency.** Write `-m "ready for review"` or `-m "blocked on missing API key"` in plain prose. Structured semantics belong in `--status` (`draft`/`open`/`review`/`blocked`/`done`), not in a separate severity field.
- **Every status change is also an audit-trail row.** Setting `-s` writes both the message AND a `status → <new>` row in the updates table, both attributed to `--as`. Parallel-agent status oscillation (open→blocked→open→blocked) shows up in the inbox as history rather than silently overwriting.
- **The TUI signals (status-line flash, optional bell) ONLY on transitions into `blocked`.** Routine updates, `done` flips, and review handoffs do NOT interrupt the human: `blocked` is the one signal worth it.
- **Two body-edit modes — anchor-based and full overwrite.** `cortex edit <id> --body-search "<exact unique anchor>" --body-replace "<replacement>"` performs an in-place edit that fails 409 if the anchor is missing or matches multiple times — concurrent writes detect conflicts instead of silently overwriting each other. `cortex edit -b "<full body>"` (or `--body-file`) replaces the whole body in one shot. Choose based on the scope of the change you're making. `cortex update` is for status notes; the body is the task's description. See [cli/edit.md](cli/edit.md).

## CLI

| Command | Description | Docs |
|---|---|---|
| `cortex init` | Initialize or migrate the SQLite DB (agent tools: `cortex agents install`). | [init.md](cli/init.md) |
| `cortex agents install\|reset` | Write the embedded skills, plus the pi extension when pi is present and the bb plugin when bb is; `reset` wipes them first. | [agents.md](cli/agents.md) |
| `cortex add <title>` | Create a new task. | [add.md](cli/add.md) |
| `cortex edit <id>` | Edit a task's title, body, or priority. Body edits prefer anchor-based partial replace. | [edit.md](cli/edit.md) |
| `cortex update <id> -m <msg> --as <id>` | Post an update on a task; optionally flip status. | [cli/update.md](cli/update.md) |
| `cortex schema` | Print the data model + command grammar (agent orientation, DB-free). | [schema.md](cli/schema.md) |
| `cortex doctor` | Report version, db path, daemon state, pending migrations, counts (read-only; never starts a daemon). | [doctor.md](cli/doctor.md) |
| `cortex memory search\|show\|context\|streams\|lane` | Agent memory, including author-touched streams. | [memory.md](cli/memory.md) |
| `cortex watch --json` | Follow changes; refetch after ready or resync. | [watch.md](cli/watch.md) |
| `cortex tui [id]` | Open the terminal workspace (for humans; needs a TTY). Plain `cortex` in an interactive terminal does the same. | `cortex tui --help` |
| `cortex serve` | Run this database's daemon (private socket). | [serve.md](cli/serve.md) |
| `cortex reset` | Stop this database's daemon, wipe the DB (destructive, requires typing `RESET`). | [reset.md](cli/reset.md) |

Other commands (`ls`, `show`, `search`, `mv`, `rm`, `lane`, `stop`) follow the same shape — run `cortex <cmd> --help` for argument reference. `cortex stop` stops only the daemon serving the current database.

## Agent I/O contract (`--json`)

Every mutating command (`add`, `edit`, `update`, `mv`, `rm`, `tag add|edit|rm`, `lane add|edit|rm`) — plus the read commands `ls`, `show`, `search`, `schema`, `doctor` — accepts `--json`. Prefer it whenever you will parse output.

- **Success** prints the resulting object to **stdout** (e.g. `add`/`edit`/`mv` → the task; `update` → `{ update, status? }`; `rm` → `{ ok, id }`). `cortex ls --json` omits task bodies for scannability — pass `--full` to include them, or read one body with `cortex show <id> --json`.
- **Errors** print `{ "error": { "code", "message", "matches"? } }` to **stdout** under `--json` (and `error: <message>` to **stderr** otherwise). Exit is `0` on success, `1` on error; branch on `code`, not the exit code.
- **Codes:** `not_found`, `bad_request`, `validation`, `conflict`, `body_search_not_found`, `body_search_ambiguous` (with `matches`), `error`. See `cortex schema --json` for the authoritative list.
- **stdin body:** `cortex add --body-file -` (or `--body-file=-`) reads the body from stdin; `cortex edit` supports the same.
- **One-shot attribution:** `cortex add --as <id>` records the first `created` update so the task is not anonymous (otherwise `add` is anonymous and attribution starts at the first `cortex update`).
- **Non-interactive `rm`:** `cortex rm --json` refuses to prompt (agents can't answer y/N) — pass `--force`. The human, non-`--json` prompt still works via piped stdin and aborts safely on EOF.

## Memory

Tasks double as memory streams across sessions: the body is the current state, updates are breadcrumbs, the lane is the project (derived from the ask; recipes/persistence.md §2).
Under pi, relevant memory is injected automatically and `cortex_recall` loads a stream with its staleness check.
In bb with the Cortex plugin, a line `::cortex{id="<id>"}` in your reply shows that task as a card that opens it in the Cortex tab.
When to read, trust, write and re-sync memory: [recipes/memory.md](recipes/memory.md).

## Recipes

- [Session ID for parallel agents](recipes/session-id.md) — how to generate and carry the `--as` tag for the lifetime of an agent session.
- [Persisting documents as cortex tasks](recipes/persistence.md) — shared mechanics for skills that store plans, reviews, or analyses as task bodies: lane derivation, `--body-file` discipline, attribution, revision modes, cross-linking.

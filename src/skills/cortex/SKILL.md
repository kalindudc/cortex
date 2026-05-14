---
name: cortex
description: Personal task tracker for engineers supervising parallel AI coding agents. Use to add tasks, post updates with a required session-id author tag, change task status (open/review/blocked/done), or bootstrap (init) / tear down (reset) cortex on a fresh repo.
---

# Cortex

Cortex is a single-binary, single-user task tracker designed for one human supervising several AI coding agents at once. Tasks live in a SQLite file under `~/.config/cortex/`. A localhost daemon (`cortex serve`) exposes both a JSON API and a browser dashboard.

## Key Principles

- **Single-user, localhost-only, no auth.** The daemon binds to `127.0.0.1` only. Anyone with shell access on the machine has full CRUD. Do not expose the port. There are no bearer tokens.
- **`cortex update` REQUIRES `--as <id>`.** Generate a session id ONCE at the start of an agent session via the [session-id recipe](recipes/session-id.md), hold it in working memory, and pass it on every update. The CLI rejects updates without it (exit 1).
- **No severity flag. Message text describes urgency.** Write `-m "ready for review"` or `-m "blocked on missing API key"` in plain prose. Structured semantics belong in `--status` (`open`/`review`/`blocked`/`done`), not in a separate severity field.
- **Every status change is also an audit-trail row.** Setting `-s` writes both the message AND a `status → <new>` row in the updates table, both attributed to `--as`. Parallel-agent status oscillation (open→blocked→open→blocked) shows up in the inbox as history rather than silently overwriting.
- **Browser notifications fire ONLY on transitions into `blocked`.** Routine updates, `done` flips, and review handoffs do NOT pop notifications. The dashboard treats `blocked` as the one signal worth interrupting the human for.
- **Two body-edit modes — anchor-based and full overwrite.** `cortex edit <id> --body-search "<exact unique anchor>" --body-replace "<replacement>"` performs an in-place edit that fails 409 if the anchor is missing or matches multiple times — concurrent writes detect conflicts instead of silently overwriting each other. `cortex edit -b "<full body>"` (or `--body-file`) replaces the whole body in one shot. Choose based on the scope of the change you're making. `cortex update` is for status notes; the body is the task's description. See [cli/edit.md](cli/edit.md).

## CLI

| Command | Description | Docs |
|---|---|---|
| `cortex init` | Initialize the SQLite DB and (re)write the embedded skill at `~/.agents/skills/cortex/`. | [init.md](cli/init.md) |
| `cortex add <title>` | Create a new task. | [add.md](cli/add.md) |
| `cortex edit <id>` | Edit a task's title, body, or priority. Body edits prefer anchor-based partial replace. | [edit.md](cli/edit.md) |
| `cortex update <id> -m <msg> --as <id>` | Post an update on a task; optionally flip status. | [cli/update.md](cli/update.md) |
| `cortex serve` | Run the localhost API + dashboard daemon. | [serve.md](cli/serve.md) |
| `cortex open` | Open the cortex dashboard in your default browser. | [open.md](cli/open.md) |
| `cortex reset` | Wipe the DB and regenerate the skill (destructive, requires typing `RESET`). | [reset.md](cli/reset.md) |

Other commands (`ls`, `show`, `mv`, `rm`, `lane`, `stop`) follow the same shape — run `cortex <cmd> --help` for argument reference.

## Recipes

- [Session ID for parallel agents](recipes/session-id.md) — how to generate and carry the `--as` tag for the lifetime of an agent session.

# `cortex reset`

Stop the running daemon (if any), wipe the SQLite database and its WAL sidecars, regenerate the embedded skill at `~/.agents/skills/cortex/`, and re-initialize an empty DB with the default `now` lane.

This is **destructive and irreversible**. All tasks, updates, lane history, and any hand-edited skill files are gone.

## Usage

```bash
cortex reset
```

## Args

None. The command requires interactive confirmation: you must type the literal word `RESET` (uppercase) at the prompt. Anything else aborts with exit 1.

## Example

```bash
$ cortex reset
This will:
  • stop the running cortex daemon (pid 41218)
  • delete /Users/you/.config/cortex/cortex.db
  • delete /Users/you/.config/cortex/cortex.db-wal, ...-shm (SQLite WAL sidecars, if present)
  • delete /Users/you/.config/cortex/cortex.pid, cortex.url (daemon state, if present)
  • re-initialize an empty database with the default 'now' lane
Type RESET to confirm: RESET
✓ stopped daemon
✓ wiped database files
✓ re-initialized /Users/you/.config/cortex/cortex.db
✓ reset complete
```

## Pitfalls

- **The skill directory at `~/.agents/skills/cortex/` is wiped and regenerated** from the binary's embedded copy. Any hand-edits to `SKILL.md`, `cli/*.md`, or `recipes/*.md` are **LOST**. Edit the cortex source repo and rebuild if you need permanent changes.
- **`reset` is NOT how you pick up schema changes.** Older cortex DBs were created with a 200- or 1024-char summary `CHECK`; the current schema allows 4096. Schema changes ship as migrations: `cortex doctor` lists them as pending and [`cortex init`](init.md) applies them safely (backup, rebuild, validate) with all data kept. Reaching for `reset` instead throws away **every task and update** for nothing.
- The `RESET` confirmation is **case-sensitive and must match exactly**. `reset`, `Reset`, or whitespace around it all abort.
- `reset` stops the daemon via `SIGTERM` and waits up to ~1s. If the daemon ignores `SIGTERM`, the pid/url state files are still removed — start a new `cortex serve` afterwards.

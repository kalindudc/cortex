# `cortex reset`

Stop the daemon serving THIS database (if any), wipe the SQLite database and its WAL sidecars, and re-initialize an empty DB with the default `now` lane. Datastore only: agent skills and the pi extension belong to [`cortex agents reset`](agents.md).

This is **destructive and irreversible**. All tasks, updates, and lane history are gone.

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
  • stop the cortex daemon serving this database (pid 41218)
  • delete /Users/you/.config/cortex/cortex.db
  • delete /Users/you/.config/cortex/cortex.db-wal, ...-shm (SQLite WAL sidecars, if present)
  • remove stale daemon metadata/socket for this database, if present (keeping /Users/you/.config/cortex/cortex.db.owner.lock)
  • re-initialize an empty database with the default 'now' lane
Type RESET to confirm: RESET
✓ stopped daemon
✓ wiped database files
✓ re-initialized /Users/you/.config/cortex/cortex.db
✓ reset complete
→ agent skills and the pi extension are untouched; `cortex agents reset` resets them
```

## How it shuts things down

- Nothing is held while you type the confirmation.
- The daemon is stopped exactly: reset finds this database's daemon again after the prompt, asks it to shut down over its private socket, and waits until it releases the database. It never signals a pid, and daemons of other databases (another `CORTEX_DB`) keep running.
- Reset then owns the database (the `<db>.owner.lock` lease) from the wipe through the re-initialization, so no other cortex command can open it half-way. The lock file itself is never deleted.
- If the daemon has not released the database (its lease) by the stop timeout, reset stops with an error and wipes nothing. A daemon that starts serving the database during the reset also makes it stop (`cortex stop`, then retry).
- Open terminal workspaces (TUIs) are clients, not owners: they report the lost daemon and reattach when a daemon serves the database again. The reset database has a new identity, so their unsaved drafts are never written into it.

## Pitfalls

- **Agent skills and the pi extension are NOT touched.** `reset` wipes only the datastore; [`cortex agents reset`](agents.md) wipes and reinstalls the agent tools (hand-edits there are LOST).
- **`reset` is NOT how you pick up schema changes.** Older cortex DBs were created with a 200- or 1024-char summary `CHECK`; the current schema allows 4096. Schema changes ship as migrations: `cortex doctor` lists them as pending and [`cortex init`](init.md) applies them safely (backup, rebuild, validate) with all data kept. Reaching for `reset` instead throws away **every task and update** for nothing.
- The `RESET` confirmation is **case-sensitive and must match exactly**. `reset`, `Reset`, or whitespace around it all abort.
- A daemon started by an OLDER cortex binary (it wrote `cortex.pid`/`cortex.url`) cannot be verified, so reset refuses before prompting. Stop it yourself (Ctrl+C in its terminal), then reset.

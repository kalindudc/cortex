# `cortex serve`

Run the daemon for THIS database (`CORTEX_DB`, else `~/.config/cortex/cortex.db`) on a private Unix socket that every CLI command (and TUI) talks to. There is no TCP listener. The daemon owns the database for its whole life (the `<db>.owner.lock` lease) and publishes `<db>.daemon.json` beside the database once it is ready; there are no pid or URL files.

The terminal workspace (plain `cortex`, or `cortex tui`) starts this daemon in the background when none runs. Quitting a TUI never stops the daemon.

## Usage

```bash
cortex serve [--foreground]
```

## Args

| Flag | Alias | Default | Description |
|---|---|---|---|
| `--foreground` | — | `false` | Run attached to the current shell (Ctrl+C to stop) instead of detaching. |

The web flags of older binaries (`--port`, `--host`, `--open`, `--no-open`, `--no-web`) are ignored.

## Example

```bash
$ cortex serve
✓ cortex serving at /tmp/cortex-501/cortex-3f9a1c2b7d4e6f80.sock (pid 41218)
```

In the foreground the line is `cortex listening on <socket>`. The success line prints only once the daemon is ready (its metadata is published). A second `cortex serve` for the same database attaches to the running daemon instead of starting another; `--foreground` refuses with "already serving".

While the daemon runs, every command (`cortex add`, `cortex update`, `cortex ls`, ...) goes through it, so open TUIs see CLI writes live. Without a daemon, each command owns the database just for its own work.

## Stopping the daemon

- **Foreground:** Ctrl+C. The `SIGINT`/`SIGTERM` handler closes the listener, removes its own metadata and socket, closes the DB and releases the lease last.
- **Detached:** `cortex stop` (with the same `CORTEX_DB`). It stops exactly this database's daemon through its socket; daemons of other databases keep running. It never signals a pid.
- **`cortex reset`** also stops this database's daemon before wiping the DB.

## Pitfalls

- **The private socket is the security boundary. There are no bearer tokens.** The socket is owner-only (`0600`) in a private (`0700`) runtime directory (`XDG_RUNTIME_DIR`, else `<tmpdir>/cortex-<uid>`). Do not expose it (for example with `socat` or an SSH forward) — anyone reaching it has full CRUD on every task.
- One daemon per database. Different databases (different `CORTEX_DB`) get independent daemons.
- A daemon started by an OLDER cortex binary (one that wrote `cortex.pid`/`cortex.url`) cannot be verified: every command refuses to run beside it with a restart instruction. Stop it (Ctrl+C in its terminal) and start `cortex serve` with this binary.
- Never delete `<db>.owner.lock`: it is the ownership lease file, and a new one would admit a second owner.
- Open TUIs signal (status-line flash, optional bell) only on transitions into `blocked` status (not on `done`, not on routine updates).

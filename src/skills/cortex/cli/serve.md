# `cortex serve`

Run the daemon for THIS database (`CORTEX_DB`, else `~/.config/cortex/cortex.db`): a private Unix socket that every CLI command (and TUI) talks to, plus the browser dashboard and JSON API on `127.0.0.1`. The daemon owns the database for its whole life (the `<db>.owner.lock` lease) and publishes `<db>.daemon.json` beside the database once it is ready; there are no pid or URL files. It is headless: it never opens a browser unless you pass `--open`.

The terminal workspace (plain `cortex`, or `cortex tui`) starts this daemon in the background with `--no-web` (socket only) when none runs; `cortex open`, or the TUI's `:preview`, later enables the dashboard on that SAME daemon. Quitting a TUI never stops the daemon.

## Usage

```bash
cortex serve [-p <port>] [--foreground] [--open | --no-open] [--no-web] [--host <name>]
```

## Args

| Flag | Alias | Default | Description |
|---|---|---|---|
| `--port` | `-p` | `7777` | Dashboard TCP port on `127.0.0.1`. Use `0` to pick a free port. |
| `--foreground` | — | `false` | Run attached to the current shell (Ctrl+C to stop) instead of detaching. |
| `--open` | — | `false` | Open the dashboard in a browser once it is serving. |
| `--no-open` | — | — | Stay headless (the default; kept for compatibility). |
| `--no-web` | — | — | Serve only the private socket, no dashboard. `cortex open` can enable the dashboard later on the same daemon. |
| `--host` | — | `cortex.localhost` | User-facing hostname for the printed URL. The server still binds `127.0.0.1`. |

## Example

```bash
$ cortex serve
✓ cortex serving at http://cortex.localhost:7777 (pid 41218)
```

The success line prints only once the daemon is ready (its metadata is published). A second `cortex serve` for the same database attaches to the running daemon instead of starting another; `--foreground` refuses with "already serving".

`cortex.localhost` works in modern browsers (Chrome, Firefox, Edge) without any DNS setup per RFC 6761 §6.3 — names ending in `.localhost` are guaranteed to resolve to the loopback address. Safari relies on the macOS system resolver, which does not auto-resolve `*.localhost`; Safari users may need a `/etc/hosts` entry or the `--host` override below. The CLI never uses that URL: it reaches the daemon over the private socket named in `<db>.daemon.json`.

While the daemon runs, every command (`cortex add`, `cortex update`, `cortex ls`, ...) goes through it, so dashboard and TUI clients see CLI writes live. Without a daemon, each command owns the database just for its own work.

### Using a custom hostname (`cortex.home.arpa`, etc.)

Add a `/etc/hosts` entry pointing the name to `127.0.0.1`, then start cortex with `--host`:

```bash
echo "127.0.0.1 cortex.home.arpa" | sudo tee -a /etc/hosts
cortex serve --host cortex.home.arpa
```

## Stopping the daemon

- **Foreground:** Ctrl+C. The `SIGINT`/`SIGTERM` handler closes the listeners, removes its own metadata and socket, closes the DB and releases the lease last.
- **Detached:** `cortex stop` (with the same `CORTEX_DB`). It stops exactly this database's daemon through its socket; daemons of other databases keep running. It never signals a pid.
- **`cortex reset`** also stops this database's daemon before wiping the DB.

## Pitfalls

- **Localhost-only bind is the security boundary. There are no bearer tokens.** The server binds to `127.0.0.1` and refuses non-loopback connections. Do not put cortex behind a reverse proxy, an SSH `-L` tunnel that exposes it elsewhere, or `socat` to a public interface — anyone reaching the port has full CRUD on every task.
- If port `7777` is taken, `serve` fails fast. Re-run with `-p 0` to auto-pick or `-p <other>`. The CLI follows the daemon automatically; your browser tab does not.
- One daemon per database. Different databases (different `CORTEX_DB`) get independent daemons.
- A daemon started by an OLDER cortex binary (one that wrote `cortex.pid`/`cortex.url`) cannot be verified: every command refuses to run beside it with a restart instruction. Stop it (Ctrl+C in its terminal) and start `cortex serve` with this binary.
- Never delete `<db>.owner.lock`: it is the ownership lease file, and a new one would admit a second owner.
- Browser notifications require the dashboard tab to be open and notification permission granted. The notification fires only on transitions into `blocked` status (not on `done`, not on routine updates); open TUIs flash their status line on the same transitions.

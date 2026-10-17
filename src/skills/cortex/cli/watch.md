# cortex watch

Follow every change to THIS database (`CORTEX_DB`, else `~/.config/cortex/cortex.db`) as a stream of one-line events. A client such as an editor panel uses it to stay in sync without polling. `watch` starts the database's daemon in the background when none runs, or attaches to the running one; exiting `watch` never stops the daemon.

## Usage

```bash
cortex watch [--json]
```

## Args

| Flag | Alias | Default | Description |
|---|---|---|---|
| `--json` | — | `false` | One JSON object per line instead of the short human line. |

## Line protocol (`--json`)

Each change is one line with its event kind, the stream cursor and the event payload:

```json
{"kind":"update.posted","cursor":"3f9a1c2b:12","payload":{"id":88,"task_id":1,"author":"bb-thr_2qj8qzdqqr","summary":"tests pass"}}
```

Kinds are the daemon's own events: `task.added`, `task.updated`, `task.removed`, `update.posted`, `lane.changed`, `tag.changed`, `notification.added`, `notification.changed` and `task.blocked`.

Two short markers carry no payload:

- `{"kind":"ready"}` prints on every connection, including each reconnect after the daemon restarts.
- `{"kind":"resync"}` prints when events were missed.

There is no replay of missed events. After either marker, refetch the state you show (for example `cortex ls --json`), then apply the lines that follow.

## Human output

Without `--json`, each change is one short line such as `update.posted @1 [bb-thr_2qj8qzdqqr] tests pass`, and the markers read `ready (refetch state)` and `resync (refetch state)`.

## Exit

`watch` runs until it receives SIGINT (Ctrl+C) or SIGTERM, or until the reader closes its stdout (for example `cortex watch --json | head -n 5`). Each of those exits 0. Any other failure, such as a daemon that cannot start, exits 1 with an error.

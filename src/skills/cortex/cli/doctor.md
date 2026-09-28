# `cortex doctor`

One-call orientation/health check. Strictly read-only: it reports the daemon through discovery (the `<db>.daemon.json` metadata, verified over the daemon's socket) and reads the database through a readonly snapshot, so it works the same with or without a running daemon. It never starts a daemon, never creates or migrates the database, and never waits for another command's ownership lease.

## Usage

```bash
cortex doctor          # human summary
cortex doctor --json   # machine-readable report
```

## JSON shape

```jsonc
{
  "version": "0.2.0",
  "dbPath": "/Users/you/.config/cortex/cortex.db",
  "initialized": true,              // false: no database yet (run `cortex init`)
  "daemon": { "running": false, "url": null },
  "pendingMigrations": [],
  "counts": { "tasks": 42, "lanes": 3, "tags": 7 }
}
```

With a daemon serving the database, `daemon` is `{ "running": true, "url": "<dashboard URL, or null when headless>", "pid": 41218, "socket": "<private socket>" }`. A daemon the terminal workspace (`cortex tui`) started is headless: `url` stays `null` until `cortex open` (or the TUI's `:preview`) enables its dashboard. A daemon from an older cortex binary shows up as `"legacy": { "pid", "url" }` (stop it and restart with this binary: every other command refuses to run beside it), and a discovery problem as `"error"`.

## When to use

- First thing in a fresh shell: confirm which database you're pointed at (`dbPath`, `initialized`) and whether a daemon serves it (`daemon.running`).
- Before a migration-sensitive change: check `pendingMigrations` (run `cortex init` to apply them safely).
- Quick sanity that the store is reachable and populated (`counts`).

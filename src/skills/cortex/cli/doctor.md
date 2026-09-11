# `cortex doctor`

One-call orientation/health check. Works WITH or WITHOUT a running daemon — it opens the SQLite file read-only rather than requiring the HTTP surface, so it never fails just because the daemon is down.

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
  "daemon": { "running": false, "url": null },
  "pendingMigrations": [],
  "counts": { "tasks": 42, "lanes": 3, "tags": 7 }
}
```

## When to use

- First thing in a fresh shell: confirm which database you're pointed at (`dbPath`) and whether a daemon is serving the dashboard (`daemon.running`).
- Before a migration-sensitive change: check `pendingMigrations` (run `cortex init` to apply them safely).
- Quick sanity that the store is reachable and populated (`counts`).

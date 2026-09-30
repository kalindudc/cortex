# `cortex init`

Initialize (or migrate) the cortex SQLite database under `~/.config/cortex/cortex.db` and create the default `now` lane. `init` touches ONLY the datastore: agent skills and the pi extension are installed by [`cortex agents install`](agents.md).

## Usage

```bash
cortex init
cortex agents install   # skills + pi extension (when pi is installed)
```

## Args

None. `init` is idempotent: a second run keeps every task and applies only pending migrations.

## Example

```bash
$ cortex init
✓ initialized /Users/you/.config/cortex/cortex.db
→ agent skills and the pi extension: run `cortex agents install`
```

After this the CLI is ready to use. Run `cortex agents install` so AI agents reading `~/.agents/skills/` see the latest cortex skills.

## Pitfalls

- `init` no longer writes skills or the pi extension. Upgrading the binary and re-running `init` does NOT refresh them: run [`cortex agents install`](agents.md) (or `cortex agents reset` to also drop stale files).
- `init` IS the migration path for an existing DB. When the schema changes (e.g. the summary `CHECK` cap went 200 → 1024 → 4096), every command warns `database migrations pending (...)`, [`cortex doctor`](doctor.md) lists them, and `init` applies them safely: it backs the DB up (`VACUUM INTO`), rebuilds the affected table, validates row counts + integrity, and only then drops the old table. Data is kept; `✓ migration applied: <name>` is printed per migration. Do NOT use [`cortex reset`](reset.md) for this — it wipes everything.
- `init` does NOT start the daemon. Run [`cortex serve`](serve.md) (or just `cortex`) to start the daemon.

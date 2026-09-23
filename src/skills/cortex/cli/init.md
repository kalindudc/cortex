# `cortex init`

Initialize the cortex SQLite database under `~/.config/cortex/cortex.db`, create the default `now` lane, and (re)write the embedded skill files at `~/.agents/skills/cortex/`.

## Usage

```bash
cortex init
```

## Args

None. `init` is idempotent on a healthy DB but is destructive to the on-disk skill (see Pitfalls).

## Example

```bash
$ cortex init
✓ initialized /Users/you/.config/cortex/cortex.db
```

After this, both the CLI is ready to use and any AI agent reading from `~/.agents/skills/cortex/` will see the latest cortex skill.

## Pitfalls

- **The skill at `~/.agents/skills/cortex/` is machine-generated.** `cortex init` writes the skill files embedded in the binary. Re-running `cortex init` (or upgrading the cortex binary and running `init` again) **OVERWRITES the skill directory**. Any hand-edits to `~/.agents/skills/cortex/SKILL.md`, `cli/*.md`, or `recipes/*.md` are **LOST**. To customize the skill, edit it in the cortex source repo and rebuild the binary.
- `init` IS the migration path for an existing DB. When the schema changes (e.g. the summary `CHECK` cap went 200 → 1024 → 4096), every command warns `database migrations pending (...)`, [`cortex doctor`](doctor.md) lists them, and `init` applies them safely: it backs the DB up (`VACUUM INTO`), rebuilds the affected table, validates row counts + integrity, and only then drops the old table. Data is kept; `✓ migration applied: <name>` is printed per migration. Do NOT use [`cortex reset`](reset.md) for this — it wipes everything.
- `init` does NOT start the daemon. Run [`cortex serve`](serve.md) afterwards to bring up the dashboard.

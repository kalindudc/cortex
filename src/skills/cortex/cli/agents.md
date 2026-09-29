# `cortex agents`

Install or reset cortex's agent tooling: every shipped skill (under
`~/.agents/skills`, harness-neutral) plus the pi extension (under pi's agent
dir) when pi is present. `cortex init` and `cortex reset` NEVER touch agent
tools; they manage only the datastore.

## Usage

```bash
cortex agents install [--json]
cortex agents reset [--force] [--json]
```

## Args

| Command | Behaviour |
|---|---|
| `install` | Write (overwrite) every skill, plus the pi extension when pi is detected. Extra files already in those dirs are kept. |
| `reset` | Wipe each cortex-owned skill dir and the extension dir, then install. Requires typing `RESET` unless `--force`; `--json` REQUIRES `--force` (it refuses to prompt). |

pi counts as present when any of these holds: `CORTEX_PI_EXTENSION_DIR` is set
(an explicit target), `pi` is on PATH, or pi's agent dir exists
(`PI_CODING_AGENT_DIR`, else `~/.pi/agent`). Otherwise the extension is skipped
and the skip is reported. pi discovers `<agent dir>/extensions/cortex/index.ts`
on its next start; there is no enable step.

`--json` prints `{ skills: [{ name, dir }], extensions: [{ name, dir }], skipped: [{ name, reason }] }`.

## Example

```bash
$ cortex agents install
✓ skill cortex → /Users/you/.agents/skills/cortex
✓ skill cortex-planner → /Users/you/.agents/skills/cortex-planner
✓ skill cortex-implementer → /Users/you/.agents/skills/cortex-implementer
✓ skill cortex-research → /Users/you/.agents/skills/cortex-research
✓ pi extension → /Users/you/.pi/agent/extensions/cortex/index.ts
```

## Pitfalls

- The installed files are machine-generated. Hand-edits are LOST on `install` (overwritten) and `reset` (wiped). Edit the cortex source repo and rebuild instead.
- Only the cortex-owned dirs are touched (`~/.agents/skills/cortex*`, `<agent dir>/extensions/cortex`); other skills and extensions are left alone.
- Upgrading the cortex binary does not refresh installed skills: run `cortex agents install` after an upgrade (`reset` also drops files removed by the upgrade).
- `init`/`reset` never touch agent tools, and `agents` never opens the database.

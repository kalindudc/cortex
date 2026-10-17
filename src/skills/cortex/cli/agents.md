# `cortex agents`

Install or reset cortex's agent tooling: every shipped skill (under
`~/.agents/skills`, harness-neutral), the pi extension (under pi's agent dir)
when pi is present, and the bb plugin when bb is present and running.
`cortex init` and `cortex reset` NEVER touch agent tools; they manage only the
datastore.

## Usage

```bash
cortex agents install [--json]
cortex agents reset [--force] [--json]
```

## Args

| Command | Behaviour |
|---|---|
| `install` | Write (overwrite) every skill, plus the pi extension when pi is detected and the bb plugin when bb is. Extra files already in those dirs are kept. |
| `reset` | Wipe each cortex-owned skill dir and the extension dir, remove the bb plugin from bb and wipe its dir, then install. Requires typing `RESET` unless `--force`; `--json` REQUIRES `--force` (it refuses to prompt). |

pi counts as present when any of these holds: `CORTEX_PI_EXTENSION_DIR` is set
(an explicit target), `pi` is on PATH, or pi's agent dir exists
(`PI_CODING_AGENT_DIR`, else `~/.pi/agent`). Otherwise the extension is skipped
and the skip is reported. pi discovers `<agent dir>/extensions/cortex/index.ts`
on its next start; there is no enable step.

bb is found by the first of: `CORTEX_BB_CLI` (a path, or an empty string to
turn bb off), `BB_CLI` (set inside bb threads), `bb` on PATH, then
`~/.bb/bin/bb`. The plugin's source ships inside the cortex binary: `install`
writes it to `~/.config/cortex/bb-plugin`, runs `npm ci` there (runtime
dependencies only) when its dependencies are not installed for this version,
and registers the directory with bb (`bb plugin install path:<dir>`, which
also moves a plugin installed from another path and keeps its settings), or
reloads it when files changed. It never changes the plugin's settings and
shows `cortexPath` when it is set. It skips, and exits 0, when bb is not
found, bb is not running, or the plugin was installed from git or npm (only
`reset` replaces that). `reset` removes the plugin from bb, which deletes its
settings. An npm or bb error is reported and exits 1, after the skills and pi
extension are written.

`--json` prints `{ skills: [{ name, dir }], extensions: [{ name, dir }], skipped: [{ name, reason }], bb }`, where
`bb` is `{ status, dir?, reason?, from?, plugin? }`: `status` is `installed`, `reloaded`, `unchanged`, `skipped`
or `failed`; `from` is the source a moved plugin came from; `plugin` is `{ status, statusDetail?, cortexPath? }`
as bb reports it afterwards.

## Example

```bash
$ cortex agents install
✓ skill cortex → /Users/you/.agents/skills/cortex
✓ skill cortex-planner → /Users/you/.agents/skills/cortex-planner
✓ skill cortex-implementer → /Users/you/.agents/skills/cortex-implementer
✓ skill cortex-research → /Users/you/.agents/skills/cortex-research
✓ pi extension → /Users/you/.pi/agent/extensions/cortex/index.ts
✓ bb plugin installed → /Users/you/.config/cortex/bb-plugin (running)
```

## Pitfalls

- The installed files are machine-generated. Hand-edits are LOST on `install` (overwritten) and `reset` (wiped). Edit the cortex source repo and rebuild instead.
- Only the cortex-owned dirs are touched (`~/.agents/skills/cortex*`, `<agent dir>/extensions/cortex`, `~/.config/cortex/bb-plugin`) plus bb's record of the `cortex` plugin; other skills, extensions and plugins are left alone.
- `reset` clears the bb plugin's settings (such as `cortexPath`); set them again with `bb plugin config cortex set <key> <value>`.
- Upgrading the cortex binary does not refresh installed skills: run `cortex agents install` after an upgrade (`reset` also drops files removed by the upgrade).
- `init`/`reset` never touch agent tools, and `agents` never opens the database.

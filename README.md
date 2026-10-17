# cortex

A local task tracker for one engineer supervising several AI coding agents at once.

Your agents post progress, status changes and plans to cortex from the command line. You watch all of it live in a
terminal workspace, and cortex interrupts you only when an agent is blocked. Tasks double as memory, so the next
agent session picks up where the last one stopped.

- One self-contained binary: the CLI, the terminal workspace and a small background daemon.
- Local and private: one SQLite file under `~/.config/cortex`, a private Unix socket, no network listener, no accounts.
- Live: a change from any agent or window shows up in every open workspace at once.
- Built for agents: stable `--json` output, attributed updates, installable agent skills and a pi extension.

> Contributing, or an AI agent working on this repo? Start with [AGENTS.md](./AGENTS.md) and run
> `pnpm run docs:check` before pushing.

## Install

cortex builds from source with pnpm. Bun comes in as a dev dependency, so there is nothing else to install.

```bash
pnpm install --frozen-lockfile
pnpm run build             # writes bin/cortex
pnpm run deploy            # optional: rebuild and copy it to ~/bin/cortex
cortex init                # create ~/.config/cortex/cortex.db
cortex agents install      # agent skills, plus the pi extension and bb plugin when installed
```

## bb plugin

In bb, the Cortex plugin shows each thread's task in a side-panel tab and a header chip, and gives threads on providers
other than pi the Cortex memory tools. `cortex agents install` installs it when bb is installed and running (it needs
npm); `cortex agents reset` replaces a plugin installed another way. See [bb setup and behavior](docs/bb.md).

## Quick start

```bash
cortex add "ship plan 1" -p 0                                     # a task; priority 0 is the highest
cortex update 1 -m "tests pass" -s review --as my-agent-1a2b3c4d  # what an agent posts
cortex ls                                                         # tasks by lane
cortex                                                            # open the terminal workspace
```

## How you use it

- Agents work through the CLI, usually with `--json`. A bb thread identifies itself; outside bb, agents use
  the pi tool or explicit `--as`. `cortex agents install` teaches agents the conventions.
- A task moves through draft, open, review, blocked and done. Only a move into blocked interrupts you: the
  workspace's status line flashes, and the terminal bell can too.
- You read, edit and triage in the terminal workspace: plain `cortex`, then `?` for help.
  [The terminal workspace](docs/tui.md) walks through it.
- Agents keep their working state in task bodies and find it again next session.
  [Agent memory](docs/memory.md) explains how, with or without pi.

Your data is one file, `~/.config/cortex/cortex.db` (`CORTEX_DB` points cortex at another one). Never delete the
`cortex.db.owner.lock` file beside it. [How cortex works](docs/architecture.md) covers the daemon, storage and what
happens when several agents write at once.

## Reference

The reference lives in the program, so it is always current:

- `cortex --help` and `cortex <command> --help`: every command and flag.
- `cortex schema`: the data model and the command grammar, written for agents.
- `cortex doctor`: version, database path, daemon state and pending migrations, without changing anything.
- In the workspace, `?` or `:help`: every mode, command, key and `tui.toml` setting.

## Development

`pnpm run dev` runs cortex from source against a sandbox in `tmp/dev/` with its own config and database, so
unreleased code never touches your real data.

```bash
pnpm run dev                                            # the workspace from source
pnpm run dev -- ls --json                               # any command from source
pnpm run dev -- init && pnpm run dev -- agents install  # seed the sandbox once
CORTEX_DEV_HOME=/tmp/cx pnpm run dev                    # a different sandbox
CORTEX_DEV_REAL=1 pnpm run dev                          # your real data (stop the installed daemon first)
```

Commands, tests, conventions and the checks to run before a PR are in [AGENTS.md](AGENTS.md).

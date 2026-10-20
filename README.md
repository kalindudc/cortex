# cortex

A local task tracker for one engineer supervising several AI coding agents at once.

Your agents post progress, status changes and plans to cortex from the command line. You watch all of it live in a
desktop app, and cortex interrupts you only when an agent is blocked. Tasks double as memory, so the next
agent session picks up where the last one stopped.

- The CLI and a small background daemon in one binary, and the desktop app that plain `cortex` opens.
- Local and private: one SQLite file under `~/.config/cortex`, a private Unix socket, no network listener, no accounts.
- Live: a change from any agent or window shows up in every open app window at once.
- Built for agents: stable `--json` output, attributed updates, installable agent skills and a pi extension.

> Contributing, or an AI agent working on this repo? Start with [AGENTS.md](./AGENTS.md) and run
> `pnpm run docs:check` before pushing.

## Install

cortex builds from source with pnpm. Bun comes in as a dev dependency, so there is nothing else to install.

```bash
pnpm install --frozen-lockfile
pnpm run build             # writes bin/cortex
pnpm run deploy            # optional: install the CLI and desktop app locally
cortex init                # create ~/.config/cortex/cortex.db
cortex agents install      # agent skills, plus the pi extension and bb plugin when installed
```

## bb plugin

In bb, the Cortex plugin shows each thread's task in a side-panel tab and a header chip, and gives threads on providers
other than pi the Cortex memory tools. It also shows each thread's memory in the prompt box and a Memory tab, where
you can switch memory per thread. `cortex agents install` installs it when bb is installed and running (it needs
npm); `cortex agents reset` replaces a plugin installed another way. See [bb setup and behavior](docs/bb.md).

## Desktop app

`pnpm run desktop:dist` packages the desktop app into `integrations/desktop/dist/`: on macOS a dmg and a zip for Apple
silicon and for Intel, on Linux an AppImage and a deb. Install it by dragging `Cortex.app` to Applications (or
unzipping it into `~/Applications`), or on Linux by installing the deb or putting the AppImage in `~/Applications`.
`cortex app [id]` then opens it, at that task if you name one. The app starts its own daemon on your database and
leaves it running when you quit. Packages are signed ad hoc, so a copy downloaded from elsewhere needs a right-click
and Open the first time.

## Quick start

```bash
cortex add "ship plan 1" -p 0                                     # a task; priority 0 is the highest
cortex update 1 -m "tests pass" -s review --as my-agent-1a2b3c4d  # what an agent posts
cortex ls                                                         # tasks by lane
cortex                                                            # open the desktop app
```

## How you use it

- Agents work through the CLI, usually with `--json`. A bb thread identifies itself; outside bb, agents use
  the pi tool or explicit `--as`. `cortex agents install` teaches agents the conventions; after an upgrade,
  `cortex agents status` or the desktop app's Agent tools panel shows what is out of date.
- A task moves through draft, open, review, blocked and done. Only a move into blocked interrupts you: the
  desktop app shows a system notification.
- You read, edit and triage in the desktop app: plain `cortex` opens it.
  [The desktop app](docs/desktop.md) walks through it.
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
- In the desktop app, the Settings panel: every command, shortcut and setting.

## Development

`pnpm run dev` runs cortex from source against a sandbox in `tmp/dev/` with its own config and database, so
unreleased code never touches your real data.

```bash
pnpm run desktop:dev                                    # the desktop app from source, on the same sandbox
pnpm run dev -- ls --json                               # any command from source
pnpm run dev -- init && pnpm run dev -- agents install  # seed the sandbox once
CORTEX_DEV_HOME=/tmp/cx pnpm run desktop:dev            # a different sandbox
CORTEX_DEV_REAL=1 pnpm run desktop:dev                  # your real data (stop the installed daemon first)
```

Commands, tests, conventions and the checks to run before a PR are in [AGENTS.md](AGENTS.md).

<p align="center">
  <img src="integrations/desktop/build/icon.png" alt="The cortex icon" width="112">
</p>

<h1 align="center">cortex</h1>

<p align="center">A local task tracker for one engineer supervising several AI coding agents at once.</p>

Your agents post progress, status changes and plans to cortex from the command line. You watch it all live in the
desktop app, and cortex interrupts you only when an agent is blocked. Tasks double as memory, so the next agent
session picks up where the last one stopped.

![The desktop app: the task list by lane, an agent's plan with its diagram, and the agents that worked on it](docs/images/tasks.png)

- **One binary.** The CLI and a small background daemon; plain `cortex` opens the desktop app.
- **Local and private.** One SQLite file under `~/.config/cortex`, a private Unix socket, no network listener, no
  accounts.
- **Live.** A change from any agent shows up in every app window at once.
- **Made for agents.** Stable `--json` output, updates credited to each agent session, and skills, a pi extension and a
  bb plugin that teach agents the conventions.

## Install

On macOS or Linux:

```bash
curl -fsSL https://github.com/kalindudc/cortex/releases/latest/download/install.sh | sh
cortex init            # create your database
cortex agents install  # teach your agents: skills, plus pi and bb support if you use them
```

Then run `cortex` to open the app. The script installs the `cortex` CLI into `~/.local/bin` and the desktop app of the
same version: into `/Applications` on macOS, with apt on Debian and Ubuntu, and as an AppImage in `~/Applications`
elsewhere. It checks every file against the release's checksums first. Set `CORTEX_VERSION` for another version,
`CORTEX_BIN_DIR` for another folder, or `CORTEX_NO_APP=1` for the CLI alone. Run it again to upgrade; it also restarts
the cortex daemon on the new version.

With Homebrew, `brew install kalindudc/tap/cortex` installs the CLI on macOS or Linux (the full name matters, because
Homebrew's own `cortex` is an unrelated project); after `brew upgrade`, run `cortex stop`. Every package is also on the
[releases page](https://github.com/kalindudc/cortex/releases), for example a deb for
`sudo apt install ./Cortex-<version>-linux-amd64.deb`. The macOS app is not signed by Apple yet, so a dmg downloaded
in a browser opens only after Open Anyway in System Settings, under Privacy & Security.

## Quick start

```bash
cortex add "ship the login page" -p 0                             # a task; priority 0 is the highest
cortex update 1 -m "tests pass" -s review --as my-agent-1a2b3c4d  # what an agent posts
cortex                                                            # watch it in the desktop app
```

A task moves through draft, open, review, blocked and done. Only a move into blocked raises a notification.

<p align="center">
  <img src="docs/images/activity.png" alt="A task's Activity: every update its agents posted, beside the Inbox of status changes" width="49%">
  <img src="docs/images/split.png" alt="Split view: a task's Markdown in the editor beside its rendered preview and outline" width="49%">
</p>
<p align="center"><sub>Left: everything the agents posted on a task, and the Inbox of status changes. Right: a task's
Markdown beside its preview.</sub></p>

## Learn more

- [The desktop app](docs/desktop.md): reading, editing and triaging tasks, and how the app is built.
- [Agent memory](docs/memory.md): how agents keep and find their working state, with or without pi.
- [Cortex in bb](docs/bb.md): each thread's task beside the conversation, and memory tools for every provider.
- [How cortex works](docs/architecture.md): the daemon, where your data lives, and what happens when agents collide.
- `cortex --help`, `cortex schema` and `cortex doctor`: every command, the data model for agents, and a health check.

## Development

You need Node.js and pnpm; Bun comes in as a dev dependency. After `pnpm install --frozen-lockfile`,
`pnpm run desktop:dev` and `pnpm run dev -- <command>` run cortex from source on a sandbox in `tmp/dev/`, so
unreleased code never touches your real data. `pnpm run desktop:dist` packages the desktop app, and `pnpm run deploy`
installs your build into `~/bin` (keep it on your PATH) through the same install script users run. [AGENTS.md](AGENTS.md) has the commands, tests, conventions and the
checks to run before a PR.

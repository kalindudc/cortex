# Changelog

Cortex follows [semantic versioning](https://semver.org). Each release has a section below, newest first.

## 0.99.1 - 2026-10-21

- **Cortex in bb for every provider.** The bb plugin gives pi, Claude Code, Codex and every other provider the same
  `cortex_update` and `cortex_recall` tools, usage notes and memory summary. Inside bb the pi extension steps aside
  for the plugin; plain pi, and a `pi -p` run from a bb thread's shell, keep the extension as before.
- **Recall and saving in bb.** A thread's first request, or one that asks about earlier work, brings the matching
  tasks as a hidden message in pi, Claude Code and Codex threads. After a request that changed files and saved
  nothing, a thread that saves memory gets one hidden save turn, as in plain pi.
- **Skills for Claude Code.** The bb plugin carries the cortex skills and gives them to Claude Code threads, which do
  not read `~/.agents/skills`.

## 0.99.0 - 2026-10-21

The first public release.

- **CLI and daemon.** One `cortex` binary for tasks with lanes, tags, priorities and the draft, open, review, blocked
  and done statuses. Every update is credited to the agent session or person that posted it, and every command has
  stable `--json` output. A small daemon serves your database over a private Unix socket, so every client sees each
  change live. Backup and restore are built in.
- **Desktop app.** The task list by lane, a Markdown editor beside its preview, each task's activity, an inbox of status
  changes and a command palette, for macOS and Linux. It raises a notification only when an agent is blocked.
- **Agent memory.** Tasks double as memory, so an agent can search and load what earlier sessions left. You can keep
  chosen tasks out of memory.
- **Agent integrations.** `cortex agents install` adds the cortex skills, plus the pi extension and the bb plugin when
  you use them.
- **Packages.** Each GitHub Release has the CLI for macOS and Linux on x64 and arm64, the desktop app as a dmg and a
  zip for macOS and as an AppImage and a deb for Linux, a checksum file and an install script. A Homebrew formula
  installs the CLI with `brew install kalindudc/tap/cortex`.

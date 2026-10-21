# Changelog

Cortex follows [semantic versioning](https://semver.org). Each release has a section below, newest first.

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

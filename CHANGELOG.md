# Changelog

Cortex follows [semantic versioning](https://semver.org). Each release has a section below, newest first.

## 0.101.1 - 2026-10-21

- **A paper look for the desktop app.** The app now looks like paper on a desk. The document and the full panels
  (Settings, Lanes, Tags, Backup and Agent tools) are sheets with a faint dot grid and slightly uneven edges, and the
  side panel's sections are plain cards. Dark mode becomes night paper, a warm charcoal; high contrast keeps its 7:1
  text and drops the grain and dots.
- **Writing type.** Titles, prose, task names and agent updates are set in Literata. The Markdown editor uses
  iA Writer Mono with faint line numbers, so tables and lists still line up. Both fonts ship with the app and never
  load from the network.
- **Activity reads like notes.** Each update is a dated note down one page instead of a boxed card, with the
  composer at the end.
- **Hand-drawn diagrams.** Mermaid diagrams are drawn in a pen-sketch style in the current palette's ink, and redraw
  when you switch between dark and high contrast.
- 0.101.0 was tagged but never published: two of its new narrow-window desktop tests measured the layout on Linux
  before the app had switched to it. The tests now wait for the switch; the app itself is unchanged.

## 0.101.0 - 2026-10-21

Tagged but not published; its changes ship in 0.101.1.

## 0.100.0 - 2026-10-21

- **The desktop app alone.** The install script takes `CORTEX_NO_CLI=1` to install only the desktop app, for when
  Homebrew provides the CLI. It then restarts the daemon with the `cortex` already on your PATH.
- **Homebrew.** After `brew install`, the formula prints the command that installs the desktop app of the same
  version. The README now taps first (`brew tap kalindudc/tap`), because current Homebrew installs only from taps you
  have added.

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

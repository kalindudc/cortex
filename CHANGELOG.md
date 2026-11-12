# Changelog

Cortex follows [semantic versioning](https://semver.org). Each release has a section below, newest first.

## 0.105.3 - 2026-11-12

- **Draft from a thread works on Pi and Claude Code threads.** Those threads list finished messages without grouping
  them into turns, so drafting found nothing to use. Cortex now confirms each turn finished from bb's own record of
  it, and still leaves out unfinished and interrupted turns. A thread's first message is still left out, because bb
  gives it no turn to check against. Messages sent while a turn was running are accepted too.
- **Choosing a source thread is clear.** The chosen thread is marked, the list scrolls when a section has many
  threads, and a refusal appears beside the list instead of below the dialog.
- **The context row stays put.** It no longer disappears after Cortex reloads while memory is on, and it stays above
  the composer in wide panes, where bb's context card can be closed.

## 0.105.2 - 2026-11-11

- **The context row never clips its text.** When the composer row is crowded, the Cortex summary shows the full
  line, then just "Cortex", then only its icon, choosing by what actually fits instead of fixed widths. Text is never
  cut off, and the icon alone takes the least room.

## 0.105.1 - 2026-11-11

- **Connected sections keep ordinary Cortex memory.** Threads in a section with a shared brief again get the memory
  summary, matching tasks, `cortex_recall` across all Cortex memory and memory save checkpoints. The section brief is
  added beside them and is never clipped to make room. Another workstream's knowledge still needs an explicit grant.

## 0.105.0 - 2026-11-11

- **Section-first setup in bb.** Connect a real section to a new or existing shared brief, see its threads and
  manage the connection from one place. Listing threads does not import their conversations, and changing the
  brief does not rewrite running sessions. Cortex uses its Brain SVG without automatically renaming native bb sections.
- **Save takeaways from messages.** Capture a message or selected passage with a verified source, or write a
  takeaway manually. Review and edit each suggestion's wording and applicability without losing its identity,
  source or revision. Uncertain saves retain their original request rather than silently starting another.
- **Choose a model for background drafting.** Cortex's Drafting settings use bb's native provider/model picker.
  Preview completed excerpts from one section thread before starting a bounded draft. Findings await individual
  review; nothing is accepted or adopted as a Rule automatically. Stop, inspect progress and recover partial
  results without requesting another model turn. The helper omits Cortex tools and memory, not native-provider tools.
- **Keep conversations quiet and edits intact.** The context row shrinks to one icon when space is tight and can
  still be closed and restored. Background updates and read failures preserve dialogs, typed text, focus and
  selection; stale writes and mismatched responses retain the original intent for explicit recovery.
- **Guarded knowledge transactions and recovery.** Proposal IDs and reviewed acceptance support exact retry
  recovery without overwriting an occupied ID. Historical no-save results retain their canonical identity and
  state. Candidate kind and applicability edits stay unapproved, and changed or uncertain queued draft input is
  preserved instead of being discarded during cancellation.
- **Recheck startup scope while preparing context.** Withdrawn granted knowledge and thread/environment changes
  invalidate in-flight preparation. Unresolved startup context never silently falls back to unrelated memory.
- **Known drafting limitation.** Drafting can refuse completed threads when bb returns their messages outside a
  grouped turn. Section context, manual takeaways and message capture remain available while this is fixed.

## 0.104.0 - 2026-11-11

- **Shared context for bb sections.** Connect a section to a workstream so related threads, including children,
  start with approved knowledge for their topic and target environment. Startup context contains short claims and
  source references; full captured evidence is available on demand. Other workstreams and historical tasks need
  an explicit sharing grant.
- **Review knowledge before it becomes guidance.** Suggestions wait for approval. Conflicts, expired observations
  and unavailable volatile sources are held back with notices instead of actionable claims. Revisions, source
  evidence, supersession and thread-only changes make the affected scope visible. Exact duplicates can reuse
  existing knowledge; differently worded suggestions still need review, not an automatic similarity judgment.
- **A new Cortex interface in bb.** Needs you, Workstreams, Library and Bindings bring review and navigation into
  one page. The Cortex and Memory tabs retain task actions and add exact context previews and history. Collapse
  the context row or hide it completely; the thread menu and Memory tab restore it, with a saved per-thread choice.
- **Prepare context without sending it.** Inspect the exact text, put it in the composer as an unsent draft, and
  distinguish current shared knowledge from changes for this thread. Context history records returned or sent
  text without claiming the agent used it. Oversized startup context is refused before dispatch, never clipped.
- **Workstreams in the CLI and API.** `cortex workstream` manages canonical knowledge, scoped reads and revisioned
  changes; backup and restore include their history. Ordinary Cortex task memory, ranking and child updates keep
  their existing behavior.

## 0.103.1 - 2026-11-10

- **Pull requests link their memory.** A request that names a pull request, as a link, `owner/repo#12` or a forge
  key such as `github:owner/repo#12`, now lists the streams that cite it first, such as an earlier review of the same
  pull request. The link, the key and the phrase "review the pull request" no longer become search words.
- **`cortex 908` names a task.** "read cortex 908" links task 908 like `cortex show 908` does. Versions and counts
  such as `cortex 0.103.1` or "Cortex 3" do not.
- **Journals rank last among linked streams.** A daily journal mentions every ticket and pull request of its day, so
  it now comes after the other streams that mention the same key.

## 0.103.0 - 2026-11-05

- **Memory linked to the request comes first.** A task the request names (`@42`, `cortex show 42`), what a bb thread
  it mentions worked on, and streams naming its ticket key (`LANE-8`) now lead the hits, marked as linked, before
  keyword matches. Ids such as `thr_…` or `wk_…`, and identifiers inside pasted code, no longer pull in streams.
- **Fewer memory hits nobody reads.** In bb, wake-ups, Shuttle notices, Loom messages and other plugin messages no
  longer look up memory, and a minion or workflow agent gets only the tasks its brief names and its starting
  thread's streams. Later requests look up only when they ask for earlier work: "last", "latest" and "again" no
  longer count. A session's own streams come back only when it names them, and finished digests or streams long out
  of sync rank after the rest.
- **The save turn names the right stream.** Only streams an agent wrote to count as the ones it works on, not ones
  it just read, and in bb they survive a restart of bb or the plugin.

## 0.102.2 - 2026-11-02

- **A seamless title breadcrumb.** The banner now meets the sheet's top and side edges, so scrolled text cannot peek
  through a pixel gap. Its lower edge and keyboard caret clearance are unchanged.

## 0.102.1 - 2026-11-02

- **Scrolling paper and a quiet title breadcrumb.** The task's dots, grain, title, metadata and body scroll together
  in Read, Edit, Split and Activity. Once the title leaves view, a small breadcrumb keeps it visible; click it to
  return. Long titles are no longer clamped, and keyboard editing keeps the caret below the breadcrumb.
- **Reliable reading position.** The body renders and its reading position restores before paint, so switching tabs
  or modes cannot reset a scroll you just made. The tests also wait for enough scrollable content before attempting it.
- 0.102.0 was tagged but not published because its new scrolling tests failed on Linux. These fixes ship in 0.102.1.

## 0.102.0 - 2026-11-02

- **Paper that scrolls with the task.** The dots and grain now move with the title, metadata and body in Read,
  Edit, Split and Activity. The editor and preview share the sheet's vertical scroll instead of separate panes.
- **A quiet title breadcrumb.** The title scrolls away naturally, without a clamp or hover expansion. Once it leaves
  view, a small breadcrumb keeps the task title visible; click it to return. Keyboard editing keeps the caret below it.

## 0.101.2 - 2026-10-22

- **Status colours in bb.** In the bb plugin's Cortex tab and task chip, drafts are now grey and open tasks are
  blue. Before, drafts were blue and open tasks grey.

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

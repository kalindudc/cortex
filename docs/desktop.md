---
budget: 170
sources: [src/commands/app.ts, src/desktop/, src/ui/, src/lib/catalogSearch.ts, src/lib/refGrammar.ts, src/lib/slug.ts,
  integrations/desktop/]
---

# The desktop app

The desktop app is where you read, edit and triage tasks while your agents work through the CLI. It is an Electron
window over the same daemon and database the CLI uses, so every agent write shows up in it live. This page explains
how to open and use it, then how it is built and which rules keep it safe. See also [architecture](architecture.md)
and [memory](memory.md).

## Opening it

- `pnpm run desktop:dist` builds the app for your operating system into `integrations/desktop/dist/`; install it the
  usual way for your platform.
- Plain `cortex` in an interactive terminal opens it, and so does `cortex app [id] [--heading <slug>]`, which opens
  that task at that heading. When the app is not installed, `cortex app` prints one line naming the build command and
  exits non-zero.
- The app finds the daemon for your database, or starts one, and quitting the app leaves that daemon running.
- A second `cortex app` while the app runs brings its window forward and opens the task there.

## Using it

- The sidebar filters by status, lane and tag. The task list shows what matches, and the document shows one task in
  Read, Edit or Split view, with an outline of its headings.
- The tabs under the document are Activity (every update, with a composer to post your own), Related and Authors.
- The command palette runs every command and searches tasks; the settings and help view lists every command,
  shortcut and setting, and you can search it.
- Drafts of a title or body save field by field as you type. When someone else changed the same field, a conflict
  banner offers to apply their text or keep yours.
- Closing the window with unsaved drafts offers Save all, Discard or Cancel. The draft of a task that was deleted
  meanwhile is kept and can be exported to a file.
- Only a move into `blocked` raises a system notification; routine updates never interrupt you.
- Mod+[ and Mod+] step back and forward through the tasks you opened.
- Settings (appearance: system, light, dark or high contrast; sort; grouping; showing done tasks; the default document
  mode) live in the app on this machine. Backup is the download button in the sidebar's system bar.
- The app never reads or writes `tui.toml` or `themes/*.toml`; old files stay on disk, unused.

## Coming from the terminal workspace

`cortex tui` was removed: the desktop app replaced the terminal workspace. The table below is the fixed record of what
happened to each of its commands: where it went in the app, or why it was dropped and what to do instead.

| Terminal command | Desktop equivalent, or dropped with the replacement workflow |
| --- | --- |
| `open` (also `:<id>`) | Click a task in the list, search with the palette (Mod+K), or a `/task/<id>` address; other programs use the launch link |
| `filter` | Sidebar status, lane and tag filters, including untagged |
| `clear` | "Clear filters" in the sidebar and the palette; show-done is kept |
| `sort` (with `sort group`) | Sort and group settings: palette "Sort and group…" and the settings pane |
| `new` | "+" in the task list and palette "New task" (named `untitled-<id>`) |
| `title` | The editable title in the task header (a guarded draft) |
| `status` | Status popover and palette "Set status…", through the versioned status write |
| `next` | The toolbar's next-step button |
| `priority` | Priority chip and palette "Set priority…" |
| `lane` | Lane picker in the header, or drag a task onto the lane tray |
| `tag` | Tag picker, written as add and remove deltas |
| `memory` (`on`, `off`) | Palette "Keep out of agent memory" and "Let agent memory offer this task"; the task header then says "memory off" |
| `delete` | Palette "Delete task…" with a confirmation |
| `lanes` | "Manage lanes" sidebar mode |
| `tags` | "Manage tags" sidebar mode |
| `focus` | Native focus: Tab and Shift+Tab move between the task list and the document, and a click focuses either; listed in the help pane |
| `back`, `forward` | Mod+[ and Mod+], and the mouse's back and forward buttons, step through the window's task history |
| `help` | The settings and help pane (Mod+, or palette), searchable |
| `commands` | The command palette (Mod+P); every command is also listed in the help pane |
| `messages` | This window's errors appear in the notification drawer; there are no configuration problems because the app has no settings file |
| `notifications` | The notification drawer (read state shared with every client) |
| `config` | The settings pane: appearance, sort, grouping, show done tasks, default document mode |
| `suspend` | Dropped by the user's choice. Instead: switch to a terminal with the operating system; the daemon keeps running |
| `read`, `edit`, `split` | Mode buttons and Mod+Alt+1, 2, 3 |
| `heading` | The document outline; launch links take `--heading` |
| `links` | Dropped as a list. Instead: links are clickable in Read mode (a web link opens in the default browser), `@id` and `#tag` follow with Mod+click in the editor, headings through the outline |
| `copy` | The copy button on every code block |
| `source` | Edit and Split modes show the raw Markdown (there is no separate toggle), and each update has a "Markdown source" disclosure in Activity |
| `activity` | The Activity tab |
| `related` | The Related tab |
| `authors` | The Authors tab, with a Resume button on resumable authors |
| `post` | The composer (Mod+/ opens it, Mod+Enter posts) |
| `backup` | The backup button in the sidebar system bar |
| `resume` | Resume buttons in the Authors tab and palette "Resume a session…" |
| `write` (`w`) | Autosave, Save all, and export of a kept draft through a save dialog |
| `write!` (`w!`) | Export through the same save dialog |
| `wq` (`x`) | Closing the window with unsaved drafts offers Save all and quits once the saves are acknowledged |
| `apply`, `keep` | The conflict banner's two actions |
| `quit` (`q`) | Close the window; the close guard stops it while a draft is unsaved |
| `quit!` (`q!`) | The close guard's Discard choice |
| Reading cursor, motions, visual selection, registers | Dropped by the user's choice. Instead: ordinary text selection, the system clipboard and the editor's own keys |
| `tui.toml` key bindings and profiles | Dropped by the user's choice. Instead: fixed shortcuts, all listed in the help pane |
| User-authored TOML themes | Dropped by the user's choice. Instead: the four built-in appearances |
| Agent integration install and reset | Dropped by the user's choice. Instead: `cortex agents install` and `cortex agents reset` in a terminal |

## Under the hood

### Processes and the IPC boundary

The main process (`integrations/desktop/main.ts`) is Node. It connects to the daemon with
`src/desktop/daemon.ts#connectDaemon`, which runs `cortex serve` and `cortex doctor --json` rather than
reimplementing daemon ownership, and forwards the live stream to each window through `src/desktop/bridge.ts`. The
renderer (`src/ui/`) loads only `cortex://app`, runs sandboxed with context isolation, and sees only `window.cortex`
from `integrations/desktop/preload.ts`. Main checks every bridge call with `src/desktop/guard.ts#parseBridgeRequest`:
the sender's origin, the method, a path under `/api/`, and never a daemon control path. There is no TCP port; the
daemon is reached only over its Unix socket, from main.

### Live sync

Each window load attaches its own subscription, so a first load and every reload get their own `ready`, and a daemon
restart arrives as a `ready` with a new epoch, after which the renderer takes a fresh snapshot. A database whose
identity changed turns dirty drafts into exportable orphans instead of replaying them onto another database's ids.

### Document safety

Stored text is untrusted. Markdown renders only through `src/ui/lib/markdown.ts#renderMarkdown` (Marked, then
DOMPurify, failing closed), and diagrams only through `src/ui/lib/markdown.ts#runMermaid`. Real-Chromium tests
certify that hostile bodies run no script, keep no event handler or `javascript:` URL and make no network request.

### Drafts and guarded writes

`src/ui/lib/useTaskDraft.ts` saves a title or body draft only through guarded versioned writes, so a stale save
becomes a conflict instead of overwriting someone else. Tag membership changes are `versioned.changeTags` deltas, and
removing a tag from a task never deletes the tag's definition. Close, reload and quit go through
`src/desktop/draftGuard.ts`, so a draft is never dropped silently.

### Pickers

Lane and tag pickers search with `src/lib/catalogSearch.ts`, which never caps results or forces you to refine.
References use the shared `@id` and `#tag` grammar in `src/lib/refGrammar.ts`, and heading anchors come from
`src/lib/slug.ts`, the same slugs the launch link's `--heading` takes.

### Icon

The app icon lives in `integrations/desktop/build/`: `icon.icns` for macOS (its 16 and 32 pixel images are drawn
separately, with a thicker arc, so the symbol stays legible) and the 1024 pixel `icon.png` for Linux. Change both
together, and rebuild `icon.icns` from an iconset with `iconutil -c icns`.

### Help and settings

One set of sources describes the app: `src/ui/state/settings.ts#SETTINGS`, `src/ui/lib/help.ts#SHORTCUTS` and
`src/ui/components/palette/buildCommands.ts#buildCommands`, rendered only by
`src/ui/components/modals/SettingsModal.tsx`. Settings persist in the window's `localStorage` on `cortex://app`.

## Rules to keep

- The renderer never reaches the store, the CLI client or a Node module, and main validates every bridge call:
  `test/unit/ui/browser-graph.test.ts`, `test/unit/desktop/guard.test.ts`.
- Markdown and diagrams render only through `src/ui/lib/markdown.ts`, failing closed:
  `integrations/desktop/test/document-safety.test.ts`.
- Drafts save only through guarded writes and are never dropped silently; removing a tag keeps its definition:
  `test/ui/lib/useTaskDraft.test.tsx`, `test/ui/components/chips/tag-membership.test.tsx`,
  `integrations/desktop/test/close-guard.test.ts`.
- Every shortcut, command and setting comes from the one set of help sources, and every shortcut works:
  `integrations/desktop/test/settings-help.test.ts`.
- A post retried with the same mutation id lands once, and an idle stream outlives Bun's idle timeout, over the
  desktop's socket transport: `test/integration/desktop/stream-and-retry.test.ts`.

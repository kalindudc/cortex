# cortex

> AI coding agents working on this repo: start with [AGENTS.md](./AGENTS.md). Run `pnpm run agents:check` before pushing.

Personal task tracker for engineers supervising parallel AI coding agents.
Single self-contained binary at `home/bin/cortex` with a complete CLI, REST + SSE
API on `127.0.0.1`, and a SQLite WAL store at `~/.config/cortex/cortex.db`.

## Quick start

```bash
pnpm run build                       # compile to bin/cortex
cortex init                          # create ~/.config/cortex/cortex.db
cortex add "ship plan 1" -p 0
cortex                               # the terminal workspace (starts a headless daemon if none runs)
cortex ls
cortex serve                         # run the daemon with the dashboard on http://cortex.localhost:7777
cortex open                          # open the dashboard in your browser
cortex stop                          # stop this database's daemon
```

For development without compiling (runs from source against a sandbox in `tmp/dev/`, see below):

```bash
pnpm run dev                         # the TUI from source
pnpm run dev -- ls --json            # any CLI command from source
```

### Dev data sandbox

`pnpm run dev` and `pnpm run serve:dev` point cortex at `tmp/dev/` (config, database, skills and pi extension)
instead of your real `~/.config/cortex`, so unreleased code never migrates the database your installed `cortex`
uses. An installed daemon from an older binary also blocks new-binary commands against the same config, so dev
runs against real data would fail while it is up. Both dev commands share the sandbox, so the TUI from
`pnpm run dev` and the dashboard from `pnpm run serve:dev` talk to the same dev daemon.

```bash
pnpm run dev -- init                 # optional: seed the sandbox (lanes, skills) once
CORTEX_DEV_HOME=/tmp/cx pnpm run dev # a different sandbox
CORTEX_DEV_REAL=1 pnpm run dev       # your real config and database (stop the installed daemon first)
pnpm run dev -- stop                 # stop the sandbox's daemon
```

`pnpm run dev` builds the dashboard bundle (`out/`) once if it is missing, because the source server embeds it.

### Live UI dev loop

```bash
pnpm run serve:dev                   # bun --watch, port 7788, --no-open
PORT=7799 pnpm run serve:dev
```

- HTML edits to `src/ui/index.html` are picked up immediately — the
  server reads the file fresh on every request via `Bun.file().text()`. Just
  refresh the browser; no restart, no reload script.
- TypeScript edits to `src/cli.ts`/`src/server.ts`/`src/store.ts`/etc. trigger a
  `bun --watch` restart within ~1 s. The browser stays connected because
  the SSE `EventSource` reconnects automatically; refresh once to repopulate.
- It uses the dev data sandbox (`tmp/dev/`, see above) unless you opt out, and
  first stops the daemon serving that SAME database so it can own it; `cortex stop`
  is instance-bound, so daemons of other databases (like your installed one) keep
  running.
- It defaults to port 7788 so it never collides with a `cortex serve` on 7777;
  pick another with `PORT=<n>`.

## TUI

The terminal workspace is the normal way to use cortex. In an interactive terminal, plain `cortex` opens it (the
same as `cortex tui`); without a terminal (a pipe, a script) plain `cortex` prints the usage as before. It talks to
this database's daemon over the private socket, starting a headless one (socket only: no browser, no web listener)
when none runs, and quitting leaves that daemon running for the CLI, agents and other clients. The browser
dashboard stays supported as the fallback (`cortex open`, or `:preview` for one task).

```bash
cortex                               # the TUI (same as `cortex tui`)
cortex tui 42                        # open task 42
cortex tui 42 --heading plan         # ... at a heading (its web anchor slug, or task-42-plan)
cortex tui --theme cortex-light      # a theme for this session only
cortex tui --profile work            # a separate view state (selection, filters, mode, saved theme)
pnpm run dev                         # the TUI from source, in the tmp/dev sandbox
```

It needs at least 80×24 cells. `TERM=dumb` is refused (use the CLI there), and `NO_COLOR` turns colors off.

### Modes and the command line

- NORMAL (the default): keys act and never insert text. Counts repeat motions (`5j`), and the leader (`;` by
  default) takes one more key (`;e` hides the task list).
- INSERT (`i`): every key is text until `Esc`, in the body editor or the title (edited in place; Enter or Esc
  saves it). From Read, `i` shows Edit for this task without changing your saved mode.
- VISUAL (`v`, characters) and VISUAL LINE (`V`, whole lines), as in vi. In the editor (Edit, or Split's editor
  half) the selection starts at the cursor and the motions extend it, with counts (`h` `j` `k` `l`, `w` `b` `e`,
  `0` `$`, `g` `G`, `Ctrl-d`/`Ctrl-u`, the arrows). `y` yanks it into the paste register and, with one OSC 52
  write, the terminal clipboard (the status line says the copy is unconfirmed, or why it failed: too large, no
  terminal); `d`/`x` delete it, `c` deletes it and starts INSERT, `>`/`<` indent and outdent its lines, and `o`
  goes to its other end. In NORMAL, `p`/`P` paste the register after/before the cursor (whole lines below/above
  its line). Every operation is one undo step. While reading (Read, or Split's preview) the selection starts at
  the top row on screen: `V` takes rendered rows, `v` the characters of the rendered text, and `y` copies what is
  shown as plain text (reading never edits). `Esc`, or the same key again, returns to NORMAL.
- COMMAND (`:`): a one-line command. Tab completes commands and their arguments, Up/Down recall history, Enter
  runs it, Esc cancels. `:<id>` (for example `:42`) jumps to a task.
- SEARCH (`/`): filters the task list with the dashboard's search (`@id`, `@title`, `#tag`, then AND words over
  titles, bodies and tags), or searches the rendered document while it has the focus (`n`/`N` step).

Read and Split's preview render the Markdown: headings over rules, lists with `☐`/`☑` task boxes, quotes behind a
bar, code on a tinted panel (`:copy N`), tables and rules. Links show their text only (an OSC 8 hyperlink where
the terminal supports it); `Enter` or `:links` lists every destination. In Split the preview follows the editor:
the block under the cursor sits beside the cursor's row; scrolling the preview (Tab to it, then `j`/`k`) leaves
it where you put it until the cursor moves again. `:set number` adds a gutter with each block's source line (and
every line of a code block), kept with your other view settings.

The task list is in ascending id order by default; `:sort` changes the order and `:group lane` or `:group status`
adds a header row (with its count) per group, which `j`/`k` step over; `;o` picks both. The selected row shows its
whole title (on up to four lines); the other rows are cut to one line, with their lane at the right when the whole
title fits beside it. A search always ranks by
relevance in one list, and the list header says which order is shown. `f` opens the filter picker: Status, Lane
and Tags with live counts, one key per status (`d` `o` `r` `b` `x`), `u` for untagged, `a` for done tasks, Space
on any row, and `/` to search the lanes and tags as you type. Every toggle applies at once; Enter and Esc only
close the picker, so the filters stay. `F` clears the search and every filter (done tasks stay shown if they
were). The active filters are always on the list header as chips (`status:review lane:cortex #ui`).

`?` or `:help` lists the modes, every command and the keys as configured; `:commands` (`Ctrl-p`) is a searchable
reference. A bare `q` only reminds you that `:q` quits; `Esc` and `Ctrl-C` cancel pending input and never quit;
function keys are never bound. Titles and bodies autosave (600 ms idle, 3 s at most; `:w` or `Ctrl-s` saves now)
with guarded writes: when another client changed the same field first, both versions stay and the status line
offers `:apply` (take theirs) or `:keep` (save yours over it). `:q` refuses while a draft is unsaved; `:q!`
discards. Status changes from the TUI are human changes, never attributed to an agent. The panels (`]`/`[`) are
Activity (updates, newest first; `c` posts one), Related and Authors; `:notifications` lists the notifications,
and a task becoming blocked flashes the status line.

### Mouse

The mouse is on by default (`mouse = false` in `tui.toml` turns it off) and is never the only way to do
anything: each click below has a key or a command. The TUI asks for button-event tracking in SGR encoding
(DECSET 1002 and 1006, never any-motion tracking) and turns it off on every exit, suspend and handoff.

- Panes: a click focuses the pane under it (the task list, the document, Split's editor or preview half, a
  panel). A click on a task row selects it; a click on the selected row (or a double click) opens its document.
  A click that takes the keyboard away from the text you are typing (Read, a panel, another view, the list,
  Split's preview, the title) ends INSERT first, so no later key types into what is not shown.
  The wheel scrolls the pane under the pointer, not the focused one; in a dialog it moves through the list. A
  list (the task list, `:commands`, a dialog's rows or fields) moves one row a notch, however many wheel
  reports the terminal sends for it (Ghostty sends its `mouse-scroll-multiplier`, 3 by default, and
  multiplexers forward each). In the editor it scrolls the view three rows a wheel report and moves the cursor
  only when it would leave the view.
- Views: the document's header row ends in the view tabs `Read  Edit  Split  │  Activity  Related  Authors`
  (the one shown is bold and inverse; wide panes add the keys, narrow ones abbreviate them). A click runs
  `:read`, `:edit`, `:split`, `:activity`, `:related` or `:authors`, so only Read, Edit and Split change your
  saved mode. On the list header the filter chips open the filter picker (`f`) and the sort label the sort and
  group picker (`;o`); on the status line the unread count opens `:notifications`.
- Selecting: in the editor a click places the cursor (VISUAL ends; in INSERT you keep typing there), a drag
  selects from the press to the pointer, a double click selects a word and a triple click its line. That is the
  VISUAL (or VISUAL LINE) selection `v`/`V` make, so `y`, `d`, `c` and `>`/`<` act on it. In Read and Split's
  preview a drag, double or triple click selects the rendered text the same way (`y` copies what is shown).
- Dialogs: a click highlights a row and a double click picks it; checkbox and radio rows (the filter, tag and
  sort pickers) toggle on every click. A click outside a dialog does nothing (it never closes one holding a
  draft).
- The terminal's own selection: while the mouse is on, the terminal sends drags to cortex; Shift-drag (or
  Option-drag in some macOS terminals) still gives the terminal's native selection and copy.

### Commands

Every command, as `:help` shows it (Tab completes names and arguments):

| Command | Also | Description |
| --- | --- | --- |
| `:open <id\|query>` | | Jump to a task by id (also :\<id>) or to the best search match; the list filters stay |
| `:filter [status\|lane\|tags] <value>` | | Narrow the task list: :filter status review, :filter lane later, :filter tags bug untagged (+tag adds, -tag removes); a bare slot clears it |
| `:clear` | | Clear the search and every filter (include-done is kept) |
| `:sort [order]` | | Order the task list: id (the default), -id, title, -title, lane, status, priority, updated or -updated (- reverses; ties by id; a search ranks by relevance); bare opens the sort and group picker |
| `:group [none\|lane\|status]` | | Group the task list under a header per lane or status, each with its count (j/k skip the headers); bare opens the sort and group picker |
| `:set <option>` | | Options: done (show done tasks), tasks (show the task list), number (source line numbers in Read and the Split preview); name, noname, name! toggles, name? shows |
| `:new [title]` | | Create a task in the filtered lane (else now) and select it; without a title it is named untitled-\<id> (:title renames it) |
| `:title [text]` | | Rename the current task; without text, edit its full title in place (Enter or Esc saves) |
| `:status <draft\|open\|review\|blocked\|done>` | | Set the current task's status (a human change, never attributed to an agent) |
| `:next` | | Move the current task one step on, like the web's next-step button: draft→open, open→review, review→done, blocked→open, done→open |
| `:priority <n\|none>` | | Set the current task's priority: any whole number from 0 (the highest) up, or none |
| `:lane <name>` | | Move the current task to another lane (:lanes manages the lanes) |
| `:tag [+name -name]` | | Add (+name, or a bare name) and remove (-name) the current task's tags; without names, pick them in a list |
| `:delete` | | Delete the current task after a y/n confirmation (its updates go with it) |
| `:lanes` | | Manage the lanes: create, rename, recolor, re-sort, and delete empty ones (the now lane is protected) |
| `:tags` | | Manage the tag definitions: create, rename, recolor, and delete (showing how many tasks lose the tag) |
| `:focus <list\|document>` | | Move the keyboard focus to the task list or the document |
| `:back` | | Go back to the task shown before the last jump (task history) |
| `:forward` | | Go forward again in the task history |
| `:theme [name\|auto]` | | Pick a color theme with a live preview (Esc restores, Enter applies and saves it); auto follows the terminal again |
| `:density [compact\|comfortable]` | | Set the spacing, saved for the profile (over tui.toml's density): comfortable (the default) adds blank rows under the headers and above the status line; compact fits more rows; bare toggles. A terminal cannot set its font size: use its zoom keys |
| `:help` | `:h` | Modes, commands and the configured keys |
| `:commands [search]` | | Searchable command reference: / searches it, Enter picks a command |
| `:messages` | `:mes` | Configuration problems, errors and notices |
| `:notifications` | | The notifications (read state shared with every client) and this session's errors, unread first: Enter opens the task and marks it read; r read, u unread, a all read, x dismiss, X clear all |
| `:suspend` | | Suspend to the shell; fg resumes (the daemon keeps running) |
| `:read` | `:r` | Read mode: the rendered document (saved as your preferred mode) |
| `:edit` | `:e` | Edit mode: the document editor, i types in it (saved as your preferred mode) |
| `:split` | `:sp` | Split mode: the editor beside a preview; a narrow terminal shows one half at a time, Tab switches (saved as your preferred mode) |
| `:heading [slug]` | | Jump to a heading of this document by its web anchor slug (Tab completes; repeats are slug-2, slug-3); without one, pick it from the outline |
| `:links` | | The links and @id/#tag references of this document: Enter follows one (@id jumps and clears the filters, #tag filters, a heading link jumps, a web link is copied) |
| `:copy [n]` | | Copy code block n (its caption shows the number; without one, the block in view) with OSC 52; terminals never confirm it |
| `:source` | | Show the raw Markdown source in Read and the preview (escaped), or the rendered document again; in the Activity panel, the highlighted update's source |
| `:preview` | | Open this task's current text (unsaved edits included) in the browser, rendered in full: the dashboard's sanitizer and Mermaid diagrams. Starts this daemon's dashboard if needed; the private link (also in the message log) expires in 10 minutes and nothing is saved |
| `:activity` | | The Activity panel: this task's updates, newest first; Enter expands one (its body; :source shows its Markdown); c posts an update. Retries a failed read |
| `:related` | | The Related panel: the tasks that reference this one, that it references and that share its tags; Enter opens one (the list filters clear). Retries a failed read |
| `:authors` | | The Authors panel: who posted on this task, latest first, with their post counts |
| `:post [text]` | | Post an update to this task as yourself: without text, open its composer (also c: :w posts it, closing it keeps the draft); with text, post it now |
| `:backup` | | Write a data-only backup now through the daemon (the dashboard's backup button) and report its path and counts; cortex restore restores one |
| `:resume` | | Resume the pi session that posted on this task (cortex resume, which asks when there are several): it gets the terminal until it exits; the daemon keeps running |
| `:w [[@id] path]` | `:write` | Save every unsaved title/body draft now (a failed save is retried); in a form, save the form; with a path, export to a new private file this task's body draft if it has unsaved changes, else the one kept draft (of a deleted task or a replaced database; with several, give its @id), else this task's body; with @id, @id's kept draft, else task @id's |
| `:w! [@id] <path>` | `:write!` | Export like :w [@id] <path>, replacing the file if it exists |
| `:wq` | `:x` | Save every draft and quit once the saves are acknowledged; in a form, save it and close it |
| `:apply [title\|body]` | | Resolve a save conflict of the current task by taking the incoming version (theirs) |
| `:keep [title\|body]` | | Resolve a save conflict of the current task by keeping your version: it is saved over the incoming one, guarded, so it can conflict again |
| `:q` | `:quit` | Quit this terminal workspace (the shared daemon keeps running); refused while a draft is unsaved; in a dialog, close it (a form with input refuses) |
| `:q!` | `:quit!` | Quit, discarding the local drafts and anything unsaved; in a dialog, close it and discard its input |

### Default keys

NORMAL keys, and leader keys (pressed after the leader, `;` by default). `forward` has no default key because
legacy terminals send `ctrl+i` as Tab; bind one in `tui.toml` if you want it.

| Action | NORMAL keys | Leader keys | Description |
| --- | --- | --- | --- |
| `down` | `j` `down` | | Move down: the task list, the document or the editor cursor |
| `up` | `k` `up` | | Move up: the task list, the document or the editor cursor |
| `left` | `h` `left` | | Editor cursor left; otherwise focus the task list |
| `right` | `l` `right` | | Editor cursor right; otherwise focus the document |
| `half_down` | `ctrl+d` | | Half a page down |
| `half_up` | `ctrl+u` | | Half a page up |
| `top` | `g` | | Go to the top |
| `bottom` | `G` | | Go to the bottom |
| `word_forward` | `w` | | Editor or selection cursor: the start of the next word |
| `word_backward` | `b` | | Editor or selection cursor: the start of the previous word |
| `word_end` | `e` | | Editor or selection cursor: the end of the word |
| `line_end` | `$` | | Editor or selection cursor: the end of the line (0 is its start) |
| `next_pane` | `tab` | | Focus the next pane |
| `previous_pane` | `shift+tab` | | Focus the previous pane |
| `next_panel` | `]` | | Next task panel |
| `previous_panel` | `[` | | Previous task panel |
| `next_heading` | `}` | | Next heading |
| `previous_heading` | `{` | | Previous heading |
| `next_match` | `n` | | Next search result |
| `previous_match` | `N` | | Previous search result |
| `insert` | `i` | | INSERT mode; from Read, shows Edit for this task |
| `post` | `c` | `;c` | Post an update |
| `undo` | `u` | | Undo in the visible editor |
| `redo` | `ctrl+r` | | Redo in the visible editor |
| `visual` | `v` | | VISUAL: select characters from the cursor (the editor or the rendered document); again or Esc ends it |
| `visual_line` | `V` | | VISUAL LINE: select whole lines (rendered rows while reading); again or Esc ends it |
| `paste_after` | `p` | | Paste the last yank or delete after the cursor (whole lines: below this line) |
| `paste_before` | `P` | | Paste the last yank or delete before the cursor (whole lines: above this line) |
| `help` | `?` | | Help: modes, commands and the configured keys |
| `commands` | `ctrl+p` | | Searchable command reference (:commands) |
| `back` | `ctrl+o` | | Go back (:back) |
| `forward` | | | Go forward (:forward) |
| `suspend` | `ctrl+z` | | Suspend to the shell (:suspend) |
| `focus_tasks` | | `;h` | Focus the task list |
| `focus_document` | | `;l` | Focus the document |
| `toggle_tasks` | | `;e` | Show or hide the task list |
| `read` | | `;r` | Read mode (:read) |
| `edit` | | `;i` | Edit mode (:edit) |
| `split` | | `;s` | Split mode (:split) |
| `tags` | | `;t` | Edit this task's tags |
| `sort` | | `;o` | Sort and group the task list (:sort) |
| `filters` | `f` | | Pick filters: status, lane, tags, untagged and include-done (the list follows each toggle) |
| `clear_filters` | `F` | | Clear the search and every filter (:clear; include-done stays) |

| INSERT action | Keys | Description |
| --- | --- | --- |
| `save` | `ctrl+s` | Write the draft (:w) |

VISUAL operators (in VISUAL and VISUAL LINE only; the NORMAL motions extend the selection):

| VISUAL action | Keys | Description |
| --- | --- | --- |
| `yank` | `y` | Copy the selection: the terminal clipboard (OSC 52) and the paste register (p) |
| `delete` | `d` `x` | Delete the selection into the paste register (the editor) |
| `change` | `c` | Delete the selection, then INSERT there (the editor) |
| `indent` | `>` | Indent the selected lines (the editor) |
| `outdent` | `<` | Outdent the selected lines (the editor) |
| `other_end` | `o` | Move the cursor to the other end of the selection |

Fixed keys: `Enter` focuses the document from the list, follows links while reading and expands or opens panel
entries; in INSERT, `Tab`/`Shift-Tab` indent and outdent, Shift-arrows select, and `Esc` returns to NORMAL. A `0`
with no count pending is the line start (digits are counts, so it cannot be rebound).

### tui.toml

Settings live in `tui.toml` in the config directory (`~/.config/cortex/tui.toml`, XDG-aware). Cortex only reads
it, never writes it. Each section and setting validates on its own: an invalid one keeps its defaults, the rest
still apply, and the problem is listed in `:messages`. A missing file means the defaults.

| Setting | Default | Meaning |
| --- | --- | --- |
| `leader` | `";"` | The leader key for the `[keys.leader]` table |
| `mouse` | `true` | The mouse: clicks, drags, the wheel and the view tabs (see Mouse; every action also has a key or command) |
| `theme` | unset | Pin a theme (bundled or custom) for every session |
| `theme_dark` | unset (`cortex-dark`) | The theme for a dark terminal when no theme is pinned |
| `theme_light` | unset (`cortex-light`) | The theme for a light terminal when no theme is pinned |
| `appearance` | `"system"` | `"system"` follows the terminal's reported appearance (and its live changes); `"dark"` or `"light"` fixes it |
| `colors` | `"auto"` | `"auto"` detects the color depth; `"truecolor"`, `"256"`, `"16"` force one; `"none"` turns colors off |
| `transparent_background` | `false` | Leave the background to the terminal (its contrast cannot be checked) |
| `density` | `"comfortable"` | The spacing when the profile has no saved `:density` choice (that choice wins): `"comfortable"` adds blank rows under the headers and above the status line, and margins at both ends of the status and hint lines; `"compact"` leaves them out |
| `flash` | `true` | Flash the status line when a task becomes blocked |
| `bell` | `false` | Also ring the terminal bell when a task becomes blocked |

Keys go in `[keys.normal]`, `[keys.leader]`, `[keys.insert]` and `[keys.visual]` as `action = ["key", ...]`,
with the action names above; setting an action replaces its whole key list. `[keys.visual]` may reuse NORMAL keys:
VISUAL reads it first (`c` posts in NORMAL and changes in VISUAL). Key names are like `j`, `G`, `?`, `ctrl+d`,
`shift+tab`, `alt+x`, `down`. A table with any invalid entry keeps ALL its defaults (it never applies
partially): unknown actions, duplicate keys (including keys a legacy terminal cannot tell apart, like `ctrl+i`
and Tab), keys that shadow the leader, function keys, and the reserved `:` `/` Esc Ctrl-C `q` Enter and digits
are rejected. INSERT shortcuts must use ctrl or alt.

```toml
leader = ";"
theme_dark = "high-contrast-dark"
bell = true

[keys.normal]
forward = ["ctrl+f"]

[keys.leader]
toggle_tasks = ["e"]
```

### Themes

Themes follow the terminal's light or dark appearance (detected at startup) unless one is chosen. Precedence:
`:theme <name>` in the session (saved for the profile), then `--theme`, then the saved choice, then `theme`, then
`theme_dark`/`theme_light` by appearance, then `cortex-dark`/`cortex-light`; `:theme auto` drops the session,
`--theme` and saved choices. A 16-color terminal gets `ansi` unless a theme is explicit, and `NO_COLOR` or `colors = "none"`
removes color while every state keeps a visible mark (text, inverse, underline or bold). The pane without the
focus (the list or the document, and Split's other half) is greyed with the `inactive` token, or SGR dim without
color; the focused pane's label is inverse.

A terminal program cannot change the terminal's font size: use the terminal's own zoom keys for that.
`:density` changes the spacing instead: `comfortable` (the default) adds a blank row under the list header, under
the document header and above the status line, and a margin at both ends of the status and hint lines; `compact`
leaves them out for more rows. Bare `:density` toggles. The precedence is the theme's: the choice is saved for the
profile and wins over tui.toml's `density`, which applies only while the profile has no saved choice.

| Bundled theme | Appearance |
| --- | --- |
| `cortex-dark` | dark (the dashboard's dark palette) |
| `cortex-light` | light (the dashboard's light palette) |
| `high-contrast-dark` | dark, 7:1 text contrast |
| `high-contrast-light` | light, 7:1 text contrast |
| `ansi` | the terminal's own 16-color palette and default colors |

A custom theme is `themes/<name>.toml` in the config directory (lowercase letters, digits, `-` and `_`;
bundled names win). It sets every token below, or `extends` ONE bundled theme and overrides some; it may set
`appearance = "dark"|"light"` and `high_contrast = true`. Values are `"#rrggbb"`, `"ansi:0"` to `"ansi:15"` or
`"default"` (the terminal's own color). Syntax errors, bad values and missing tokens reject the theme (the next
precedence level applies); low contrast only warns. Both show in `:messages`.

```toml
# ~/.config/cortex/themes/mine.toml
extends = "cortex-dark"
accent = "#ffb86c"
status.blocked = "#ff7b72"
```

| Token | Used for |
| --- | --- |
| `bg` | the screen background |
| `panel` | the status and hint lines, dialogs |
| `raised` | raised surfaces: code blocks, the prompt |
| `border` | borders and rules (decorative) |
| `text` | body text |
| `muted` | secondary text |
| `dim` | the least important text (hints, counts) |
| `inactive` | every foreground of the pane without the focus (a readable grey; a theme without it uses `dim`) |
| `accent` | headings of views, the selected-row marker |
| `info` | informational messages |
| `warn` | warnings, unsaved state |
| `danger` | errors, conflicts, failed saves |
| `selection` | the selected row's background |
| `search` | search-match highlight background |
| `status.draft` | the draft status |
| `status.open` | the open status |
| `status.review` | the review status |
| `status.blocked` | the blocked status |
| `status.done` | the done status |
| `mode.normal` | the NORMAL mode badge |
| `mode.insert` | the INSERT mode badge |
| `mode.command` | the COMMAND mode badge |
| `mode.search` | the SEARCH mode badge |
| `md.heading` | Markdown headings |
| `md.link` | Markdown links and `@id`/`#tag` references |
| `md.code` | Markdown code |
| `md.quote` | Markdown block quotes |
| `md.bullet` | Markdown list bullets and task checkboxes |

### Multiple clients

One daemon serves a database; any number of TUIs, CLI commands, agents and browser tabs share it and converge
live over its event stream. Title and body saves are guarded per field, so a stale save of the same field
reports a conflict instead of overwriting (different fields never conflict); CLI and API writes stay
last-writer-wins by design. Each TUI keeps its own selection, filters and drafts. Quitting a TUI never stops
the daemon, and `cortex stop` stops only this database's daemon (daemons of other databases keep running). If
the daemon restarts, open TUIs reattach on their own.

### Maintenance

- `cortex init` applies pending migrations (`cortex doctor` lists them) as the database's owner. Table
  rebuilds need the database to themselves, so init refuses while a daemon serves it: `cortex stop` first.
- `cortex reset` asks for `RESET`, then stops this database's daemon (instance-bound, waiting until it has
  released the database) and wipes and re-initializes it while holding the ownership lease.
- `cortex restore <file>` refuses while a daemon runs (`cortex stop` first); `--dry-run` only reads.
- `cortex backup` (or `:backup`) is safe at any time. `cortex doctor` is read-only and never starts a daemon.

### Upgrading from an older binary

A daemon started by an older cortex (one that wrote `cortex.pid`/`cortex.url`) cannot be verified, so every
command of this binary, reads included, refuses to run beside it until it stops. To switch:

1. Stop the old daemon with the old binary (Ctrl+C in its terminal, or its `cortex stop`, which signals every
   `cortex serve` on the machine).
2. Back up: `cortex backup` with the old binary (or copy the database files while nothing runs).
3. Deploy the new binary (`pnpm run deploy` copies `bin/cortex` to `~/bin/cortex`).
4. Start it: `cortex serve`, or just `cortex` (headless). `cortex doctor` shows the state; run `cortex init` if
   it lists pending migrations.

To roll back, stop the new daemon, back up, and redeploy the previous binary. Never run an old binary's
commands while a new daemon owns the database: old binaries write the file directly, bypassing it.

### Limits and recovery

- The terminal renders Markdown itself: GFM tables, task lists, code blocks (`:copy`), quotes, headings and
  validated links (their text; `:links` lists each destination). Mermaid diagrams and images are NOT rendered in
  the terminal (diagrams show as source); use `:preview` for the full rendering. Clipboard (OSC 52), hyperlinks (OSC 8), the Kitty keyboard protocol
  and appearance reports depend on the terminal and on tmux/SSH passthrough; nothing depends on them alone.
- Keyboard-only operation and never color-only status are design goals, but the TUI has NOT been validated with
  screen readers; the dashboard remains the accessible fallback.
- `:preview` opens the current text (unsaved edits included) in the browser through this daemon's dashboard,
  which it enables if needed. The private link expires after 10 minutes; previews are limited to 1 MiB each
  and 8 MiB in total, kept in the daemon's memory, and never saved.
- Each event-stream client may lag by 1024 events or 8 MiB before it is told to reload its snapshot; the
  stream sends a heartbeat every 5 s.
- Drafts live in the TUI's memory until saved. `:w` saves; `:w <path>` exports the body draft to a new private
  file (`:w! <path>` replaces one). A draft with unsaved changes whose task is deleted elsewhere (or whose
  database is replaced) is kept, never written again, and blocks `:q`: `:w @<id> <path>` exports it (a later
  kept draft of the same id, from a replaced database, is `@<id>.<n>`; the warning names it), `:q!` discards
  it. A plain `:w <path>` prefers the current task's draft only while it has unsaved changes; a clean one never
  hides a kept draft. On SIGTERM, SIGHUP or SIGINT the TUI first tries a bounded save of every draft, but
  SIGKILL, a crash or a power loss loses unsaved drafts: it is not lossless.
## Commands

| Command | Purpose |
| --- | --- |
| `init` | initialize the SQLite database |
| `add <title> [-l lane] [-p int] [-b body]` | create a task (auto-creates `lane` if missing) |
| `ls [-l lane] [-s status] [--json]` | list tasks, grouped by lane, sorted by id (`s` = `open\|review\|blocked\|done`) |
| `show <id> [--json]` | show one task with its updates |
| `search [text] [--json]` | fuzzy-search tasks (same scorer + `@id`/`@title`/`#tag` prefixes as the dashboard palette) in an fzf picker with a `show` preview; enter copies the task id to the clipboard and prints the task like `show`; `--json` emits ranked matches without fzf |
| `update <id> -m <msg> [-s status] [-b body]` | post an update; `status` = `open\|review\|blocked\|done` |
| `edit <id> [-t title] [-b body] [-p int]` | edit task fields |
| `mv <id> <lane>` | move a task to another lane (auto-creates `lane` if missing) |
| `rm <id> [-f]` | remove a task (prompts unless `-f`) |
| `lane add\|ls\|edit\|rm` | manage lanes |
| `doctor [--json]` | report version, DB path, daemon state, pending migrations and counts; read-only (never starts a daemon or migrates) |
| `tui [id] [--heading slug] [--profile name] [--theme name]` | open the terminal workspace (plain `cortex` does the same in an interactive terminal); starts a headless daemon over the private socket if none runs, and leaves it running on quit |
| `serve [-p port] [--foreground] [--open\|--no-open] [--no-web] [--host name]` | run the daemon for this database (`CORTEX_DB`): a private socket every command goes through, plus the dashboard at `/` on `127.0.0.1` (`--no-web`: socket only). Headless unless `--open`. Prints `http://cortex.localhost:<port>` once ready (server still binds `127.0.0.1`); a second `serve` attaches to it. |
| `open` | open this database's dashboard in your default browser (enabling it on a headless daemon); never starts one |
| `reset` | stop this database's daemon (if running), wipe the DB + WAL sidecars (keeping the `<db>.owner.lock` file), then re-init an empty DB. Requires typing `RESET` to confirm. |
| `stop` | stop the daemon serving this database; daemons of other databases keep running |
| `backup [-o path] [--rotate N]` | export cortex's row data as a single JSON document inside a `.zip` (default `~/.config/cortex/backups/cortex-<host>-<ISO>.zip`). Safe to run while the daemon is up. Refuses a missing database (it never creates one, writes no archive and rotates nothing). |
| `restore <file> [--dry-run]` | re-insert backup rows into the live DB. Lanes/tags merge by name (existing wins). Tasks try to keep their original id; on collision they get the next available id. Updates, task_tags, and notifications follow the task-id remap. Refuses while the daemon is running — run `cortex stop` first. `--dry-run` only reads, even beside a running daemon, and never creates a missing DB. |

## Lanes

Lanes are flat strings (`now`, `later`, `blocked`, anything you want). `now`
is seeded automatically and cannot be removed. Any lane referenced by `cortex
add -l <name>` or `cortex mv <id> <name>` is created on the fly with no color
set. Use `cortex lane add <name> -c <color>` upfront when you want to assign
a color, and `cortex lane ls` to inspect.

## Priority

Priority is a non-negative integer where **0 is the highest priority**. There
is no upper bound — use whatever scale fits (`0/1/2`, `0..10`, etc.). Tasks
are listed by priority ascending, ties broken by oldest-created first.

```
cortex add "ship the thing" -p 0      # top of the list
cortex add "normal work"              # default priority = 1
cortex add "someday" -p 9             # bottom
cortex edit 42 -p 0                   # promote a task
```

For every flag that takes a fixed enum (`--status`, `--severity`), `cortex
<command> --help` shows the exact set of allowed values inline.

## Storage

- **DB file:** `~/.config/cortex/cortex.db` (XDG-aware via `$XDG_CONFIG_HOME`).
- **Override for tests:** `CORTEX_DB=/path/to/db cortex …`.
- **Mode:** SQLite WAL with `PRAGMA foreign_keys = ON`. The `-wal` and `-shm`
  sidecar files are normal and persistent.
- **Ownership:** one cortex process owns a database at a time, via a lock on
  `<db>.owner.lock` (never delete it). `cortex serve` owns it for its whole life
  and publishes `<db>.daemon.json` (its private socket lives in `$XDG_RUNTIME_DIR`);
  while it runs, every command goes through it. Without a daemon, each command
  owns the database only for its own work (concurrent commands wait their turn).
  There are no pid files.

## Backup & restore

`cortex backup` writes a single `.zip` containing `cortex-backup.json` — a flat data-only dump of cortex rows (lanes, tags, tasks, updates, task_tags, and notifications). The backup is taken inside a deferred SQLite read transaction so it is safe to run while the daemon is writing. The dashboard's sidebar system bar also has a `Back up now` button that writes the same default backup through the daemon.

`cortex restore <file>` re-inserts backup rows into the live DB inside one transaction:

- Lanes and tags merge by name; existing destination rows win.
- Tasks try to keep their original `id`. If the id is already taken, the task is inserted with the next available autoincrement id. The restore output reports how many ids were preserved vs bumped.
- Updates, task_tags, and notifications reference the remapped task ids automatically.
- Data-only restores are backwards-compatible with v1 backups: unknown row columns are ignored, missing optional tables are treated as empty, and missing nullable/defaulted destination columns are filled by the current schema defaults.

Restoring the same backup twice will duplicate tasks (each with a different id). Use `cortex restore <file> --dry-run` to preview the counts before committing. Restore refuses while `cortex serve` is running; stop the daemon first so the CLI is the only writer (`--dry-run` works beside it: it only reads). Skills, extensions, and daemon/lock files are NOT backed up — skills and extensions are regenerated by `cortex init`.

## API surface

Bound to `127.0.0.1` only.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | the cortex dashboard (single-page Preact UI) |
| GET | `/api/health` | `{ ok: true, version }` |
| GET | `/api/me` | resolved author identity (`gh` username → `git config user.name` → `os.hostname()` → `"me"`) |
| POST | `/api/backup` | write an on-demand data-only backup using the default backup path |
| GET | `/api/tasks?lane&status&search&tags` | list tasks (`tags=a,b`: carrying every tag) |
| POST | `/api/tasks` | create a task |
| GET | `/api/tasks/:id` | fetch one task |
| PATCH | `/api/tasks/:id` | edit title/body/priority |
| PATCH | `/api/tasks/:id/status` | change status |
| PATCH | `/api/tasks/:id/lane` | move lane |
| DELETE | `/api/tasks/:id` | remove a task |
| GET | `/api/tasks/:id/updates` | list updates for a task |
| POST | `/api/tasks/:id/updates` | post an update |
| GET | `/api/lanes` | list lanes |
| POST | `/api/lanes` | create a lane |
| PATCH | `/api/lanes/:name` | edit a lane (`rename` cascades to tasks) |
| DELETE | `/api/lanes/:name` | remove an empty lane (refuses `now`) |
| GET | `/events` | SSE stream of `task.added`, `task.updated`, `task.removed`, `update.posted`, `lane.changed` |

SSE clients receive a `heartbeat` event every 5 s (below Bun's 10 s idle timeout, which would otherwise close an idle stream).

## Dashboard

The daemon serves a document-first single-page dashboard at
`http://127.0.0.1:7777/` (`cortex open` opens it; two columns on desktop; a
navigation drawer at ≤ 900 px):

- **Navigation** (left, 280 px) — a workspace identity and ONE filter surface:
  a search box (`@id`, `@title-only`, `#tag`, body/title text), status and
  lane selectors, `Filter by tags` (multi-select, OR semantics, plus an
  `untagged` sentinel), an include-done toggle and `Clear all`.
  Status, lane and tags open matching **attached sidebar panels**, not
  browser-native dropdowns or a centered filtering dialog. Panels align to
  the sidebar, highlight their trigger, and stay within the available
  viewport. Lane and tag dropdowns have optional keyword search: an empty
  query shows every entry, and typing filters the full catalog using
  case-insensitive AND matching (for example, `platform api` matches both
  words anywhere in the name). There is no result cap or forced narrowing.
  The task-header lane/tag pickers use the same search behavior. Typing
  does not change a filter or task membership until you choose an entry.
  Tag selection stays open for batch picking, even when the
  filtered list's fallback task changes. Selected tags render as removable tokens. Search runs against
  the full task pool first, then intersects with the structured filters, so
  `#tag` still resolves exactly even when matching tasks live in another
  lane. The **Tasks** section lists the filtered tasks (status dot, title,
  `Pn` chip, task ID and status) with a `+` for a new untitled task.
  Theme, `Manage lanes`, `Manage tags` and `Back up now` stay at the foot of
  the sidebar. Filters govern the list
  only — the explicitly selected task never changes under you; if it falls
  outside the filters the workspace says so and offers `Clear filters`.
  `Manage lanes` / `Manage tags` are explicit modes (rename, color, sort,
  delete with safety: cannot delete `now` or non-empty lanes; tag deletion
  shows the cascade count) with a `Back to tasks` affordance; entering them
  never changes filters.
- **Document** (center) — tasks open in your saved Read/Edit/Split mode
  (Read is the default for a new browser). The header
  shows `[id]` once and a large wrapping title—click it (or focus it and
  press Enter/Space) to edit in place. Enter/Escape finish editing and return
  focus to the title; blur flushes without stealing focus. The quiet property
  row has `Lane: …`, `Priority: Pn` / `Set priority` (integer or blank to
  clear), removable tag pills, and a single `+` button to add tags. Each
  rounded pill is compact at rest and smoothly expands its `×` control on
  hover or keyboard focus—no reserved empty remove-button space. Touch
  devices keep the remove target visible. Clicking (or keyboard-activating) a
  tag pill's label appends that tag to the sidebar tag filter (idempotent,
  never toggles it off); the `×` instead detaches the tag from this task, not
  the tag definition. Tag additions
  and removals use the API's delta modes rather than replacing a stale tag list. The workspace toolbar keeps the smart next-status action
  (`Move to review` / `Mark done` / `Unblock` / `Reopen`), status popup,
  `Focus reading` / `Show navigation`, and a `⋯` task-actions menu holding
  `Delete task` (confirmed). The title and prose share an inset reading column.
  One tablist — **Document / Activity / Related / Authors** — and, on the
  Document tab, a **Read / Edit / Split** switch. Your choice is saved in
  browser localStorage and reused across task switches, reloads and new tabs;
  only the preference enum is stored, never raw task drafts. Heading links
  temporarily reveal Read without changing the saved preference. Read renders sanitized
  Markdown (GFM tables, task lists, code with copy controls, Mermaid
  diagrams, clickable `@id`/`#tag` refs) with an outline rail; Edit and
  Split use the same CodeMirror instance, which stays mounted (cursor, undo
  and pending edits survive switching modes or tabs). Edits autosave
  (600 ms idle / 3 s max; `Cmd/Ctrl + S` flushes), external changes to a
  dirty field show Apply / Keep my changes, and unsaved drafts are kept in
  memory per task while you navigate.
- **Activity** (a Document tab, not a third column) — the task's updates as
  newest-first expandable cards (summary, author, time, severity, rendered
  body + Markdown source). A collapsed `+ Post update` composer sits after
  the thread; drafts are kept per task. **Related** shows referenced-by /
  references / shared-tag buckets with an explicit loading, error + retry
  and confirmed-empty state; **Authors** is the per-task rollup.

Rendering is a single sanitized boundary: Markdown → `marked` → DOMPurify
(HTML profile: no scripts, styles, forms, iframes, raw SVG/MathML,
`javascript:`/`data:` URLs) and Mermaid → `mermaid.render` in an inert
staging element → DOMPurify (SVG profile) → the reader. Documents without
diagrams never load the Mermaid chunk.

Motion is deliberately short: 90 ms for control feedback, 140 ms for menus
and content, and 180 ms for drawers. State and focus changes never wait for
animation; dismissal removes the live surface immediately. Reduced-motion
preferences disable decorative animations and transitions, including when
changed while a surface is open. Metadata/SSE refreshes don't replay the
unchanged document's reveal animation. Tag remove controls use a localized
140 ms width/fade reveal; this does not animate document/editor dimensions.

### Keyboard

No single-key hotkeys (they hijack typing in inputs). Globals:

- `Cmd/Ctrl + P` or `Cmd/Ctrl + K` — command palette (command / search mode)
- `Cmd/Ctrl + /` — reveal Activity, expand the composer and focus it
- `Cmd/Ctrl + Enter` — post the update (while focused in the composer)
- `Cmd/Ctrl + S` — flush the description/title autosave now (inside the editor)
- `Esc` — close palette → modal → popovers / drawer / drag tray

Quick body-mode shortcuts follow the controls' left-to-right order:

| Mode | Mac | Windows / Linux |
| --- | --- | --- |
| Read | `Cmd + Option + 1` | `Ctrl + Alt + 1` |
| Edit | `Cmd + Option + 2` | `Ctrl + Alt + 2` |
| Split | `Cmd + Option + 3` | `Ctrl + Alt + 3` |

Use the number row and **left Alt** on Windows/Linux; AltGr character input
is left untouched. The shortcuts work from CodeMirror, focus the selected
surface, and save your mode preference. They are suspended while dialogs,
menus or navigation own the keyboard, and ignore IME/handled events and
held-key repeats. The mode control shows the chord modifier once as a
"super key" (⌘⌥ / Ctrl+Alt) with a per-button digit (1/2/3); full hints
stay in tooltips and palette commands.

These avoid the common browser tab-selection (`Cmd/Ctrl + 1–9`), reload,
search and save shortcuts listed by [Chrome](https://support.google.com/chrome/answer/157179),
[Safari](https://support.apple.com/guide/safari/keyboard-and-other-shortcuts-cpsh003/mac)
and [Edge](https://support.microsoft.com/en-us/microsoft-edge/keyboard-shortcuts-in-microsoft-edge-50d3edab-30d9-c7e4-21ce-37fe2713cfad).
Custom OS/extension mappings can still intercept them. Alt-key handling follows
[the documented platform differences](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/getModifierState).

Inside the Document tablist: `←`/`→`/`Home`/`End` move focus between tabs,
`Enter`/`Space` activate the focused tab. Sidebar filter panels are nonmodal:
`↑`/`↓`/`Home`/`End` navigate choices, `Enter`/`Space` choose, and `Esc` closes
the panel and returns focus to its trigger. Outside clicks dismiss without
stealing focus. The palette's `Filter by tags…` command reveals this same
sidebar panel, including on phones and from focus reading.

Dialogs (palette, lane/tag editors, confirmations, the mobile navigation
drawer) remain native modal dialogs: Tab is trapped, the background is inert,
and focus returns to the opener on close. Opening a filter inside mobile
navigation does not open another dialog or dismiss the drawer.

The command palette is the primary interface for everything: new task,
switch task (global search — selecting a result keeps your filters), Read
document / Edit description / Split / Edit title, Post an update, change
status / priority / tags, lane filter / edit / delete, Manage lanes /
Manage tags, theme. Type to filter, `↑`/`↓` to navigate, `Enter` to execute.

### Drag & drop

Start dragging a task row and a transient **Move to lane** tray appears at
the bottom of the navigation column; drop the task on a lane to move it.
The tray is not a filter list and disappears when the drag ends (or on
`Esc`). The `Lane:` control in the header is the click/keyboard/touch
alternative.


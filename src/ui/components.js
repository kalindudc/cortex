// components.js — All Preact components for the cortex dashboard.
//
// Imports the data layer from ./state.js and presents it. Single file because
// the components are densely cross-referenced (e.g. ActiveTaskPane embeds
// EditableTaskBody + PostUpdateForm + StatusPopover; CommandPalette references
// every action; ModalRoot dispatches to LaneEditModal). Splitting further
// would mean threading the same imports through 6+ files for no win.

import { h } from "https://esm.sh/preact@10.24";
import { useEffect, useRef } from "https://esm.sh/preact@10.24/hooks";
// useSignal returns a signal that's stable across re-renders. With plain
// signal() in render the value is replaced every keystroke and inputs freeze.
import { useSignal } from "https://esm.sh/@preact/signals@1.3?deps=preact@10.24";
import htm from "https://esm.sh/htm@3.1";
// CodeMirror 6 — single editor used for BOTH display (readonly) and edit
// modes of the task description. Gives us a built-in line-number gutter,
// active-line highlight, scroll-sync, and soft-wrap for free, themed with
// cortex's design tokens via EditorView.theme(). Loaded from esm.sh so the
// compiled binary stays the same size; replaces the previous custom gutter +
// overlay implementation AND the highlight.js-based markdown source view.
import { EditorState } from "https://esm.sh/@codemirror/state@6";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  placeholder,
} from "https://esm.sh/@codemirror/view@6";
import { defaultKeymap, history, historyKeymap } from "https://esm.sh/@codemirror/commands@6";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6";
import { syntaxHighlighting, HighlightStyle } from "https://esm.sh/@codemirror/language@6";
import { tags as t } from "https://esm.sh/@lezer/highlight@1";

// Auto-resize a textarea to fit its content. Attached as a ref callback so it
// works without re-rendering on every keystroke (which would fight htm). The
// __cortexAutoSized flag prevents double-binding on rerenders — the listener
// stays attached for the textarea's whole lifetime. min-height + viewport-
// capped max-height live in CSS (.autosize) so JS only computes the natural
// height.
const autosizeRef = (el) => {
  if (!el || el.__cortexAutoSized) return;
  el.__cortexAutoSized = true;
  const fit = () => {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };
  el.addEventListener("input", fit);
  // Run once now (next paint) so initial content sizes correctly.
  requestAnimationFrame(fit);
};

// useAutosave — debounced + max-wait commit hook for always-editable inputs.
// Every change calls schedule(); the commit fn fires on whichever comes
// first: 600 ms idle (debounce) or 3000 ms since the first dirty change
// (hard ceiling so a continuous typist still saves periodically). flush()
// commits immediately and is invoked on blur and on unmount so a fast
// task switch (parent key change) never drops the last keystroke.
//
// Errors are swallowed by the caller — commit functions are expected to
// wrap their api call in tryApi at the call site, so this hook does not
// need its own try/catch (matches the pattern in PostUpdateForm.submit).
function useAutosave(commit, idleMs = 600, maxMs = 3000) {
  // commitRef refreshes every render so the latest closure (with current
  // signal values) is what fires when timers tick — mirrors the
  // onChangeRef pattern inside MdEditor.
  const commitRef  = useRef(commit);
  commitRef.current = commit;
  const idleTimer  = useRef(null);
  const maxTimer   = useRef(null);
  const dirty      = useRef(false);

  const flush = () => {
    if (!dirty.current) return;
    if (idleTimer.current) { clearTimeout(idleTimer.current); idleTimer.current = null; }
    if (maxTimer.current)  { clearTimeout(maxTimer.current);  maxTimer.current  = null; }
    dirty.current = false;
    commitRef.current?.();
  };
  const schedule = () => {
    dirty.current = true;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(flush, idleMs);
    // Hard-ceiling timer arms only on the FIRST dirty change of a burst so
    // a continuous typist still gets a periodic flush.
    if (!maxTimer.current) maxTimer.current = setTimeout(flush, maxMs);
  };

  // Unmount-flush: guarantees the previous task's pending edits commit
  // before the new task's EditableTaskBody mounts (parent key=task.id
  // re-mounts on every task switch).
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return { schedule, flush };
}

import {
  // signals
  tasks, lanes, tags, selectedLane, selectedId, statusPopover, newLaneOpen,
  paletteOpen, modal, errorMsg, meAuthor, tab, authors,
  sidebarView, selectedTag, newTagOpen, tagsPopover,
  lanePopover,
  // computed
  tasksInLane, activeTask, inboxList, blockedTasks,
  // sentinel
  UNTAGGED,
  // api + error helpers
  api, showError, tryApi, fetchAuthors,
  // popover bookkeeping
  closeAllPopovers, togglePopover,
  // platform / hint helpers
  kbd,
  // pure helpers
  fmtTime, initial, STATUS, STATUS_LABEL, nextStatusFor, nextActionLabel,
  priorityClass, laneColor, LANE_COLORS, tagColor, tagPillStyleFromHex, isValidTagName,
  // navigation
  moveSelection,
  // theme
  theme, setTheme, toggleTheme,
} from "./state.js";

const html = htm.bind(h);

// Universal "save this form" keydown matcher. Used by every form (new task,
// new lane, edit task, lane edit modal, post update). Fires on Cmd/Ctrl+S
// and Cmd/Ctrl+Enter so muscle memory from any editor (⌘S in macOS, Ctrl+S
// in Win/Linux, ⌘⏎ / Ctrl+⏎ as the universal "submit" gesture) works.
// Returns a keydown handler you attach to the form (or to the focused input,
// for textareas where Enter alone has its own meaning).
const onSubmitKeys = (submit) => (e) => {
  if (e.isComposing) return; // skip mid-IME
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  if (e.key === "Enter" || e.key === "s" || e.key === "S") {
    e.preventDefault();
    e.stopPropagation();
    submit();
  }
};

// ---------- icons (Lucide canonical: viewBox 24, fill none, stroke currentColor) ----------
const ICONS = {
  circle:        '<circle cx="12" cy="12" r="9"/>',
  eye:           '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  ban:           '<circle cx="12" cy="12" r="9"/><line x1="5" y1="5" x2="19" y2="19"/>',
  checkCircle:   '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  star:          '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  pause:         '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  play:          '<polygon points="5 3 19 12 5 21 5 3"/>',
  plus:          '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  chevronDown:   '<polyline points="6 9 12 15 18 9"/>',
  moreHorizontal:'<circle cx="12" cy="12" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  trash:         '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  inbox:         '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  sun:           '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
  moon:          '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  monitor:       '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  keyboard:      '<rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6" y2="10"/><line x1="10" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="14" y2="10"/><line x1="18" y1="10" x2="18" y2="10"/><line x1="6" y1="14" x2="18" y2="14"/>',
  x:             '<line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/>',
  // Lucide hash & home: tag-mode and back-to-lanes buttons in .pane-system.
  hash:          '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
  home:          '<path d="M3 12l9-9 9 9"/><path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10"/>',
  // Used by TagPicker to mark currently-attached tags. Lucide check.
  check:         '<polyline points="20 6 9 17 4 12"/>',
};
function Icon({ name, size = 14, className = "" }) {
  const inner = ICONS[name] || "";
  return html`<svg class=${"icon " + className} width=${size} height=${size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    dangerouslySetInnerHTML=${{ __html: inner }}></svg>`;
}

// Static priority badge. Used by list-row task surfaces (LanesPane,
// TagsPane) where the chip lives INSIDE a <button class="task-row"> — a
// nested <button> would be invalid HTML and would steal the row's click.
// The active-task header instead uses PriorityChipButton (below), which
// morphs into an inline <input> on click.
function PriorityChip({ priority }) {
  return html`<span class=${"priority-chip " + priorityClass(priority)}
    title=${`Priority ${priority} (0 = highest)`}>P${priority}</span>`;
}

// Self-editing variant of PriorityChip used in the active-task header.
// The pill IS the input: clicking the button morphs the same surface into
// a number <input> styled identically to the pill (same border-radius,
// height, padding via the shared .priority-chip class). Enter commits;
// Esc and blur cancel — matches the user's spec for transient inline
// editing without a separate popover.
//
// Why local editing signal instead of a global one: only one priority
// chip is ever rendered (in ActiveTaskPane header), so a global signal
// would be ceremony for nothing; local state also avoids the global
// outside-click cascade re-opening logic that the old popover needed.
function PriorityChipButton({ task }) {
  const editing  = useSignal(false);
  const val      = useSignal(String(task.priority));
  const inputRef = useRef(null);

  // Re-sync from prop when the task's priority changes externally (SSE
  // echo, palette quick-action). Skip while editing so we don't stomp
  // mid-typing.
  useEffect(() => {
    if (!editing.value) val.value = String(task.priority);
  }, [task.priority]);

  // Focus + select on entering edit mode so a single keystroke replaces
  // the value (the common case: P2 → P0). Same setTimeout(0) defensive
  // pattern TagPicker uses to win the race against the post-render paint.
  useEffect(() => {
    if (!editing.value) return;
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
  }, [editing.value]);

  const cancel = () => {
    val.value = String(task.priority);
    editing.value = false;
  };
  const commit = async () => {
    const n = parseInt(val.value, 10);
    editing.value = false;
    if (Number.isNaN(n) || n < 0 || n === task.priority) {
      val.value = String(task.priority);
      return;
    }
    await tryApi(() => api.editTask(task.id, { priority: n }));
  };

  if (editing.value) {
    return html`<input ref=${inputRef} type="number" min="0"
      class=${"priority-chip priority-chip-input " + priorityClass(task.priority)}
      value=${val.value}
      onInput=${e => val.value = e.target.value}
      onKeyDown=${e => {
        if (e.key === "Enter")       { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.stopPropagation(); cancel(); }
      }}
      onBlur=${cancel}
      title="Enter commits, Esc or click-out cancels"/>`;
  }
  return html`<button class=${"priority-chip " + priorityClass(task.priority)}
    title=${`Priority ${task.priority} (0 = highest) — click to edit`}
    onClick=${e => {
      e.stopPropagation();
      // Close any open popover so the editing surface is the only active
      // transient UI — same single-popover-at-a-time invariant.
      closeAllPopovers();
      editing.value = true;
    }}>
    P${task.priority}
  </button>`;
}

// Active-task lane chip. Renders the lane color dot + name as a button
// that (a) opens a popover listing all lanes for one-click moves, and
// (b) is the drag source for moving the active task into another lane via
// the sidebar. The drag handler used to live on the title <h2>, but the
// title is now an editable <input> — dragging text would interfere with
// selection — so the gesture moved here onto a surface that already
// visually represents lane membership.
//
// HTML5 DnD + onClick coexist: the browser does NOT fire `click` after a
// successful drag, so the popover does not pop after a drag. Do NOT call
// e.preventDefault() in either handler — that would break the coexistence.
function LaneChipButton({ task }) {
  return html`<div style="position:relative" data-pop>
    <button class="lane-chip lane-chip-button" data-pop draggable="true"
      title=${`Lane: ${task.lane} — click to move, drag to reorder`}
      onDragStart=${e => e.dataTransfer.setData("application/x-cortex-task-id", String(task.id))}
      onClick=${e => { e.stopPropagation(); togglePopover(lanePopover); }}>
      ${laneColor(task.lane) ? html`<span class="lane-color" style=${`background: ${laneColor(task.lane)}`}></span>` : null}
      <span>${task.lane}</span>
    </button>
    ${lanePopover.value ? html`<${LanePicker} task=${task}/>` : null}
  </div>`;
}

// Lane picker built on the generic Picker primitive: search input + arrow
// nav + Enter to select. Single-select (replace, not toggle); clicking or
// Entering a row moves the task to that lane and closes the picker. No
// create-row affordance — new lanes are managed via the sidebar's New Lane
// flow; auto-creating from inside the picker would conflate "move to
// existing" and "create new" intents on the same surface.
function LanePicker({ task }) {
  // Sort by name for predictable ordering. lanes.value is API-order
  // (insertion); the picker uses alphabetical so search hits feel stable.
  const sorted = [...lanes.value].sort((a, b) => a.name.localeCompare(b.name));
  const select = (l) => {
    lanePopover.value = false;
    if (l.name === task.lane) return;
    tryApi(() => api.moveLane(task.id, l.name));
  };
  return html`<${Picker}
    items=${sorted}
    filterText=${l => l.name}
    isSelected=${l => l.name === task.lane}
    onSelect=${select}
    placeholder="Search lanes\u2026"
    emptyText="no lanes match"
    className="lane-picker"
    renderRow=${({ item: l, isSelected, isCursor, onClick, onMouseMove }) => html`<button
      class=${"picker-row" + (isSelected ? " selected" : "") + (isCursor ? " cursor" : "")}
      onClick=${onClick}
      onMouseMove=${onMouseMove}
      title=${isSelected ? "Current lane" : `Move to ${l.name}`}>
      <span class="picker-check">${isSelected ? html`<${Icon} name="check" size=${12}/>` : null}</span>
      <span class="lane-color" style=${l.color ? `background: ${l.color}` : "background: var(--border)"}></span>
      <span>${l.name}</span>
    </button>`}
  />`;
}

// Single tag rendered as a Primer-IssueLabelToken-style pill: pill shape,
// per-tag background color derived from a hex via the GitHub luminance
// algorithm in styles.css (see .tag-pill). Inline style sets --label-r/g/b
// + --label-h/s/l from the hex; CSS derives perceived-lightness, text
// color (black/white), and border from those. When `color` is missing the
// inline style is empty and the pill falls through to the neutral CSS rule.
//
// `interactive` adds hover affordance + cursor when the pill is itself a
// button (TagsPane rows). Default is non-interactive (popover preview).
function TagPill({ name, color, interactive = false }) {
  const c = color !== undefined ? color : tagColor(name);
  const style = tagPillStyleFromHex(c);
  const cls = "tag-pill" + (c ? " tag-pill-colored" : "") + (interactive ? " tag-pill-interactive" : "");
  return html`<span class=${cls} style=${style}>${name}</span>`;
}

// Always-rendered chip in the active-task header showing 'tags: N'. Click
// opens the TagPicker (replaces the prior read-only popover — the picker is
// now the single source of truth for editing a task's tags, including in
// edit mode). Even at zero tags the chip stays visible so users have a
// discoverable affordance to add the first tag.
//
// Mount discipline: TagPicker is rendered ONLY when tagsPopover.value is
// true (ternary below, NOT a self-gate inside the child). This guarantees a
// fresh mount per open so:
//   - autoFocus on the search input fires every time
//   - useSignal state (cursor, attached snapshot) is fresh per open
// Same pattern as CommandPalette in App() — see the comment block above
// CommandPalette for the full failure mode of the self-gate alternative.
function TagsHeaderChip({ task }) {
  const count = (task.tags || []).length;
  // Tooltip preview of attached tags (if any) so quick hover-inspection works
  // without opening the picker.
  const titleAttr = count > 0
    ? task.tags.map(n => "#" + n).join(" ") + " \u2014 click to manage"
    : "Click to add tags";
  return html`<div style="position:relative" data-pop>
    <button class="tags-chip" data-pop
      title=${titleAttr}
      onClick=${e => { e.stopPropagation(); togglePopover(tagsPopover); }}>
      <span class="tags-chip-label">tags:</span>
      <span class="tags-chip-count">${count}</span>
    </button>
    ${tagsPopover.value ? html`<${TagPicker} task=${task}/>` : null}
  </div>`;
}

// GitHub-labels-style picker: search input + scrollable list with checkmarks
// ---------- generic Picker primitive ------------------------------------
//
// Headless-ish search-and-select dropdown. Owns the search input, query
// filtering, keyboard navigation (ArrowUp/Down, Enter), cursor scroll-into-
// view, mouse-move row sync, and empty-state messaging. The CALLER owns
// what items look like, what "selected" means, and what happens on Enter.
//
// Used today by LanePicker. TagPicker is a richer pre-existing variant
// that COULD migrate later — it has more bespoke layout (attached-first
// stable sort, custom create-row affordance, footer validation message)
// but the core search+nav+cursor mechanics are the same. The optional
// createRow / onCreate props on Picker exist specifically to leave room
// for that migration.
//
// Props:
//   items        : T[]                                          — already sorted by caller
//   filterText   : (item: T) => string                          — returned string is .toLowerCase().includes(query)-matched
//   onSelect     : (item: T) => void                            — fired on row click + Enter on cursor
//   renderRow    : ({item, isSelected, isCursor, onClick, onMouseMove}) => vnode
//   isSelected?  : (item: T) => boolean   (default: () => false)
//   placeholder? : string                  (default: "Search…")
//   emptyText?   : string                  (default: "no results")
//   className?   : string                  — appended to root .popover.picker classes
//   createRow?   : ({query, isCursor, onClick}) => vnode | null   — return non-null to show a create row at the END of the list
//   onCreate?    : (query: string) => void                       — fired when create row is triggered (click or Enter on cursor)
//   footer?      : vnode                                         — rendered below the list
function Picker({
  items,
  filterText,
  onSelect,
  renderRow,
  isSelected = () => false,
  placeholder = "Search\u2026",
  emptyText = "no results",
  className = "",
  createRow,
  onCreate,
  footer,
}) {
  const query    = useSignal("");
  const cursor   = useSignal(0);
  const searchRef = useRef(null);
  const listRef   = useRef(null);

  // Defensive focus — same setTimeout(0) pattern TagPicker uses. Without
  // it, the click that mounted the picker re-focuses the trigger button
  // after the picker's autoFocus runs, leaving keyboard nav broken on
  // first open.
  useEffect(() => {
    searchRef.current?.focus();
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  const q = query.value.trim().toLowerCase();
  const filtered = q
    ? items.filter(it => filterText(it).toLowerCase().includes(q))
    : items;

  // Optional create-row vnode. The CALLER decides whether the create
  // affordance shows for THIS query (e.g. non-empty + no exact match +
  // valid name) by returning null when not applicable. We just append it
  // to the cursor-addressable items list.
  const createNode = createRow
    ? createRow({
        query: query.value.trim(),
        isCursor: cursor.value === filtered.length,
        onClick: () => onCreate?.(query.value.trim()),
      })
    : null;
  const totalRows = filtered.length + (createNode ? 1 : 0);

  // Clamp cursor when the filtered list shrinks (e.g. user typed a more-
  // specific filter and the previous cursor index is now out of bounds).
  if (cursor.value > Math.max(0, totalRows - 1)) cursor.value = Math.max(0, totalRows - 1);

  const triggerCursor = () => {
    if (totalRows === 0) return;
    if (createNode && cursor.value === filtered.length) {
      onCreate?.(query.value.trim());
    } else {
      const it = filtered[cursor.value];
      if (it != null) onSelect(it);
    }
  };

  const onSearchKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (totalRows === 0) return;
      cursor.value = (cursor.value + 1) % totalRows;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (totalRows === 0) return;
      cursor.value = (cursor.value - 1 + totalRows) % totalRows;
    } else if (e.key === "Enter") {
      e.preventDefault();
      triggerCursor();
    }
  };

  const onSearchInput = (e) => {
    query.value = e.target.value;
    cursor.value = 0;
  };

  // Auto-scroll the cursor row into view. block:'nearest' avoids jarring
  // jumps when the row is already visible. Same pattern as TagPicker.
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const el = root.querySelector(".picker-row.cursor");
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor.value, totalRows]);

  return html`<div class=${"popover picker " + className} data-pop style="top: 32px; left: 0">
    <div class="picker-search">
      <input ref=${searchRef} autoFocus
        placeholder=${placeholder}
        value=${query.value}
        onInput=${onSearchInput}
        onKeyDown=${onSearchKey}/>
    </div>
    <div class="picker-list" ref=${listRef}>
      ${totalRows === 0
        ? html`<p class="picker-empty meta">${emptyText}</p>`
        : filtered.map((it, i) => renderRow({
            item: it,
            isSelected: isSelected(it),
            isCursor:   i === cursor.value,
            onClick:    () => onSelect(it),
            onMouseMove: () => { if (cursor.value !== i) cursor.value = i; },
          }))}
      ${createNode}
    </div>
    ${footer ?? null}
  </div>`;
}

// ---------- tag picker (richer, pre-existing) ---------------------------
// for attached tags + footer 'Create #<name>' row when the search has text,
// no exact match, and the name is a valid tag name.
//
// Behavior:
//   - Click a row → toggles the tag on the task (api.setTags with the new set)
//   - Type to filter; case-insensitive substring match. Cursor resets to row 0.
//   - Arrow Down/Up moves a keyboard cursor through (filtered + create row);
//     wraps at edges. Cursor highlight is a subtle bg + accent left-border —
//     visually distinct from the (unhighlighted) attached state.
//   - Enter triggers the cursor row's action (toggle or create).
//   - Outside click / Esc close via app.js's global popover handler.
//
// Layout: attached tags are sorted to the TOP of the list at MOUNT time and
// stay there for the lifetime of this picker open (snapshot in `attachedAtOpen`).
// Toggling a tag does NOT immediately reshuffle the list — next open
// recomputes. Mirrors GitHub's labels picker: stable visual order while open.
//
// Critical: container is .tag-picker (fresh flex/scroll layout). NEVER reuse
// .popover-row here — that's the rigid grid that clamped tag pills to 14px in
// the v3 bug.
function TagPicker({ task }) {
  const search = useSignal("");
  const cursor = useSignal(0);
  // Ref to the scrollable list container so the cursor effect (below) can
  // scoped-querySelector the highlighted row without leaking out of THIS
  // picker instance (defensive against multiple pickers, even though only
  // one mounts at a time today).
  const listRef = useRef(null);
  // Ref + explicit focus on the search input. `autoFocus` alone is NOT
  // reliable in this Preact + htm setup when the picker is mounted as a
  // direct result of a click — the browser focuses the clicked chip button
  // AFTER the picker mounts, stomping on the autoFocus. The setTimeout
  // belt-and-suspenders is the same pattern used by CommandPalette
  // (search there for `inputRef.current?.focus()`); it survives that race.
  // Without this, ArrowDown / Enter inside the search input never fire on
  // first open because the input never had focus to begin with.
  const searchRef = useRef(null);
  useEffect(() => {
    searchRef.current?.focus();
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);
  // Snapshot of attached tag names at THIS picker open. Used only for the
  // partition (attached-first sort), NOT for selection state — selection
  // reads `task.tags` live so the checkmark reflects the latest server state.
  // useSignal initializer runs once per mount; the parent's mount-gate
  // (TagsHeaderChip) guarantees one mount per open.
  const attachedAtOpen = useSignal(new Set(task.tags || []));

  // Partition: attached-first (alphabetical), then everyone else (alphabetical).
  // Computed every render but cheap (≤50 tags). The `attachedAtOpen` set keeps
  // ordering stable while the picker is open; live selection state comes from
  // `attached` below.
  const allByName = [...tags.value].sort((a, b) => a.name.localeCompare(b.name));
  const sorted = [
    ...allByName.filter(t => attachedAtOpen.value.has(t.name)),
    ...allByName.filter(t => !attachedAtOpen.value.has(t.name)),
  ];
  const q = search.value.trim().toLowerCase();
  const filtered = q
    ? sorted.filter(t => t.name.toLowerCase().includes(q))
    : sorted;
  const attached = new Set(task.tags || []);
  const trimmedRaw = search.value.trim();
  const exactMatch = allByName.some(t => t.name === trimmedRaw);
  const canCreate = trimmedRaw.length > 0 && !exactMatch && isValidTagName(trimmedRaw);

  // The list rendered to the user, indexable by cursor. The optional create
  // row is appended; cursor.value addresses both list rows and the create row
  // uniformly.
  const items = canCreate
    ? [...filtered, { __create: true, name: trimmedRaw }]
    : filtered;
  // Clamp cursor in case items shrank (e.g. user typed a more-specific filter).
  if (cursor.value > items.length - 1) cursor.value = Math.max(0, items.length - 1);

  const apply = async (nextSet) => {
    await tryApi(() => api.setTags(task.id, Array.from(nextSet)));
    // Don't close the picker — multi-edit UX. Outside-click handles dismiss.
  };

  const toggle = (name) => {
    const next = new Set(attached);
    if (next.has(name)) next.delete(name); else next.add(name);
    return apply(next);
  };

  const create = async (name) => {
    const n = (name ?? trimmedRaw).trim();
    if (!n || !isValidTagName(n)) return;
    // setTaskTags auto-creates the tag row via INSERT OR IGNORE in store.ts.
    const next = new Set(attached);
    next.add(n);
    await apply(next);
    // Keep the newly-attached tag visible at the top for the rest of this
    // picker session by adding it to the attachedAtOpen snapshot.
    const snap = new Set(attachedAtOpen.value);
    snap.add(n);
    attachedAtOpen.value = snap;
    search.value = "";
    cursor.value = 0;
  };

  const triggerCursor = () => {
    const item = items[cursor.value];
    if (!item) return;
    if (item.__create) create(item.name);
    else toggle(item.name);
  };

  const onSearchKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length === 0) return;
      cursor.value = (cursor.value + 1) % items.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length === 0) return;
      cursor.value = (cursor.value - 1 + items.length) % items.length;
    } else if (e.key === "Enter") {
      e.preventDefault();
      triggerCursor();
    }
  };

  const onSearchInput = (e) => {
    search.value = e.target.value;
    // Reset to top whenever the filter changes so the cursor doesn't sit on
    // a row that just scrolled out of view.
    cursor.value = 0;
  };

  // Auto-scroll the cursor row into view whenever cursor.value changes (or
  // items.length shrinks and clamps the cursor). `block: 'nearest'` only
  // scrolls if the row is actually outside the viewport, so it never causes
  // a jarring jump when the row is already visible. Without this, ArrowDown
  // past the visible window leaves the highlight invisibly off-screen.
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const el = root.querySelector(".tag-picker-row.cursor");
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor.value, items.length]);

  return html`<div class="popover tag-picker" data-pop style="top: 32px; left: 0">
    <div class="tag-picker-search">
      <input ref=${searchRef} autoFocus
        placeholder="Search or create tag\u2026"
        value=${search.value}
        onInput=${onSearchInput}
        onKeyDown=${onSearchKey}/>
    </div>
    <div class="tag-picker-list" ref=${listRef}>
      ${items.length === 0
        ? html`<p class="tag-picker-empty meta">no tags match\u2014type a new name to create one</p>`
        : items.map((it, i) => {
            const isCursor = i === cursor.value;
            if (it.__create) {
              return html`<button
                class=${"tag-picker-row tag-picker-create-row" + (isCursor ? " cursor" : "")}
                onClick=${() => create(it.name)}
                title=${`Create the tag '${it.name}' and attach it to this task`}>
                <span class="tag-picker-check"><${Icon} name="plus" size=${12}/></span>
                <span class="tag-picker-create-label">Create</span>
                <${TagPill} name=${it.name} color=${null}/>
              </button>`;
            }
            const sel = attached.has(it.name);
            return html`<button
              class=${"tag-picker-row" + (sel ? " selected" : "") + (isCursor ? " cursor" : "")}
              onClick=${() => toggle(it.name)}
              onMouseMove=${() => { if (cursor.value !== i) cursor.value = i; }}
              title=${sel ? "Click to remove" : "Click to add"}>
              <span class="tag-picker-check">
                ${sel ? html`<${Icon} name="check" size=${12}/>` : null}
              </span>
              <${TagPill} name=${it.name} color=${it.color}/>
              <span class="grow"></span>
              <span class="tag-picker-count meta">${it.task_count}</span>
            </button>`;
          })}
    </div>
    ${trimmedRaw && !canCreate && !exactMatch ? html`<div class="tag-picker-foot">
      <p class="meta" style="margin:0; padding:6px 10px">
        invalid tag name (must match [a-z0-9_@-]{1,32})
      </p>
    </div>` : null}
  </div>`;
}

// ---------- theme toggle ----------
// Two-state flip: light ↔ dark. Icon shows the DESTINATION (sun when in dark
// mode, moon when in light mode) so the affordance reads as "click to go
// there" — a convention shared by GitHub, VS Code, Notion, etc.
function ThemeToggle() {
  const isDark   = theme.value === "dark";
  const iconName = isDark ? "sun" : "moon";
  const next     = isDark ? "light" : "dark";
  return html`<button class="btn-icon" onClick=${toggleTheme}
    title=${`Switch to ${next} mode`}
    aria-label=${`Switch to ${next} mode`}>
    <${Icon} name=${iconName}/>
  </button>`;
}

// Shared system-control strip rendered at the top of EVERY sidebar pane so
// the toolbar reads identically whether you are in lanes mode or tags mode.
// Order: home (back to lanes) | tag-mode | theme. The home button is hidden
// in lanes mode — it would be a no-op since we're already home — and the
// tag-mode button is hidden in tags mode for the same reason. This keeps the
// strip from advertising affordances that do nothing.
function SidebarSystemBar() {
  const inTags = sidebarView.value === "tags";
  return html`<div class="pane-system">
    ${inTags ? html`<button class="btn-icon" title="Home (back to lanes)"
      aria-label="Home" onClick=${() => {
        sidebarView.value = "lanes";
        selectedTag.value = null;
      }}>
      <${Icon} name="home"/>
    </button>` : html`<button class="btn-icon" title="Manage tags"
      aria-label="Manage tags" onClick=${() => { sidebarView.value = "tags"; }}>
      <${Icon} name="hash"/>
    </button>`}
    <${ThemeToggle}/>
  </div>`;
}

// ---------- lanes pane ----------
function LanesPane() {
  // useSignal: stable across re-renders. With plain signal() the value reset
  // to "" on every keystroke (mutation -> re-render -> fresh signal) and
  // inputs felt frozen.
  const newLaneName = useSignal("");
  const newTaskTitle = useSignal("");
  // "All tasks" is a *view*, not a lane — it has no color, no editor, no
  // delete. Promote it to its own pane-section above "Lanes" so it doesn't
  // visually hijack a lane slot (where empty color/settings columns made it
  // look broken).
  const totalOpen = tasks.value.filter(t => t.status !== "done").length;
  return html`<aside class="pane pane-lanes">
    ${/* System controls strip — lives at the top of the left sidebar so app-
         level toggles (theme today, settings/profile later) sit above any
         domain content. Right-aligned bare icon buttons; no eyebrow label
         because position + treatment already convey "app chrome". */ ""}
    <${SidebarSystemBar}/>
    <div class="pane-section" style="padding-bottom: 8px">
      <button class=${"view-row" + (selectedLane.value === null ? " selected" : "")}
        onClick=${() => { selectedLane.value = null; selectedId.value = null; }}
        title="Show every task across all lanes">
        <${Icon} name="inbox"/>
        <span class="view-name">All tasks</span>
        <span class="view-count">${totalOpen}</span>
      </button>
    </div>
    ${/* Lanes and Tasks live in SEPARATE scroll surfaces — conceptually they
         answer different questions ("which lane am I in?" vs "which task in
         the current selection?") and merging their scroll context made it
         feel like the lane list was just a header for the task list.

         Lanes section: bounded to 50% of pane height when tasks list is
         also present (so a long lane list can't squeeze tasks out); takes
         all remaining middle space when tasks section is absent. Tasks
         section: takes the remaining vertical room and scrolls internally.
         All wired in CSS via :has() — see .lanes-section / .tasks-section. */ ""}
    <div class="pane-section lanes-section">
      ${/* .section-head is position:sticky inside the scroll container so the
           Lanes title + plus button stay visible as you scroll the lane
           list. The new-lane form (when open) lives in the head too so it
           anchors next to the trigger. */ ""}
      <div class="section-head">
        <div class="row">
          <h1 class="eyebrow grow">Lanes</h1>
          <button class="btn-icon" data-pop title="New lane"
            onClick=${e => { e.stopPropagation(); togglePopover(newLaneOpen); }}>
            <${Icon} name="plus"/>
          </button>
        </div>
        ${newLaneOpen.value ? (() => {
          const submitNewLane = async () => {
            const n = newLaneName.value.trim(); if (!n) return;
            await tryApi(() => api.addLane({name: n})); newLaneName.value = ""; newLaneOpen.value = false;
          };
          return html`<form data-pop style="margin-top:8px"
            onSubmit=${e => { e.preventDefault(); submitNewLane(); }}
            onKeyDown=${onSubmitKeys(submitNewLane)}>
            <input autoFocus placeholder="lane name" style="width:100%; height:28px; padding:4px 8px"
              value=${newLaneName.value} onInput=${e => newLaneName.value = e.target.value}/>
          </form>`;
        })() : null}
      </div>
      <div class="section-body">
        ${lanes.value.map(l => {
          const open = tasks.value.filter(t => t.lane === l.name && t.status !== "done");
          const sel  = selectedLane.value === l.name;
          return html`<button
            class=${"lane-row" + (sel ? " selected" : "")}
            onClick=${() => { selectedLane.value = sel ? null : l.name; selectedId.value = null; }}
            onDragOver=${e => { e.preventDefault(); e.currentTarget.classList.add("dragover"); }}
            onDragLeave=${e => e.currentTarget.classList.remove("dragover")}
            onDrop=${async e => {
              e.currentTarget.classList.remove("dragover");
              const id = Number(e.dataTransfer.getData("application/x-cortex-task-id"));
              if (id) await tryApi(() => api.moveLane(id, l.name));
            }}
            title=${`${open.length} open task${open.length === 1 ? "" : "s"}`}>
            <span class="lane-color" style=${l.color ? `background: ${l.color}` : ""}></span>
            <span class="lane-name">${l.name}</span>
            <span class="lane-count num">${open.length}</span>
            <span class="lane-edit-btn" title="Edit lane"
              onClick=${e => { e.stopPropagation(); modal.value = { kind: "lane-edit", name: l.name }; }}>
              <${Icon} name="moreHorizontal" size=${12}/>
            </span>
          </button>`;
        })}
      </div>
    </div>
    ${tasks.value.length > 0 ? html`<div class="pane-section tasks-section">
      <div class="section-head">
        <h1 class="eyebrow">${selectedLane.value
          ? html`Tasks \u00b7 ${selectedLane.value}`
          : html`All tasks`}</h1>
      </div>
      <div class="section-body">
      ${tasksInLane.value.length === 0 ? html`<p class="meta">no tasks in this lane</p>` :
        tasksInLane.value.map(t => html`<button
          class=${"task-row" + (activeTask.value && t.id === activeTask.value.id ? " active" : "")}
          draggable="true"
          onDragStart=${e => e.dataTransfer.setData("application/x-cortex-task-id", String(t.id))}
          onClick=${() => selectedId.value = t.id}>
          <span class=${"dot dot-status-" + t.status}></span>
          <span class="task-title">${t.title}</span>
          <${PriorityChip} priority=${t.priority}/>
        </button>`)}
      </div>
    </div>` : null}
    <div class="pane-foot">
      ${(() => {
        const submitNewTask = async () => {
          const t = newTaskTitle.value.trim(); if (!t) return;
          const lane = selectedLane.value || "now";
          const created = await tryApi(() => api.addTask({ title: t, lane }));
          newTaskTitle.value = ""; if (created?.id) selectedId.value = created.id;
        };
        return html`<form onSubmit=${e => { e.preventDefault(); submitNewTask(); }}
          onKeyDown=${onSubmitKeys(submitNewTask)}>
          <div class="row">
            <input id="new-task-input" class="grow" placeholder="New task\u2026"
              value=${newTaskTitle.value} onInput=${e => newTaskTitle.value = e.target.value}
              style="height:32px"/>
            <button type="submit" class="btn btn-primary" style="height:32px" title="Add task">
              <${Icon} name="plus"/>
            </button>
          </div>
        </form>`;
      })()}
      <div class="row" style="margin-top:8px; justify-content:space-between">
        <button class="btn" style="height:24px; padding:0 8px"
          onClick=${() => paletteOpen.value = true}>
          <${Icon} name="keyboard" size=${12}/>
          <span>Commands</span>
          <span class="kbd">${kbd("P")}</span>
        </button>
      </div>
    </div>
  </aside>`;
}

// ---------- tags pane ----------
// Sidebar swap-target when sidebarView==="tags". Mirrors LanesPane structure:
//   .pane-system | All-tags view-row | Tags section (list + new-tag form) |
//   pane-foot (Commands palette button).
// Click a tag row → toggle selectedTag (filters the right-pane task list).
// Hover a tag row → reveals an edit affordance that opens TagEditModal.
function TagsPane() {
  const newTagName = useSignal("");
  // Sort tags alphabetically (server already does, but be defensive in case
  // a future tag.changed payload arrives in a different order).
  const sortedTags = [...tags.value].sort((a, b) => a.name.localeCompare(b.name));
  const totalTagged = tasks.value.filter(t => Array.isArray(t.tags) && t.tags.length > 0).length;
  return html`<aside class="pane pane-lanes pane-tags">
    <${SidebarSystemBar}/>
    <div class="pane-section" style="padding-bottom: 8px">
      <button class=${"view-row" + (selectedTag.value === null ? " selected" : "")}
        onClick=${() => { selectedTag.value = null; selectedId.value = null; }}
        title="Show every tagged task across all tags">
        <${Icon} name="hash"/>
        <span class="view-name">All tags</span>
        <span class="view-count">${totalTagged}</span>
      </button>
      <button class=${"view-row" + (selectedTag.value === UNTAGGED ? " selected" : "")}
        onClick=${() => { selectedTag.value = UNTAGGED; selectedId.value = null; }}
        title="Show only tasks that carry no tags">
        <${Icon} name="ban"/>
        <span class="view-name">Untagged</span>
        <span class="view-count">${tasks.value.length - totalTagged}</span>
      </button>
    </div>
    <div class="pane-section lanes-section">
      <div class="section-head">
        <div class="row">
          <h1 class="eyebrow grow">Tags</h1>
          <button class="btn-icon" data-pop title="New tag"
            onClick=${e => { e.stopPropagation(); togglePopover(newTagOpen); }}>
            <${Icon} name="plus"/>
          </button>
        </div>
        ${newTagOpen.value ? (() => {
          const submitNewTag = async () => {
            const n = newTagName.value.trim(); if (!n) return;
            await tryApi(() => api.addTag({ name: n }));
            newTagName.value = ""; newTagOpen.value = false;
          };
          return html`<form data-pop style="margin-top:8px"
            onSubmit=${e => { e.preventDefault(); submitNewTag(); }}
            onKeyDown=${onSubmitKeys(submitNewTag)}>
            <input autoFocus placeholder="tag name (a-z, 0-9, _ @ -)"
              style="width:100%; height:28px; padding:4px 8px"
              value=${newTagName.value} onInput=${e => newTagName.value = e.target.value}/>
          </form>`;
        })() : null}
      </div>
      <div class="section-body">
        ${sortedTags.length === 0
          ? html`<p class="meta">no tags yet</p>`
          : sortedTags.map(tg => {
              const sel = selectedTag.value === tg.name;
              return html`<button
                class=${"lane-row" + (sel ? " selected" : "")}
                onClick=${() => { selectedTag.value = sel ? null : tg.name; selectedId.value = null; }}
                title=${`${tg.task_count} task${tg.task_count === 1 ? "" : "s"} carry #${tg.name}`}>
                <${TagPill} name=${tg.name} color=${tg.color} interactive=${true}/>
                <span class="grow"></span>
                <span class="lane-count num">${tg.task_count}</span>
                <span class="lane-edit-btn" title="Edit tag"
                  onClick=${e => { e.stopPropagation(); modal.value = { kind: "tag-edit", name: tg.name }; }}>
                  <${Icon} name="moreHorizontal" size=${12}/>
                </span>
              </button>`;
            })}
      </div>
    </div>
    ${/* Tasks section: same shape and CSS as LanesPane's tasks-section so a
         tag click in the row above shows the matching tasks in-place. The
         tasksInLane computed already AND-filters by selectedTag, so this is
         pure presentation. Header label adapts: '#tagname' when filtered,
         'All tagged tasks' when not (matches the All-tags view-row above). */ ""}
    ${tasks.value.length > 0 ? html`<div class="pane-section tasks-section">
      <div class="section-head">
        <h1 class="eyebrow">${selectedTag.value === UNTAGGED
          ? html`Untagged tasks`
          : selectedTag.value
            ? html`Tasks \u00b7 #${selectedTag.value}`
            : html`All tagged tasks`}</h1>
      </div>
      <div class="section-body">
        ${(() => {
          // When no tag is selected, show only tasks that carry at least one
          // tag — "All tagged tasks" should never list untagged ones.
          const list = selectedTag.value
            ? tasksInLane.value
            : tasksInLane.value.filter(t => Array.isArray(t.tags) && t.tags.length > 0);
          if (list.length === 0) {
            return html`<p class="meta">${selectedTag.value === UNTAGGED
              ? html`no untagged tasks`
              : selectedTag.value
                ? html`no tasks carry #${selectedTag.value}`
                : html`no tagged tasks yet`}</p>`;
          }
          return list.map(t => html`<button
            class=${"task-row" + (activeTask.value && t.id === activeTask.value.id ? " active" : "")}
            draggable="true"
            onDragStart=${e => e.dataTransfer.setData("application/x-cortex-task-id", String(t.id))}
            onClick=${() => selectedId.value = t.id}>
            <span class=${"dot dot-status-" + t.status}></span>
            <span class="task-title">${t.title}</span>
            <${PriorityChip} priority=${t.priority}/>
          </button>`);
        })()}
      </div>
    </div>` : null}
    <div class="pane-foot">
      <div class="row" style="justify-content:space-between">
        <button class="btn" style="height:24px; padding:0 8px"
          onClick=${() => paletteOpen.value = true}>
          <${Icon} name="keyboard" size=${12}/>
          <span>Commands</span>
          <span class="kbd">${kbd("P")}</span>
        </button>
      </div>
    </div>
  </aside>`;
}

// ---------- status popover ----------
function StatusPopover({ task }) {
  if (!statusPopover.value) return null;
  // Anchor to the right edge of the status pill so the menu extends LEFT.
  // The pill sits on the right side of the header (after the .grow spacer),
  // so left-anchoring would overflow into the inbox pane and trigger a
  // horizontal scroll on the main grid.
  return html`<div class="popover" data-pop style="top: 32px; right: 0">
    ${STATUS.map(s => html`<button class="popover-row" onClick=${async () => {
      statusPopover.value = false;
      await tryApi(() => api.setStat(task.id, s));
    }}>
      <span class=${"dot dot-status-" + s}></span>
      <span>${STATUS_LABEL[s]}</span>
      ${task.status === s ? html`<${Icon} name="checkCircle" size=${12}/>` : html`<span></span>`}
    </button>`)}
  </div>`;
}

// ---------- active task pane ----------
function ActiveTaskPane() {
  const at = activeTask.value;
  if (!at) return html`<section class="pane pane-active">
    <div class="empty">
      <${Icon} name="checkCircle" size=${32}/>
      <div class="empty-title">All caught up</div>
      <div class="empty-sub">Add a task in the lanes pane, or press <span class="kbd">${kbd("P")}</span> to open the command palette.</div>
    </div>
  </section>`;

  const next = nextStatusFor(at.status);
  const nextLabel = nextActionLabel(at.status);

  return html`<section class="pane pane-active">
    <header class="active-header">
      <span class="meta num">[${at.id}]</span>
      <${LaneChipButton} task=${at}/>
      <${PriorityChipButton} task=${at}/>
      <${TagsHeaderChip} task=${at}/>
      <span class="grow"></span>
      <div style="position:relative" data-pop>
        <button class="status-pill" data-pop
          onClick=${e => { e.stopPropagation(); togglePopover(statusPopover); }}
          onDragOver=${e => { e.preventDefault(); e.currentTarget.classList.add("dragover"); }}
          onDragLeave=${e => e.currentTarget.classList.remove("dragover")}>
          <span class=${"dot dot-status-" + at.status}></span>
          <span>${STATUS_LABEL[at.status]}</span>
          <${Icon} name="chevronDown" size=${12}/>
        </button>
        <${StatusPopover} task=${at}/>
      </div>
    </header>

    <div class="active-body">
      ${/* key=${at.id} re-mounts EditableTaskBody on every task switch. The
           previous instance's unmount-flush commits any pending autosave
           before this fresh mount initializes its local title/body signals
           from the new task — so a fast switch never drops keystrokes and
           never lets stale state bleed across tasks. */ ""}
      <${EditableTaskBody} key=${at.id} task=${at}/>
    </div>

    <footer class="active-foot">
      <div class="row" style="margin-bottom:12px">
        <button class="btn btn-primary" onClick=${() => tryApi(() => api.setStat(at.id, next))}>
          <span>${nextLabel}</span>
        </button>
        <span class="grow"></span>
        <span class="meta">Updated ${fmtTime(at.updated)}</span>
        ${/* Dedicated delete button. Visible always (no hidden overflow menu)
             because deletion is a primary destructive action you should be
             able to discover at a glance. The confirm-delete modal still
             gates the actual destruction. */ ""}
        <button class="btn btn-icon btn-danger" title="Delete task"
          onClick=${() => modal.value = { kind: "confirm-delete", id: at.id }}>
          <${Icon} name="trash"/>
        </button>
      </div>
      <${PostUpdateForm} task=${at}/>
    </footer>
  </section>`;
}

// ----- MdEditor: CodeMirror-backed description view --------------------
//
// Always-editable. The editor is the source of truth for in-flight edits;
// callers feed the initial doc via `value` and observe edits via onChange.
// We never push `value` back into the editor after mount — SSE echoes are
// handled at a higher level (EditableTaskBody owns local signals, and a
// `key=${task.id}` on the wrapper re-mounts on task switch so each task
// gets a fresh editor with the new document).
//
// Props:
//   value       — string, INITIAL document only. Not re-applied after mount.
//   onChange    — (newDoc:string) => void; called on every doc edit.
//   onSubmit    — () => void; called on Cmd/Ctrl+S inside the editor.
//   placeholder — string shown by CM6's placeholder extension when the
//                 document is empty (hides on focus, per CM6 default).
//
// Theme: a single EditorView.theme() pulls every color/font from cortex CSS
// variables (var(--bg), var(--text-content), var(--accent-tint), etc.), so
// the editor automatically follows light/dark mode and any future palette
// retune. Markdown source highlighting maps lezer tags to the same tokens
// that the old hljs-based .md-source view used.
const cortexHighlight = HighlightStyle.define([
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: "var(--text)", fontWeight: "700" },
  { tag: t.strong, color: "var(--text)", fontWeight: "700" },
  { tag: t.emphasis, color: "var(--text)", fontStyle: "italic" },
  { tag: t.list, color: "var(--accent)", fontWeight: "600" },
  { tag: t.monospace, color: "var(--accent)" },
  { tag: [t.link, t.url], color: "var(--info)", textDecoration: "underline", textUnderlineOffset: "2px" },
  { tag: t.quote, color: "var(--text-3)", fontStyle: "italic" },
  { tag: t.comment, color: "var(--text-3)", fontStyle: "italic" },
  { tag: t.meta, color: "var(--info)" },
  { tag: t.number, color: "var(--warn)" },
  // NOTE: @lezer/highlight does NOT export a `title` tag (verified against
  // its .d.ts — only `heading`, `heading1`..`heading6` cover header content).
  // Referencing `t.title` here would resolve to undefined and crash
  // HighlightStyle.define on first import. Headings are already styled above.
]);

const cortexCmTheme = EditorView.theme({
  // Editor root is fully transparent so the page's paper-dot pattern (set
  // on .pane-active above) shows through both display and edit modes. Any
  // backgroundColor here would paint a flat "slab" over the dots and make
  // the editor look bolted on. Highlights (.cm-activeLine, selection) are
  // the only painted surfaces — those use --accent-tint intentionally.
  "&": {
    color: "var(--text-content)",
    backgroundColor: "transparent",
    fontSize: "var(--fs-3)",
    fontFamily: "var(--font-mono)",
    height: "100%",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    padding: "6px 0",
    caretColor: "var(--accent)",
    color: "var(--text-content)",
    backgroundColor: "transparent",
  },
  ".cm-line": { padding: "0 8px" },
  ".cm-gutters": {
    // Transparent so the active-body's own background shows through; we
    // intentionally do NOT paint a panel surface here — the gutter is meant
    // to feel like part of the page, not a separate chrome strip. The
    // border-right alone provides enough visual separation from content.
    backgroundColor: "transparent",
    color: "var(--text-3)",
    border: "0",
    borderRight: "1px solid var(--border)",
    fontFamily: "var(--font-mono)",
    userSelect: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 8px 0 10px",
    minWidth: "2.5ch",
    color: "var(--text-3)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--accent-tint)",
    color: "var(--text)",
  },
  ".cm-activeLine": { backgroundColor: "var(--accent-tint)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  // Selection styling. CM6's bundled view default theme ships rules that
  // BEAT naive overrides on both specificity AND !important — we have to
  // match both. The exact CM6 defaults (from @codemirror/view 6.42 source):
  //
  //   &light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground { background: #d7d4f0 }
  //   &dark.cm-focused  > .cm-scroller > .cm-selectionLayer .cm-selectionBackground { background: #233 }
  //   & ::selection, &::selection { background-color: transparent !important }
  //   &::selection, & ::selection { background-color: Highlight !important }
  //
  // We do NOT pass `{ dark: true }` to EditorView.theme below — our theme
  // is variable-driven (CSS custom properties from html[data-theme]) so a
  // single rule serves both modes. But CM's selector defaults to the
  // `&light` branch in that case, which is why the light-purple #d7d4f0
  // bleeds through in dark mode (the bug this block fixes).
  //
  // Two modes:
  //   1. Edit mode — drawSelection() paints <div .cm-selectionBackground>
  //      BEHIND the text. Selector below matches CM's exact 5-class form
  //      so we beat it on tie (we load last) AND adds !important for belt
  //      and suspenders. Text color is unchanged in this mode (the layer
  //      has no text), so contrast = --accent-tint vs --text-content.
  //   2. Display/readonly mode — no drawSelection; native ::selection.
  //      CM defaults use !important so we MUST too, or the system
  //      Highlight color wins.
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, & > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--accent-tint) !important",
  },
  "& ::selection, &::selection": {
    backgroundColor: "var(--accent-tint) !important",
    color: "var(--text) !important",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.5",
    overflow: "auto",
    scrollbarWidth: "thin",
    scrollbarColor: "var(--border-strong) transparent",
  },
  ".cm-scroller::-webkit-scrollbar": { width: "8px", height: "8px" },
  ".cm-scroller::-webkit-scrollbar-track": { background: "transparent" },
  ".cm-scroller::-webkit-scrollbar-thumb": { background: "var(--border-strong)", borderRadius: "4px" },
  ".cm-scroller::-webkit-scrollbar-thumb:hover": { background: "var(--text-3)" },
  "&.cm-focused": { outline: "none" },
});

function MdEditor({ value, onChange, onSubmit, placeholder: phText }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  // Refs for callbacks so the editor (mounted once) always sees the latest
  // closure even though the parent re-renders and passes fresh function
  // identities every time.
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  onChangeRef.current = onChange;
  onSubmitRef.current = onSubmit;

  useEffect(() => {
    const exts = [
      lineNumbers(),
      markdown(),
      syntaxHighlighting(cortexHighlight),
      cortexCmTheme,
      EditorView.lineWrapping,
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      history(),
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => { onSubmitRef.current?.(); return true; } },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
      }),
    ];
    // CodeMirror's placeholder hides on focus, not on non-empty content —
    // acceptable since focus is the moment the user is committing to edit.
    if (phText) exts.push(placeholder(phText));

    const view = new EditorView({
      state: EditorState.create({ doc: value || "", extensions: exts }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount once; the editor is the source of truth for in-flight edits.

  return html`<div class="md-editor" ref=${hostRef}></div>`;
}

// Banner shown above a field when an external write (another agent, the
// CLI) changed the value while the user has unsaved local edits to that
// same field. Apply adopts the external value; Dismiss keeps the user's
// version (next autosave will overwrite the agent's write — explicitly,
// not silently).
function ExternalChangeBanner({ label, incoming, onApply, onDismiss }) {
  // Truncate long bodies in the preview — user clicks Apply to see the
  // full text in the editor. Single-line preview keeps the banner compact.
  const preview = (incoming || "(empty)").replace(/\s+/g, " ").trim();
  const display = preview.length > 120 ? preview.slice(0, 117) + "\u2026" : preview;
  return html`<div class="external-change-banner" role="status">
    <span class="external-change-icon" aria-hidden="true">↻</span>
    <div class="external-change-text">
      <strong>${label} updated externally</strong>
      <p class="external-change-preview">${display}</p>
    </div>
    <div class="external-change-actions">
      <button type="button" class="btn btn-primary" onClick=${onApply}>Apply</button>
      <button type="button" class="btn" onClick=${onDismiss}>Dismiss</button>
    </div>
  </div>`;
}

// Always-editable surface that owns the title input + body MdEditor for
// the active task. Mounted under key=${task.id} by ActiveTaskPane, so a
// task switch re-mounts this component: useSignal initializers re-run
// (fresh title/body from the new task), useAutosave timers reset, and the
// previous instance's unmount-flush commits any pending edit.
//
// Three-signal-per-field state for safe concurrent editing:
//   - localSig    : what the user is currently editing.
//   - serverSig   : last value we know the server has. Updated optimistically
//                   on autosave commit start (rolled back on failure) so our
//                   own SSE echo doesn't read as an external change.
//   - externalSig : pending external value when localSig is dirty AND a
//                   different value arrives via SSE. null = no pending
//                   external. Surfaces the banner above the field.
//
// SSE-watch effect classifies every (server-sourced) prop change into:
//   1. incoming === server                   → no-op (steady state / echo)
//   4. incoming === local                    → converge: serverSig <- incoming
//   2. local === server, server !== incoming → live update: both <- incoming
//   5. else                                  → conflict: external <- incoming
//
// bodyEpoch increments whenever the body MdEditor needs to be re-mounted
// with a new initial value (Apply or live-update case 2). MdEditor's
// editor instance is mount-once for in-flight edit safety, so changing
// bodySig externally doesn't refresh the visible CodeMirror contents —
// the key={"body-"+epoch} forces a fresh mount. Title is a controlled
// <input> so it auto-syncs from titleSig with no extra plumbing.
function EditableTaskBody({ task }) {
  const titleSig       = useSignal(task.title);
  const bodySig        = useSignal(task.body || "");
  const titleServerSig = useSignal(task.title);
  const bodyServerSig  = useSignal(task.body || "");
  const titleExternal  = useSignal(null);
  const bodyExternal   = useSignal(null);
  const bodyEpoch      = useSignal(0);

  // SSE-watch: title. Fires whenever the parent re-renders us with a new
  // task.title (SSE refresh → tasks.value = ts → task prop changes).
  useEffect(() => {
    const inc = task.title;
    if (inc === titleServerSig.value) return;            // case 1: echo / no news
    if (inc === titleSig.value) {                         // case 4: converge
      titleServerSig.value = inc;
      titleExternal.value  = null;
      return;
    }
    if (titleSig.value === titleServerSig.value) {        // case 2: live update
      titleSig.value       = inc;
      titleServerSig.value = inc;
      titleExternal.value  = null;
      return;
    }
    titleExternal.value = inc;                            // case 5: conflict
  }, [task.title]);

  // SSE-watch: body. Same logic. Bumps bodyEpoch on case 2 so MdEditor
  // re-mounts with the new value (the editor doesn't sync from value
  // after mount).
  useEffect(() => {
    const inc = task.body || "";
    if (inc === bodyServerSig.value) return;
    if (inc === bodySig.value) {
      bodyServerSig.value = inc;
      bodyExternal.value  = null;
      return;
    }
    if (bodySig.value === bodyServerSig.value) {
      bodySig.value       = inc;
      bodyServerSig.value = inc;
      bodyExternal.value  = null;
      bodyEpoch.value++;
      return;
    }
    bodyExternal.value = inc;
  }, [task.body]);

  // Per-field autosave with optimistic serverSig update. Setting
  // serverSig BEFORE the PATCH means our own SSE echo lands as case 1
  // (no false conflict banner from our own write). Rollback on failure
  // restores the prior baseline so the next dirty check is correct.
  const titleSave = useAutosave(async () => {
    const v = titleSig.value;
    const prev = titleServerSig.value;
    titleServerSig.value = v;
    try {
      await tryApi(() => api.editTask(task.id, { title: v }));
    } catch (err) {
      titleServerSig.value = prev;
      throw err;
    }
  });
  const bodySave = useAutosave(async () => {
    const v = bodySig.value;
    const prev = bodyServerSig.value;
    bodyServerSig.value = v;
    try {
      await tryApi(() => api.editTask(task.id, { body: v || null }));
    } catch (err) {
      bodyServerSig.value = prev;
      throw err;
    }
  });

  // Banner actions. Apply replaces local + server with the external value
  // (no save needed — server already has it). Dismiss just clears the
  // banner; the next autosave will PATCH local, overwriting the external,
  // explicitly. Body Apply also bumps bodyEpoch to push the new doc into
  // the CodeMirror editor.
  const applyTitle = () => {
    titleSig.value       = titleExternal.value;
    titleServerSig.value = titleExternal.value;
    titleExternal.value  = null;
  };
  const dismissTitle = () => { titleExternal.value = null; };
  const applyBody = () => {
    bodySig.value       = bodyExternal.value;
    bodyServerSig.value = bodyExternal.value;
    bodyExternal.value  = null;
    bodyEpoch.value++;
  };
  const dismissBody = () => { bodyExternal.value = null; };

  return html`<div class="editable-task-body">
    ${titleExternal.value !== null ? html`<${ExternalChangeBanner}
      label="Title"
      incoming=${titleExternal.value}
      onApply=${applyTitle}
      onDismiss=${dismissTitle}/>` : null}
    <input class="title-input"
      value=${titleSig.value}
      placeholder="Task title"
      onInput=${e => { titleSig.value = e.target.value; titleSave.schedule(); }}
      onBlur=${() => titleSave.flush()}/>
    ${bodyExternal.value !== null ? html`<${ExternalChangeBanner}
      label="Body"
      incoming=${bodyExternal.value}
      onApply=${applyBody}
      onDismiss=${dismissBody}/>` : null}
    ${/* Body autosave does NOT register an explicit blur handler — some
         browsers do not fire blur on tab-hide. The 600 ms idle timer
         catches normal focus moves; the 3 s max-wait is the worst-case
         safety net; Cmd/Ctrl+S inside the editor flushes immediately
         (onSubmit -> bodySave.flush). */ ""}
    <${MdEditor}
      key=${"body-" + bodyEpoch.value}
      value=${bodySig.value}
      placeholder="Add a description\u2026"
      onChange=${v => { bodySig.value = v; bodySave.schedule(); }}
      onSubmit=${() => bodySave.flush()}/>
  </div>`;
}

function PostUpdateForm({ task }) {
  const summary = useSignal("");
  // Default to the resolved "me" identity (gh username -> git -> hostname).
  // If meAuthor resolves AFTER mount and the user hasn't typed anything yet,
  // pick up the resolved value via the effect below.
  const author = useSignal(meAuthor.value);
  useEffect(() => {
    if (author.value === "me" || author.value === "") author.value = meAuthor.value;
  }, [meAuthor.value]);
  const len = summary.value.length;
  // Single submit path called from both onSubmit and the global Cmd/Ctrl+Enter
  // handler in app.js. We re-publish on every render so window.__cortexPostUpdate
  // always points at the current closure (with the current task + signal values).
  const submit = async () => {
    if (!summary.value.trim()) return;
    await tryApi(() => api.postUpd(task.id, { author: author.value, summary: summary.value }));
    summary.value = "";
  };
  window.__cortexPostUpdate = submit;
  return html`<form class="compose"
    onSubmit=${e => { e.preventDefault(); submit(); }}
    onKeyDown=${onSubmitKeys(submit)}>
    <textarea id="post-update-input" class="autosize" ref=${autosizeRef}
      placeholder="Post an update\u2026" rows="2"
      maxlength="1024"
      value=${summary.value}
      onInput=${e => summary.value = e.target.value}
      onKeyDown=${onSubmitKeys(submit)}/>
    <div class="compose-foot">
      <input class="author" title="Author (default from gh / git / hostname)"
        value=${author.value} onInput=${e => author.value = e.target.value}/>
      <span class="grow"></span>
      <span class=${"char-counter num" + (len > 1000 ? " warn" : "")}>${len}/1024</span>
      ${/* Hotkey hints live in the foot strip so they stay visible while the
           user is typing (placeholder hints disappear the moment text is
           entered — useless when discoverability matters most). */ ""}
      <span class="compose-hint meta" title="Focus this textarea from anywhere">
        <span class="kbd">${kbd("/")}</span> focus
      </span>
      <button type="submit" class="btn btn-primary" style="height:24px; padding:0 10px">
        <span>Post</span>
        <span class="kbd">${kbd("\u21b5")}</span>
      </button>
    </div>
  </form>`;
}

// ---------- inbox pane ----------
// Two-tab layout: "Updates" (the active task's update thread, the original
// behaviour) and "Authors" (a roll-up of recent author activity loaded
// lazily from /api/authors when the tab is first opened).
function InboxPane() {
  const at = activeTask.value;
  const list = inboxList.value;
  const current = tab.value;
  const selectTab = (t) => {
    tab.value = t;
    // Lazy-load the author roll-up the first time (and on every subsequent
    // click — keeps the table fresh without polling).
    if (t === "authors") fetchAuthors();
  };
  return html`<aside class="pane pane-inbox">
    <div class="tabs">
      <button class=${current === "updates" ? "active" : ""}
        onClick=${() => selectTab("updates")}>Updates</button>
      <button class=${current === "authors" ? "active" : ""}
        onClick=${() => selectTab("authors")}>Authors</button>
    </div>
    ${current === "updates" ? html`<div class="inbox-header">
      <h1 class="eyebrow grow">Inbox</h1>
      ${at ? html`<span class="meta num">${list.length}</span>` : null}
    </div>
    ${list.length === 0 ? html`<div class="empty">
      <${Icon} name="inbox" size=${32}/>
      <div class="empty-title">No updates yet</div>
      <div class="empty-sub">${at ? "Post an update to start a thread." : "Select a task to see its updates."}</div>
    </div>` : list.map(u => html`<div class="inbox-row">
      <div class="row" style="gap:10px; align-items:flex-start">
        <span class="avatar">${initial(u.author)}</span>
        <div class="grow">
          <div class="summary">${u.summary}</div>
          <div class="meta">
            <span class=${"dot dot-status-" + (u.severity === "blocked" ? "blocked" : u.severity === "review" ? "review" : "open")}
              style="width:6px; height:6px"></span>
            <span>${u.author}</span>
            <span>\u00b7</span>
            <span>${fmtTime(u.created)}</span>
          </div>
        </div>
      </div>
    </div>`)}` : authors.value.length === 0 ? html`<div class="empty">
      <${Icon} name="inbox" size=${32}/>
      <div class="empty-title">No author activity in the last 24h.</div>
    </div>` : html`<table class="authors-table">
      <thead>
        <tr><th>Author</th><th>Last seen</th><th>Posts</th></tr>
      </thead>
      <tbody>
        ${authors.value.map(a => html`<tr>
          <td>${a.author}</td>
          <td class="num">${fmtTime(a.last_seen)}</td>
          <td class="num">${a.posts}</td>
        </tr>`)}
      </tbody>
    </table>`}
  </aside>`;
}

// ---------- top bar ----------
// Sticky red banner that surfaces blocked tasks at app level. Renders only
// when there is at least one blocked task; clicking jumps the active
// selection to the first blocked task so the user can review it.
function TopBar() {
  const blocked = blockedTasks.value;
  if (blocked.length === 0) return null;
  const n = blocked.length;
  return html`<div class="topbar blocked"
    onClick=${() => { selectedId.value = blocked[0].id; }}
    title="Jump to the first blocked task">
    <span>\u26a0 ${n} task${n === 1 ? "" : "s"} blocked \u2014 click to review</span>
  </div>`;
}

// ---------- command palette ----------
// Command shape:
//   { id, label, hint?, icon, action }   — leaf: runs and closes the palette
//   { id, label, hint?, icon, submenu }  — branch: clicking dives into a
//                                          new scope; `submenu()` returns
//                                          the next list of commands
//
// Branches keep the root short (one "Edit lane…" entry, not 50). Picking a
// branch pushes it onto the palette's scope stack; Esc / Backspace / clicking
// the breadcrumb pops back. Lazy `submenu` evaluation means we don't build
// per-lane lists until the user actually opens that scope.
function buildCommands() {
  const at = activeTask.value;
  const cmds = [];

  // ----- always-available -----
  cmds.push({ id: "new-task",    label: "New task",              hint: "",       icon: "plus",        action: () => { paletteOpen.value = false; setTimeout(() => document.getElementById("new-task-input")?.focus(), 0); } });
  cmds.push({ id: "post-update", label: "Focus post-update box", hint: kbd("/"), icon: "eye",         action: () => { paletteOpen.value = false; setTimeout(() => document.getElementById("post-update-input")?.focus(), 0); } });
  cmds.push({ id: "next",        label: "Next task",             hint: "",       icon: "chevronDown", action: () => moveSelection(+1) });
  cmds.push({ id: "prev",        label: "Previous task",         hint: "",       icon: "chevronDown", action: () => moveSelection(-1) });

  // ----- active-task scoped -----
  if (at) {
    cmds.push({ id: "set-status", label: "Set status\u2026", hint: `[${at.id}]`, icon: "checkCircle",
      submenu: () => STATUS.filter(s => s !== at.status).map(s => ({
        id: `status-${s}`, label: STATUS_LABEL[s], hint: "", icon: "checkCircle",
        action: () => api.setStat(at.id, s),
      })),
    });
    cmds.push({ id: "set-priority", label: "Set priority\u2026", hint: `[${at.id}]`, icon: "star",
      submenu: () => [0, 1, 2, 3, 5].filter(p => p !== at.priority).map(p => ({
        id: `priority-${p}`, label: `P${p}` + (p === 0 ? " (urgent)" : ""), hint: "", icon: "star",
        action: () => api.editTask(at.id, { priority: p }),
      })),
    });
    cmds.push({ id: "edit-task-tags", label: "Tags\u2026", hint: `[${at.id}]`, icon: "hash",
      action: () => {
        paletteOpen.value = false;
        // Open the picker on the current active task. The TagsHeaderChip
        // mounts the picker freshly when tagsPopover flips true (see the
        // mount-discipline note above TagsHeaderChip). closeAllPopovers()
        // first preserves the single-popover-at-a-time invariant.
        closeAllPopovers();
        tagsPopover.value = true;
        // Refocus the search input on next tick so keyboard flow stays
        // continuous (palette → picker, no mouse needed).
        setTimeout(() => document.querySelector(".tag-picker-search input")?.focus(), 0);
      },
    });
    cmds.push({ id: "delete-task", label: "Delete task\u2026", hint: `[${at.id}]`, icon: "trash",
      action: () => modal.value = { kind: "confirm-delete", id: at.id } });
  }

  // ----- lane scoped (one root entry per verb) -----
  cmds.push({ id: "filter-lane", label: "Filter by lane\u2026", hint: "", icon: "inbox",
    submenu: () => [
      { id: "lane-all", label: "All lanes", hint: "", icon: "inbox",
        action: () => { selectedLane.value = null; selectedId.value = null; } },
      ...lanes.value.map(l => ({
        id: `lane-${l.name}`, label: l.name, hint: "", icon: "inbox",
        action: () => { selectedLane.value = l.name; selectedId.value = null; },
      })),
    ],
  });
  if (lanes.value.length > 0) {
    cmds.push({ id: "edit-lane", label: "Edit lane\u2026", hint: "", icon: "eye",
      submenu: () => lanes.value.map(l => ({
        id: `lane-edit-${l.name}`, label: l.name, hint: "", icon: "eye",
        action: () => modal.value = { kind: "lane-edit", name: l.name },
      })),
    });
  }
  // Delete lane: only show if there's at least one deletable lane (not 'now',
  // no tasks). If none qualify, hide the verb entirely — a sub-menu with zero
  // entries is a dead end.
  const deletable = lanes.value.filter(l => l.name !== "now" && !tasks.value.some(t => t.lane === l.name));
  if (deletable.length > 0) {
    cmds.push({ id: "delete-lane", label: "Delete lane\u2026", hint: "", icon: "trash",
      submenu: () => deletable.map(l => ({
        id: `lane-del-${l.name}`, label: l.name, hint: "", icon: "trash",
        action: () => modal.value = { kind: "confirm-lane-delete", name: l.name },
      })),
    });
  }
  cmds.push({ id: "new-lane", label: "New lane\u2026", hint: "", icon: "plus",
    action: () => { closeAllPopovers(); newLaneOpen.value = true; setTimeout(() => document.querySelector(".pane-lanes input")?.focus(), 0); } });

  // ----- tag scoped (sidebar mode + filter + edit + new) -----
  cmds.push({
    id: "sidebar-mode",
    label: sidebarView.value === "tags" ? "Switch to lane mode" : "Switch to tag mode",
    hint: "", icon: sidebarView.value === "tags" ? "home" : "hash",
    action: () => {
      const goingHome = sidebarView.value === "tags";
      sidebarView.value = goingHome ? "lanes" : "tags";
      if (goingHome) selectedTag.value = null;
    },
  });
  if (tags.value.length > 0) {
    cmds.push({ id: "filter-tag", label: "Filter by tag\u2026", hint: "", icon: "hash",
      submenu: () => [
        { id: "tag-all", label: "All tags", hint: "", icon: "hash",
          action: () => { selectedTag.value = null; selectedId.value = null; } },
        ...[...tags.value].sort((a, b) => a.name.localeCompare(b.name)).map(tg => ({
          id: `tag-${tg.name}`, label: `#${tg.name}`, hint: `${tg.task_count}`, icon: "hash",
          action: () => { selectedTag.value = tg.name; selectedId.value = null; },
        })),
      ],
    });
    cmds.push({ id: "edit-tag", label: "Edit tag\u2026", hint: "", icon: "eye",
      submenu: () => [...tags.value].sort((a, b) => a.name.localeCompare(b.name)).map(tg => ({
        id: `tag-edit-${tg.name}`, label: `#${tg.name}`, hint: "", icon: "eye",
        action: () => modal.value = { kind: "tag-edit", name: tg.name },
      })),
    });
  }
  cmds.push({ id: "new-tag", label: "New tag\u2026", hint: "", icon: "plus",
    action: () => {
      sidebarView.value = "tags";
      closeAllPopovers();
      newTagOpen.value = true;
      setTimeout(() => document.querySelector(".pane-tags input")?.focus(), 0);
    },
  });

  // ----- system -----
  cmds.push({
    id: "theme-toggle",
    label: theme.value === "dark" ? "Switch to light mode" : "Switch to dark mode",
    hint: "", icon: theme.value === "dark" ? "sun" : "moon",
    action: () => toggleTheme(),
  });
  return cmds;
}

// CommandPalette assumes it is conditionally rendered by the parent (so that
// each open is a true mount with fresh hook state). DO NOT add an
// `if (!paletteOpen.value) return null` early-return here — returning null
// from a component does NOT unmount it in Preact, the hook state persists,
// and useEffect(..., []) would fire only the very first time. That's the
// exact bug that broke autofocus on the second and subsequent opens.
function CommandPalette() {
  const query = useSignal("");
  const cursor = useSignal(0);
  // Scope stack: each entry is { title, cmds }. Empty stack = root scope
  // (rebuilt from buildCommands() every render so it tracks live signals).
  // Non-empty = inside one or more sub-menus. This is what lets us collapse
  // "50 lanes × 3 verbs = 150 root entries" down to 3 verbs that dive into
  // pickers on demand.
  const stack = useSignal([]);
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus();
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const el = document.querySelector(".palette-list .palette-row.active");
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  });

  const cmds = stack.value.length === 0
    ? buildCommands()
    : stack.value[stack.value.length - 1].cmds;
  const q = query.value.trim().toLowerCase();
  const filtered = q ? cmds.filter(c => c.label.toLowerCase().includes(q) || c.id.includes(q)) : cmds;
  const safeCursor = Math.min(cursor.value, Math.max(0, filtered.length - 1));
  const inSubmenu = stack.value.length > 0;

  // Pop one scope level. Resets query + cursor so the parent menu shows
  // unfiltered. Re-focuses the input — keyboard users should never lose
  // focus when navigating in/out of sub-menus.
  const popScope = () => {
    stack.value = stack.value.slice(0, -1);
    query.value = "";
    cursor.value = 0;
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  // Push a new scope. Lazily evaluates submenu() so per-lane lists aren't
  // built unless the user actually dives in.
  const pushScope = (cmd) => {
    stack.value = [...stack.value, { title: cmd.label.replace(/\u2026$/, ""), cmds: cmd.submenu() }];
    query.value = "";
    cursor.value = 0;
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const exec = async (cmd) => {
    if (cmd.submenu) { pushScope(cmd); return; }
    paletteOpen.value = false;
    try { await cmd.action(); } catch (e) { showError(e); }
  };

  return html`<div class="overlay overlay-top" onClick=${e => { if (e.target.classList.contains("overlay") || e.target.classList.contains("overlay-top")) paletteOpen.value = false; }}>
    <div class="modal palette">
      ${inSubmenu ? html`<div class="palette-breadcrumb">
        <button class="btn-icon" onClick=${popScope} title="Back" aria-label="Back to previous menu">
          <${Icon} name="chevronDown" className="rotate-90-cw"/>
        </button>
        <span class="meta">${stack.value.map(s => s.title).join(" / ")}</span>
      </div>` : null}
      <input ref=${inputRef} class="palette-input"
        placeholder=${inSubmenu ? `Pick a ${stack.value[stack.value.length - 1].title.toLowerCase()}\u2026` : "Type a command\u2026"}
        autoFocus
        value=${query.value}
        onInput=${e => { query.value = e.target.value; cursor.value = 0; }}
        onKeyDown=${e => {
          if (e.key === "ArrowDown")    { e.preventDefault(); cursor.value = Math.min(filtered.length - 1, safeCursor + 1); }
          else if (e.key === "ArrowUp") { e.preventDefault(); cursor.value = Math.max(0, safeCursor - 1); }
          else if (e.key === "Enter")   { e.preventDefault(); const c = filtered[safeCursor]; if (c) exec(c); }
          // Submenu navigation. ArrowLeft / Backspace (when query empty) /
          // Escape all pop one level. At root, Escape falls through to the
          // global handler in app.js which closes the palette.
          else if (inSubmenu && e.key === "Escape")    { e.preventDefault(); e.stopPropagation(); popScope(); }
          else if (inSubmenu && e.key === "ArrowLeft" && query.value === "") { e.preventDefault(); popScope(); }
          else if (inSubmenu && e.key === "Backspace" && query.value === "") { e.preventDefault(); popScope(); }
        }}/>
      <div class="palette-list">
        ${filtered.length === 0 ? html`<div class="meta" style="padding:12px">No matching commands</div>` :
          filtered.map((c, i) => html`<button class=${"palette-row" + (i === safeCursor ? " active" : "")}
            onMouseEnter=${() => cursor.value = i}
            onClick=${() => exec(c)}>
            <${Icon} name=${c.icon}/>
            <span class="grow">${c.label}</span>
            ${c.hint ? html`<span class="meta num">${c.hint}</span>` : null}
            ${c.submenu ? html`<${Icon} name="chevronDown" className="rotate-90-ccw"/>` : null}
          </button>`)}
      </div>
      <div class="palette-foot meta">
        <span><span class="kbd">\u2191</span><span class="kbd">\u2193</span> navigate</span>
        <span><span class="kbd">\u21b5</span> select</span>
        <span><span class="kbd">Esc</span> ${inSubmenu ? "back" : "close"}</span>
      </div>
    </div>
  </div>`;
}

// ---------- modals ----------
function ModalRoot() {
  const m = modal.value;
  if (!m) return null;
  const close = () => modal.value = null;
  if (m.kind === "confirm-delete") {
    return html`<div class="overlay" onClick=${e => { if (e.target.classList.contains("overlay")) close(); }}>
      <div class="modal">
        <h2>Delete task?</h2>
        <p class="meta" style="margin:0">This permanently removes the task and its updates. Cannot be undone.</p>
        <div class="modal-actions">
          <button class="btn" onClick=${close}>Cancel</button>
          <button class="btn btn-primary" onClick=${async () => {
            await tryApi(() => api.delTask(m.id)); selectedId.value = null; close();
          }}>Delete</button>
        </div>
      </div>
    </div>`;
  }
  if (m.kind === "lane-edit") {
    return html`<${LaneEditModal} name=${m.name} close=${close}/>`;
  }
  if (m.kind === "tag-edit") {
    return html`<${TagEditModal} name=${m.name} close=${close}/>`;
  }
  if (m.kind === "confirm-tag-delete") {
    return html`<div class="overlay" onClick=${e => { if (e.target.classList.contains("overlay")) close(); }}>
      <div class="modal">
        <h2>Delete tag <span class="meta">#${m.name}</span>?</h2>
        <p class="meta" style="margin:0">${m.taskCount > 0
          ? `${m.taskCount} task${m.taskCount === 1 ? " carries" : "s carry"} this tag. Deleting will remove the tag from those tasks (the tasks themselves are NOT deleted).`
          : "This tag is not used by any task."}</p>
        <div class="modal-actions">
          <button class="btn" onClick=${close}>Cancel</button>
          <button class="btn btn-primary" style="background:var(--err)" onClick=${async () => {
            await tryApi(() => api.delTag(m.name, m.taskCount > 0));
            if (selectedTag.value === m.name) selectedTag.value = null;
            close();
          }}>Delete tag</button>
        </div>
      </div>
    </div>`;
  }
  if (m.kind === "confirm-lane-delete") {
    return html`<div class="overlay" onClick=${e => { if (e.target.classList.contains("overlay")) close(); }}>
      <div class="modal">
        <h2>Delete lane <span class="meta">${m.name}</span>?</h2>
        <p class="meta" style="margin:0">The lane must be empty. The default <code>now</code> lane cannot be deleted.</p>
        <div class="modal-actions">
          <button class="btn" onClick=${close}>Cancel</button>
          <button class="btn btn-primary" style="background:var(--err)" onClick=${async () => {
            await tryApi(() => api.delLane(m.name));
            if (selectedLane.value === m.name) selectedLane.value = null;
            close();
          }}>Delete lane</button>
        </div>
      </div>
    </div>`;
  }
  return null;
}

function LaneEditModal({ name, close }) {
  const lane = lanes.value.find(l => l.name === name);
  if (!lane) { close(); return null; }
  const renameTo = useSignal(lane.name);
  const color    = useSignal(lane.color || null);
  const sort     = useSignal(String(lane.sort));
  const isDefault= lane.name === "now";
  const inUse    = tasks.value.some(t => t.lane === lane.name);
  const save = async () => {
    const fields = {};
    if (color.value !== (lane.color || null)) fields.color = color.value;
    const s = parseInt(sort.value, 10); if (Number.isFinite(s) && s !== lane.sort) fields.sort = s;
    if (renameTo.value && renameTo.value !== lane.name) fields.rename = renameTo.value.trim();
    if (Object.keys(fields).length === 0) { close(); return; }
    await tryApi(() => api.editLane(lane.name, fields));
    // If we renamed and this lane was selected, follow the rename.
    if (fields.rename && selectedLane.value === lane.name) selectedLane.value = fields.rename;
    close();
  };
  return html`<div class="overlay" onClick=${e => { if (e.target.classList.contains("overlay")) close(); }}>
    <div class="modal" style="max-width: 420px" onKeyDown=${onSubmitKeys(save)}>
      <div class="row">
        <h2 class="grow">Edit lane</h2>
        <button class="btn-icon" onClick=${close}><${Icon} name="x"/></button>
      </div>
      <label class="col" style="gap:4px">
        <span class="meta">Name</span>
        <input value=${renameTo.value} onInput=${e => renameTo.value = e.target.value}
          disabled=${isDefault} title=${isDefault ? "the 'now' lane cannot be renamed" : ""}/>
      </label>
      <div class="col" style="gap:4px">
        <span class="meta">Color</span>
        <div class="color-grid">
          ${LANE_COLORS.map(c => html`<button
            class=${"color-swatch" + (color.value === c ? " selected" : "") + (c === null ? " clear" : "")}
            style=${c ? `background: ${c}` : ""}
            title=${c || "no color"}
            onClick=${e => { e.preventDefault(); color.value = c; }}/>`)}
        </div>
      </div>
      <label class="col" style="gap:4px">
        <span class="meta">Sort order <span class="meta" style="opacity:0.7">(lower = higher in the list)</span></span>
        <input type="number" value=${sort.value} onInput=${e => sort.value = e.target.value}/>
      </label>
      <div class="row" style="justify-content:space-between">
        <button class="btn btn-danger"
          disabled=${isDefault || inUse}
          title=${isDefault ? "cannot delete 'now'" : inUse ? `${tasks.value.filter(t => t.lane === lane.name).length} task(s) in this lane` : "delete lane"}
          onClick=${() => modal.value = { kind: "confirm-lane-delete", name: lane.name }}>
          <${Icon} name="trash" size=${12}/>
          <span>Delete lane</span>
        </button>
        <div class="row">
          <button class="btn" onClick=${close}>Cancel</button>
          <button class="btn btn-primary" onClick=${save}>Save</button>
        </div>
      </div>
    </div>
  </div>`;
}

// ---------- tag edit modal ----------
// Mirrors LaneEditModal: rename, color picker (reuses LANE_COLORS palette and
// .color-grid CSS), delete (cascades join rows when in-use; the confirm step
// gives the user the impact count). Tag names are validated server-side
// against TAG_NAME_RE; we display the resulting error via the existing toast.
function TagEditModal({ name, close }) {
  const tg = tags.value.find(t => t.name === name);
  if (!tg) { close(); return null; }
  const renameTo = useSignal(tg.name);
  const color    = useSignal(tg.color || null);
  const taskCount = tg.task_count ?? 0;
  const save = async () => {
    const fields = {};
    if (color.value !== (tg.color || null)) fields.color = color.value;
    if (renameTo.value && renameTo.value !== tg.name) fields.rename = renameTo.value.trim();
    if (Object.keys(fields).length === 0) { close(); return; }
    await tryApi(() => api.editTag(tg.name, fields));
    // Follow the rename if this tag was the active filter.
    if (fields.rename && selectedTag.value === tg.name) selectedTag.value = fields.rename;
    close();
  };
  return html`<div class="overlay" onClick=${e => { if (e.target.classList.contains("overlay")) close(); }}>
    <div class="modal" style="max-width: 420px" onKeyDown=${onSubmitKeys(save)}>
      <div class="row">
        <h2 class="grow">Edit tag</h2>
        <button class="btn-icon" onClick=${close}><${Icon} name="x"/></button>
      </div>
      <label class="col" style="gap:4px">
        <span class="meta">Name</span>
        <input value=${renameTo.value}
          onInput=${e => renameTo.value = e.target.value}
          placeholder="a-z, 0-9, _ @ - (1-32 chars)"/>
      </label>
      <div class="col" style="gap:4px">
        <span class="meta">Color</span>
        <div class="color-grid">
          ${LANE_COLORS.map(c => html`<button
            class=${"color-swatch" + (color.value === c ? " selected" : "") + (c === null ? " clear" : "")}
            style=${c ? `background: ${c}` : ""}
            title=${c || "no color"}
            onClick=${e => { e.preventDefault(); color.value = c; }}/>`)}
        </div>
      </div>
      <div class="row" style="justify-content:space-between">
        <button class="btn btn-danger"
          title=${taskCount > 0
            ? `${taskCount} task${taskCount === 1 ? " carries" : "s carry"} this tag (delete cascades)`
            : "delete tag"}
          onClick=${() => modal.value = { kind: "confirm-tag-delete", name: tg.name, taskCount }}>
          <${Icon} name="trash" size=${12}/>
          <span>Delete tag</span>
        </button>
        <div class="row">
          <button class="btn" onClick=${close}>Cancel</button>
          <button class="btn btn-primary" onClick=${save}>Save</button>
        </div>
      </div>
    </div>
  </div>`;
}

// ---------- root ----------
// Wraps the three panes + overlays in a transparent (display:contents) div so
// the panes are direct children of the <main> grid.
function App() {
  // CommandPalette is mounted ONLY when paletteOpen.value is true. The
  // ternary here is load-bearing: if we rendered it unconditionally and it
  // self-gated with `return null`, the component would never unmount and its
  // useEffect-based autofocus would only fire on the very first open. See
  // the comment above CommandPalette for the full failure mode.
  return html`<div class="contents">
    <${TopBar}/>
    ${sidebarView.value === "tags" ? html`<${TagsPane}/>` : html`<${LanesPane}/>`}
    <${ActiveTaskPane}/>
    <${InboxPane}/>
    ${paletteOpen.value ? html`<${CommandPalette}/>` : null}
    <${ModalRoot}/>
    ${errorMsg.value ? html`<div class="toast">${errorMsg.value}</div>` : null}
  </div>`;
}

export default App;

// CommandPalette — assumes it is conditionally rendered by the parent (so
// that each open is a true mount with fresh hook state). DO NOT add an
// `if (!paletteOpen.value) return null` early-return here — returning null
// from a component does NOT unmount it in Preact, the hook state persists,
// and useEffect(..., []) would fire only the very first time. That's the
// exact bug that broke autofocus on the second and subsequent opens.

import type { JSX, VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";

import { paletteOpen, paletteQuery, tasks, selectedId, tab } from "../../state/signals.ts";
import { showError } from "../../api/errors.ts";
import { Icon } from "../Icon.tsx";
import { PriorityChip } from "../chips/PriorityChip.tsx";
import { buildCommands, type Command } from "./buildCommands.ts";
import { DialogFrame } from "../modals/DialogFrame.tsx";
import { searchTasks } from "../../lib/fuzzy.ts";
import type { Task } from "../../api/types.ts";

interface Scope {
  title: string;
  cmds: Command[];
}

function renderHighlightedText(
  text: string,
  ranges: Array<{ start: number; end: number }> = [],
): Array<string | VNode> {
  if (ranges.length === 0) return [text];
  const chunks: Array<string | VNode> = [];
  let cursor = 0;
  ranges.forEach((range, i) => {
    if (range.start > cursor) chunks.push(text.slice(cursor, range.start));
    chunks.push(
      <mark class="search-hit" key={`${range.start}-${range.end}-${i}`}>
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) chunks.push(text.slice(cursor));
  return chunks;
}

export function CommandPalette(): VNode {
  const query = paletteQuery;
  const cursor = useSignal(0);
  // Scope stack: each entry is { title, cmds }. Empty stack = root scope
  // (rebuilt from buildCommands() every render so it tracks live signals).
  // Non-empty = inside one or more sub-menus. This is what lets us collapse
  // "50 lanes × 3 verbs = 150 root entries" down to 3 verbs that dive into
  // pickers on demand.
  const stack = useSignal<Scope[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus AND select the remembered query on open so typing replaces it. The
  // leading "/" is the command-mode sigil, not the user's text: it stays
  // outside the selection so replacing a command filter never silently drops
  // the palette into search mode (mod+k is the explicit way to get there).
  // Runs twice like the focus it extends: once now, once after DialogFrame's
  // showModal() has performed its own initial-focus pass on the next tick.
  useEffect(() => {
    const focusAndSelect = (): void => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.startsWith("/") ? 1 : 0, input.value.length);
    };
    focusAndSelect();
    const t = setTimeout(focusAndSelect, 0);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const el = document.querySelector(".palette-list .palette-row.active");
    if (el && typeof (el as HTMLElement).scrollIntoView === "function")
      (el as HTMLElement).scrollIntoView({ block: "nearest" });
  });

  const cmds = stack.value.length === 0 ? buildCommands() : stack.value[stack.value.length - 1].cmds;
  const isCommandMode = query.value.startsWith("/") || stack.value.length > 0;
  const searchQuery = isCommandMode ? query.value.slice(1) : query.value;

  // Word-split (fuzzy-ish) match: split the query on whitespace and require
  // EVERY token to appear (substring) in either the label or id, in any
  // order. Lets "filter tag" match "Filter by tags…" which strict substring
  // search would miss because "by" sits between the tokens. Predictable +
  // cheap; no scoring/ranking complexity.
  const tokens = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filteredCommands =
    tokens.length === 0
      ? cmds
      : cmds.filter(c => {
          const hay = `${c.label} ${c.id}`.toLowerCase();
          return tokens.every(t => hay.includes(t));
        });
  const searchResults = !isCommandMode ? searchTasks(tasks.value, searchQuery) : [];
  const activeList = isCommandMode ? filteredCommands : searchResults;
  const safeCursor = Math.min(cursor.value, Math.max(0, activeList.length - 1));
  const inSubmenu = stack.value.length > 0;

  const selectTask = (task: Task) => {
    // Global search stays global and selection PRESERVES workspace filters
    // (W4) — the outside-filter notice explains any mismatch. Reveal the
    // Document tab explicitly: the per-task default effect only fires on
    // task CHANGES, and re-selecting the current task should also land on
    // the document.
    selectedId.value = task.id;
    tab.value = "document";
    paletteOpen.value = false;
  };

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
  // built unless the user actually dives in. Callers (`exec`, click handlers)
  // only invoke pushScope on commands that have a submenu — guard explicitly
  // so the type system stops nagging about Command.submenu being optional.
  const pushScope = (cmd: Command) => {
    if (!cmd.submenu) return;
    stack.value = [...stack.value, { title: cmd.label.replace(/\u2026$/, ""), cmds: cmd.submenu() }];
    query.value = "";
    cursor.value = 0;
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const exec = async (cmd: Command) => {
    if (cmd.submenu) {
      pushScope(cmd);
      return;
    }
    paletteOpen.value = false;
    try {
      await cmd.action?.();
    } catch (e) {
      showError(e);
    }
  };

  // Same DialogFrame as every modal (V3): named, native-modal, Escape via
  // cancel and backdrop click both route to the owner's close; the root-
  // level Escape still ALSO reaches the global handler (keydown bubbles
  // before the dialog's close request fires) which clears the query.
  return (
    <DialogFrame
      label="Command palette"
      className="dialog-frame--top"
      onClose={() => {
        paletteOpen.value = false;
      }}
    >
      <div class="modal palette" data-pop>
        {inSubmenu ? (
          <div class="palette-breadcrumb">
            <button class="btn-icon" onClick={popScope} title="Back" aria-label="Back to previous menu">
              <Icon name="chevronDown" className="rotate-90-cw" />
            </button>
            <span class="meta">{stack.value.map(s => s.title).join(" / ")}</span>
          </div>
        ) : null}
        <input
          ref={inputRef}
          class="palette-input"
          placeholder={
            inSubmenu
              ? `Pick a ${stack.value[stack.value.length - 1].title.toLowerCase()}\u2026`
              : isCommandMode
                ? "Type a command\u2026"
                : "Search titles + bodies\u2026"
          }
          autoFocus
          value={query.value}
          onInput={(e: JSX.TargetedInputEvent<HTMLInputElement>) => {
            query.value = e.currentTarget.value;
            cursor.value = 0;
          }}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              cursor.value = Math.min(activeList.length - 1, safeCursor + 1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              cursor.value = Math.max(0, safeCursor - 1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (isCommandMode) {
                const c = filteredCommands[safeCursor];
                if (c) exec(c);
              } else {
                const r = searchResults[safeCursor];
                if (r) selectTask(r.task);
              }
            }
            // Submenu navigation. ArrowLeft / Backspace (when query empty) /
            // Escape all pop one level. At root, Escape falls through to the
            // global handler in index.tsx which closes the palette.
            else if (inSubmenu && e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              popScope();
            } else if (inSubmenu && e.key === "ArrowLeft" && query.value === "") {
              e.preventDefault();
              popScope();
            } else if (inSubmenu && e.key === "Backspace" && query.value === "") {
              e.preventDefault();
              popScope();
            }
          }}
        />
        <div class="palette-list">
          {activeList.length === 0 ? (
            <div class="meta" style="padding:12px">
              {isCommandMode ? "No matching commands" : "No matching tasks"}
            </div>
          ) : isCommandMode ? (
            filteredCommands.map((c, i) => (
              <button
                class={`palette-row${i === safeCursor ? " active" : ""}`}
                onMouseEnter={() => (cursor.value = i)}
                onClick={() => exec(c)}
              >
                <Icon name={c.icon} />
                <span class="grow">{c.label}</span>
                {c.hint ? <span class="meta num">{c.hint}</span> : null}
                {c.submenu ? <Icon name="chevronDown" className="rotate-90-ccw" /> : null}
              </button>
            ))
          ) : (
            searchResults.map((r, i) => (
              <button
                class={`palette-row${i === safeCursor ? " active" : ""}`}
                onMouseEnter={() => (cursor.value = i)}
                onClick={() => selectTask(r.task)}
              >
                <span class={`dot dot-status-${r.task.status}`}></span>
                <span class="palette-result-main grow">
                  <span class="task-search-title">
                    {r.highlight?.field === "title"
                      ? renderHighlightedText(r.task.title, r.highlight.ranges)
                      : r.task.title}
                  </span>
                  {r.highlight && r.highlight.field !== "title" ? (
                    <span class="task-search-preview">
                      {renderHighlightedText(r.highlight.text, r.highlight.ranges)}
                    </span>
                  ) : null}
                </span>
                <span class="meta">{r.task.lane}</span>
                <PriorityChip priority={r.task.priority} />
              </button>
            ))
          )}
        </div>
        <div class="palette-foot meta">
          <span>
            <span class="kbd">&uarr;</span>
            <span class="kbd">&darr;</span> navigate
          </span>
          <span>
            <span class="kbd">&crarr;</span> select
          </span>
          {!isCommandMode && !inSubmenu ? <span>@ title only · # tags</span> : null}
          <span>
            <span class="kbd">Esc</span> {inSubmenu ? "back" : "close"}
          </span>
        </div>
      </div>
    </DialogFrame>
  );
}

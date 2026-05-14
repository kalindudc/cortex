// CommandPalette — assumes it is conditionally rendered by the parent (so
// that each open is a true mount with fresh hook state). DO NOT add an
// `if (!paletteOpen.value) return null` early-return here — returning null
// from a component does NOT unmount it in Preact, the hook state persists,
// and useEffect(..., []) would fire only the very first time. That's the
// exact bug that broke autofocus on the second and subsequent opens.

import type { VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";

import { paletteOpen } from "../../state/signals.ts";
import { showError } from "../../api/errors.ts";
import { Icon } from "../Icon.tsx";
import { buildCommands, type Command } from "./buildCommands.ts";

interface Scope {
  title: string;
  cmds: Command[];
}

export function CommandPalette(): VNode {
  const query = useSignal("");
  const cursor = useSignal(0);
  // Scope stack: each entry is { title, cmds }. Empty stack = root scope
  // (rebuilt from buildCommands() every render so it tracks live signals).
  // Non-empty = inside one or more sub-menus. This is what lets us collapse
  // "50 lanes × 3 verbs = 150 root entries" down to 3 verbs that dive into
  // pickers on demand.
  const stack = useSignal<Scope[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const el = document.querySelector(".palette-list .palette-row.active");
    if (el && typeof (el as HTMLElement).scrollIntoView === "function")
      (el as HTMLElement).scrollIntoView({ block: "nearest" });
  });

  const cmds = stack.value.length === 0 ? buildCommands() : stack.value[stack.value.length - 1].cmds;
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
  const pushScope = (cmd: Command) => {
    stack.value = [...stack.value, { title: cmd.label.replace(/\u2026$/, ""), cmds: cmd.submenu!() }];
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

  return (
    <div
      class="overlay overlay-top"
      onClick={(e: MouseEvent) => {
        const t = e.target as HTMLElement;
        if (t.classList.contains("overlay") || t.classList.contains("overlay-top")) paletteOpen.value = false;
      }}
    >
      <div class="modal palette">
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
              : "Type a command\u2026"
          }
          autoFocus
          value={query.value}
          onInput={(e: any) => {
            query.value = e.currentTarget.value;
            cursor.value = 0;
          }}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              cursor.value = Math.min(filtered.length - 1, safeCursor + 1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              cursor.value = Math.max(0, safeCursor - 1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              const c = filtered[safeCursor];
              if (c) exec(c);
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
          {filtered.length === 0 ? (
            <div class="meta" style="padding:12px">
              No matching commands
            </div>
          ) : (
            filtered.map((c, i) => (
              <button
                class={"palette-row" + (i === safeCursor ? " active" : "")}
                onMouseEnter={() => (cursor.value = i)}
                onClick={() => exec(c)}
              >
                <Icon name={c.icon} />
                <span class="grow">{c.label}</span>
                {c.hint ? <span class="meta num">{c.hint}</span> : null}
                {c.submenu ? <Icon name="chevronDown" className="rotate-90-ccw" /> : null}
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
          <span>
            <span class="kbd">Esc</span> {inSubmenu ? "back" : "close"}
          </span>
        </div>
      </div>
    </div>
  );
}

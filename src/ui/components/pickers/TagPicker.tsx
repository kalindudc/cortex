// TagPicker — richer, pre-existing variant of Picker for attached tags +
// footer 'Create #<name>' row when the search has text, no exact match,
// and the name is a valid tag name.
//
// Behavior:
//   - Click a row → toggles the tag on the task (api.setTags with the new set)
//   - Type to filter; case-insensitive substring match. Cursor resets to row 0.
//   - Arrow Down/Up moves a keyboard cursor through (filtered + create row);
//     wraps at edges. Cursor highlight is a subtle bg + accent left-border —
//     visually distinct from the (unhighlighted) attached state.
//   - Enter triggers the cursor row's action (toggle or create).
//   - Outside click / Esc close via index.tsx's global popover handler.
//
// Layout: attached tags are sorted to the TOP of the list at MOUNT time and
// stay there for the lifetime of this picker open (snapshot in `attachedAtOpen`).
// Toggling a tag does NOT immediately reshuffle the list — next open
// recomputes. Mirrors GitHub's labels picker: stable visual order while open.
//
// Critical: container is .tag-picker (fresh flex/scroll layout). NEVER reuse
// .popover-row here — that's the rigid grid that clamped tag pills to 14px in
// the v3 bug.

import type { JSX, VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";

import type { Task } from "../../api/types.ts";
import { tags, type TagWithCount } from "../../state/signals.ts";
import { api } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { isValidTagName } from "../../lib/constants.ts";
import { TagPill } from "../chips/TagPill.tsx";
import { Icon } from "../Icon.tsx";

// Internal pseudo-row for the optional "create" affordance.
type CreateRow = { __create: true; name: string };
type Row = TagWithCount | CreateRow;
const isCreateRow = (r: Row): r is CreateRow => (r as CreateRow).__create === true;

export function TagPicker({ task }: { task: Task }): VNode {
  const search = useSignal("");
  const cursor = useSignal(0);
  // Ref to the scrollable list container so the cursor effect (below) can
  // scoped-querySelector the highlighted row without leaking out of THIS
  // picker instance (defensive against multiple pickers, even though only
  // one mounts at a time today).
  const listRef = useRef<HTMLDivElement>(null);
  // Ref + explicit focus on the search input. `autoFocus` alone is NOT
  // reliable in this Preact + htm setup when the picker is mounted as a
  // direct result of a click — the browser focuses the clicked chip button
  // AFTER the picker mounts, stomping on the autoFocus. The setTimeout
  // belt-and-suspenders is the same pattern used by CommandPalette
  // (search there for `inputRef.current?.focus()`); it survives that race.
  // Without this, ArrowDown / Enter inside the search input never fire on
  // first open because the input never had focus to begin with.
  const searchRef = useRef<HTMLInputElement>(null);
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
  const attachedAtOpen = useSignal<Set<string>>(new Set(task.tags || []));

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
  const filtered = q ? sorted.filter(t => t.name.toLowerCase().includes(q)) : sorted;
  const attached = new Set(task.tags || []);
  const trimmedRaw = search.value.trim();
  const exactMatch = allByName.some(t => t.name === trimmedRaw);
  const canCreate = trimmedRaw.length > 0 && !exactMatch && isValidTagName(trimmedRaw);

  // The list rendered to the user, indexable by cursor. The optional create
  // row is appended; cursor.value addresses both list rows and the create row
  // uniformly.
  const items: Row[] = canCreate ? [...filtered, { __create: true, name: trimmedRaw }] : filtered;
  // Clamp cursor in case items shrank (e.g. user typed a more-specific filter).
  if (cursor.value > items.length - 1) cursor.value = Math.max(0, items.length - 1);

  const apply = async (nextSet: Set<string>) => {
    await tryApi(() => api.setTags(task.id, Array.from(nextSet)));
    // Don't close the picker — multi-edit UX. Outside-click handles dismiss.
  };

  const toggle = (name: string) => {
    const next = new Set(attached);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return apply(next);
  };

  const create = async (name?: string) => {
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
    if (isCreateRow(item)) create(item.name);
    else toggle(item.name);
  };

  const onSearchKey = (e: KeyboardEvent) => {
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

  const onSearchInput = (e: JSX.TargetedInputEvent<HTMLInputElement>) => {
    search.value = e.currentTarget.value;
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

  return (
    <div class="popover tag-picker" data-pop style="top: 32px; left: 0">
      <div class="tag-picker-search">
        <input
          ref={searchRef}
          autoFocus
          placeholder="Search or create tag…"
          value={search.value}
          onInput={onSearchInput}
          onKeyDown={onSearchKey}
        />
      </div>
      <div class="tag-picker-list" ref={listRef}>
        {items.length === 0 ? (
          <p class="tag-picker-empty meta">no tags match&mdash;type a new name to create one</p>
        ) : (
          items.map((it, i) => {
            const isCursor = i === cursor.value;
            if (isCreateRow(it)) {
              return (
                <button
                  class={`tag-picker-row tag-picker-create-row${isCursor ? " cursor" : ""}`}
                  onClick={() => create(it.name)}
                  title={`Create the tag '${it.name}' and attach it to this task`}
                >
                  <span class="tag-picker-check">
                    <Icon name="plus" size={12} />
                  </span>
                  <span class="tag-picker-create-label">Create</span>
                  <TagPill name={it.name} color={null} />
                </button>
              );
            }
            const sel = attached.has(it.name);
            return (
              <button
                class={`tag-picker-row${sel ? " selected" : ""}${isCursor ? " cursor" : ""}`}
                onClick={() => toggle(it.name)}
                onMouseMove={() => {
                  if (cursor.value !== i) cursor.value = i;
                }}
                title={sel ? "Click to remove" : "Click to add"}
              >
                <span class="tag-picker-check">{sel ? <Icon name="check" size={12} /> : null}</span>
                <TagPill name={it.name} color={it.color} />
                <span class="grow"></span>
                <span class="tag-picker-count meta">{it.task_count}</span>
              </button>
            );
          })
        )}
      </div>
      {trimmedRaw && !canCreate && !exactMatch ? (
        <div class="tag-picker-foot">
          <p class="meta" style="margin:0; padding:6px 10px">
            {"invalid tag name (must match [a-z0-9_@-]{1,32})"}
          </p>
        </div>
      ) : null}
    </div>
  );
}

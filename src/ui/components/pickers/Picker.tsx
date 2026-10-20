// Picker — generic search-and-select dropdown primitive.
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
//   filterText   : (item: T) => string                          — literal AND-keyword match over the full catalog
//   onSelect     : (item: T) => void                            — fired on row click + Enter on cursor
//   renderRow    : ({item, isSelected, isCursor, onClick, onMouseMove}) => vnode
//   isSelected?  : (item: T) => boolean   (default: () => false)
//   placeholder? : string                  (default: "Search…")
//   emptyText?   : string                  (default: "no results")
//   className?   : string                  — appended to root .popover.picker classes
//   createRow?   : ({query, isCursor, onClick}) => vnode | null   — return non-null to show a create row at the END of the list
//   onCreate?    : (query: string) => void                       — fired when create row is triggered (click or Enter on cursor)
//   footer?      : vnode                                         — rendered below the list

import type { JSX, VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { searchCatalog, catalogSearchHint } from "../../../lib/catalogSearch.ts";

export interface PickerRenderRowArgs<T> {
  item: T;
  isSelected: boolean;
  isCursor: boolean;
  onClick: () => void;
  onMouseMove: () => void;
}

export interface PickerCreateRowArgs {
  query: string;
  isCursor: boolean;
  onClick: () => void;
}

export interface PickerProps<T> {
  items: T[];
  filterText: (item: T) => string;
  onSelect: (item: T) => void;
  renderRow: (args: PickerRenderRowArgs<T>) => VNode;
  isSelected?: (item: T) => boolean;
  placeholder?: string;
  emptyText?: string;
  className?: string;
  createRow?: (args: PickerCreateRowArgs) => VNode | null;
  onCreate?: (query: string) => void;
  footer?: VNode | null;
}

export function Picker<T>({
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
}: PickerProps<T>): VNode {
  const query = useSignal("");
  const cursor = useSignal(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Defensive focus — same setTimeout(0) pattern TagPicker uses. Without
  // it, the click that mounted the picker re-focuses the trigger button
  // after the picker's autoFocus runs, leaving keyboard nav broken on
  // first open.
  useEffect(() => {
    searchRef.current?.focus();
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  const results = searchCatalog(items, query.value, filterText);
  const filtered = results.items;

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

  const onSearchKey = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if ((e.key === "Home" || e.key === "End") && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      cursor.value = e.key === "Home" ? 0 : Math.max(0, totalRows - 1);
    } else if (e.key === "ArrowDown") {
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

  const onSearchInput = (e: JSX.TargetedInputEvent<HTMLInputElement>) => {
    query.value = e.currentTarget.value;
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

  return (
    <div class={`popover picker ${className}`} data-pop style="top: 32px; left: 0">
      <div class="picker-search">
        <input
          ref={searchRef}
          autoFocus
          type="search"
          aria-label={placeholder.replace(/…$/, "")}
          placeholder={placeholder}
          value={query.value}
          onInput={onSearchInput}
          onKeyDown={onSearchKey}
        />
      </div>
      <p class="catalog-search-hint" role="status">
        {catalogSearchHint(results)}
      </p>
      <div class="picker-list" ref={listRef}>
        {totalRows === 0 ? (
          <p class="picker-empty meta">{emptyText}</p>
        ) : (
          filtered.map((it, i) =>
            renderRow({
              item: it,
              isSelected: isSelected(it),
              isCursor: i === cursor.value,
              onClick: () => onSelect(it),
              onMouseMove: () => {
                if (cursor.value !== i) cursor.value = i;
              },
            }),
          )
        )}
        {createNode}
      </div>
      {footer ?? null}
    </div>
  );
}

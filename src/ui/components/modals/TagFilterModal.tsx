// TagFilterModal — multi-select tag filter for the sidebar's filters.tag
// array. Modal pattern (matches LaneEditModal/TagEditModal/NewLaneModal)
// instead of a popover so the surface feels native to the rest of the app.
//
// Live commit: each toggle mutates filters.tag immediately (matches the
// active-task TagPicker contract). The modal stays open for batch picking;
// "Done" is just a close affordance, Esc/overlay-click also close.
//
// Layout (top → bottom):
//   header       — title + close
//   search       — case-insensitive substring filter on tag name
//   summary      — strip of removable mini-chips for currently-selected tags
//                  (only renders when the array is non-empty)
//   list         — Untagged sentinel row first, then alphabetical tags
//   footer       — "Clear all" link + "N selected" + "Done"

import type { JSX, VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";

import { tags, tasks, filters, setFilter, toggleTagFilter } from "../../state/signals.ts";
import { UNTAGGED } from "../../state/computed.ts";
import { Icon } from "../Icon.tsx";
import { TagPill } from "../chips/TagPill.tsx";

// Sentinel row in the list. The Untagged pseudo-tag toggles UNTAGGED into
// filters.tag; appears first so it's always one ArrowDown away from search.
type Row = { __sentinel: true } | { name: string; color: string | null; task_count: number };
const isSentinel = (r: Row): r is { __sentinel: true } => "__sentinel" in r;

export function TagFilterModal({ close }: { close: () => void }): VNode {
  const search = useSignal("");
  const cursor = useSignal(0);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Belt-and-suspenders autoFocus — same race TagPicker documents (the
  // trigger button can steal focus back the same tick the modal mounts).
  useEffect(() => {
    searchRef.current?.focus();
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  const selected = new Set(filters.value.tag);
  const allByName = [...tags.value].sort((a, b) => a.name.localeCompare(b.name));
  const q = search.value.trim().toLowerCase();
  const filtered = q ? allByName.filter(t => t.name.toLowerCase().includes(q)) : allByName;

  const untaggedMatchesSearch = !q || "untagged".includes(q);
  const items: Row[] = [];
  if (untaggedMatchesSearch) items.push({ __sentinel: true });
  for (const t of filtered) items.push(t);
  if (cursor.value > items.length - 1) cursor.value = Math.max(0, items.length - 1);

  const triggerCursor = () => {
    const item = items[cursor.value];
    if (!item) return;
    if (isSentinel(item)) toggleTagFilter(UNTAGGED);
    else toggleTagFilter(item.name);
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
    cursor.value = 0;
  };

  // Auto-scroll cursor row into view (block: 'nearest' avoids jarring jumps).
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const el = root.querySelector(".tag-filter-row.cursor");
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor.value, items.length]);

  const selectedCount = filters.value.tag.length;

  return (
    <div
      class="overlay"
      onClick={(e: MouseEvent) => {
        if ((e.target as HTMLElement).classList.contains("overlay")) close();
      }}
    >
      <div class="modal tag-filter-modal" style="max-width: 360px">
        <div class="row">
          <h2 class="grow">Filter by tags</h2>
          <button class="btn-icon" onClick={close} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>

        <div class="tag-filter-search">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            autoFocus
            placeholder={"Search tags\u2026"}
            value={search.value}
            onInput={onSearchInput}
            onKeyDown={onSearchKey}
          />
        </div>

        {selectedCount > 0 ? (
          <fieldset class="tag-filter-summary">
            <legend class="sr-only">Currently selected tags</legend>
            {filters.value.tag.map(name => (
              <span key={name} class="tag-filter-summary-chip">
                <span>{name === UNTAGGED ? "untagged" : `#${name}`}</span>
                <button
                  type="button"
                  class="x"
                  aria-label={name === UNTAGGED ? "Stop including untagged tasks" : `Remove tag filter: #${name}`}
                  onClick={() => toggleTagFilter(name)}
                >
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </fieldset>
        ) : null}

        <div class="tag-filter-list" ref={listRef}>
          {items.length === 0 ? (
            <p class="tag-filter-empty meta">no tags match</p>
          ) : (
            items.map((it, i) => {
              const isCursor = i === cursor.value;
              if (isSentinel(it)) {
                const sel = selected.has(UNTAGGED);
                // Inline count keeps row density matched to real tag rows.
                const untaggedCount = tasks.value.filter(t => !Array.isArray(t.tags) || t.tags.length === 0).length;
                return (
                  <button
                    type="button"
                    class={`tag-filter-row tag-filter-untagged-row${sel ? " selected" : ""}${isCursor ? " cursor" : ""}`}
                    onClick={() => toggleTagFilter(UNTAGGED)}
                    onMouseMove={() => {
                      if (cursor.value !== i) cursor.value = i;
                    }}
                    title={sel ? "Click to remove" : "Click to include untagged tasks"}
                  >
                    <span class="tag-filter-check">{sel ? <Icon name="check" size={12} /> : null}</span>
                    <span class="tag-filter-untagged-label">untagged</span>
                    <span class="grow"></span>
                    <span class="tag-filter-count num">{untaggedCount}</span>
                  </button>
                );
              }
              const sel = selected.has(it.name);
              return (
                <button
                  type="button"
                  class={`tag-filter-row${sel ? " selected" : ""}${isCursor ? " cursor" : ""}`}
                  onClick={() => toggleTagFilter(it.name)}
                  onMouseMove={() => {
                    if (cursor.value !== i) cursor.value = i;
                  }}
                  title={sel ? "Click to remove" : "Click to add"}
                >
                  <span class="tag-filter-check">{sel ? <Icon name="check" size={12} /> : null}</span>
                  <TagPill name={it.name} color={it.color} />
                  <span class="grow"></span>
                  <span class="tag-filter-count num">{it.task_count}</span>
                </button>
              );
            })
          )}
        </div>

        <div class="tag-filter-foot">
          <button
            type="button"
            class="btn btn-link"
            onClick={() => setFilter("tag", [])}
            disabled={selectedCount === 0}
            title={selectedCount === 0 ? "No tag filters to clear" : "Clear all tag filters"}
          >
            Clear all
          </button>
          <span class="grow"></span>
          <span class="meta tag-filter-count-hint">{selectedCount} selected</span>
          <button type="button" class="btn btn-primary" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

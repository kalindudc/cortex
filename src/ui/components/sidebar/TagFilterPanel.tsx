// Live tag filtering inside the sidebar's attached panel. Search state is
// local to each open; toggles never remount the panel or mutate selection.
import type { JSX, VNode } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { tags, tasks, filters, setFilter, toggleTagFilter } from "../../state/signals.ts";
import { UNTAGGED } from "../../state/computed.ts";
import { searchCatalog, catalogSearchHint } from "../../lib/catalogSearch.ts";
import { Icon } from "../Icon.tsx";
import { TagPill } from "../chips/TagPill.tsx";

export function TagFilterPanel({ close }: { close: () => void }): VNode {
  const search = useSignal("");
  const listRef = useRef<HTMLFieldSetElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
  }, []);

  const selected = new Set(filters.value.tag);
  const results = searchCatalog(
    [
      {
        name: UNTAGGED,
        color: null,
        task_count: tasks.value.filter(task => !Array.isArray(task.tags) || task.tags.length === 0).length,
      },
      ...[...tags.value].sort((a, b) => a.name.localeCompare(b.name)),
    ],
    search.value,
    tag => (tag.name === UNTAGGED ? "untagged" : tag.name),
  );
  const items = results.items;
  const selectedCount = selected.size;
  const focusRow = (index: number): void => {
    const row = listRef.current?.querySelectorAll<HTMLButtonElement>(".tag-filter-row")[index];
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div class="tag-filter-content">
      <div class="tag-filter-scroll">
        <div class="tag-filter-search catalog-search-field">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search tags"
            aria-describedby="sidebar-tag-search-hint"
            autoFocus
            placeholder="Search tags…"
            value={search.value}
            onInput={(event: JSX.TargetedInputEvent<HTMLInputElement>) => {
              search.value = event.currentTarget.value;
            }}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                focusRow(event.key === "ArrowDown" ? 0 : items.length - 1);
              } else if (event.key === "Enter" && items[0]) {
                event.preventDefault();
                toggleTagFilter(items[0].name);
              }
            }}
          />
        </div>
        <p class="catalog-search-hint" id="sidebar-tag-search-hint" role="status">
          {catalogSearchHint(results)}
        </p>
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
                  onClick={() => {
                    toggleTagFilter(name);
                    searchRef.current?.focus({ preventScroll: true });
                  }}
                >
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </fieldset>
        ) : null}
        <fieldset
          class="tag-filter-list"
          ref={listRef}
          aria-label="Available tags"
          onKeyDown={(event: KeyboardEvent) => {
            if (event.isComposing) return;
            const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(".tag-filter-row") ?? []);
            const current = rows.indexOf(event.target as HTMLButtonElement);
            if (current < 0) return;
            let next: number;
            if (event.key === "ArrowDown") next = (current + 1) % items.length;
            else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = items.length - 1;
            else return;
            event.preventDefault();
            focusRow(next);
          }}
        >
          {items.length === 0 ? (
            <p class="tag-filter-empty meta">no tags match</p>
          ) : (
            items.map(item => {
              const untagged = item.name === UNTAGGED;
              const isSelected = selected.has(item.name);
              return (
                <button
                  key={item.name}
                  type="button"
                  class={`tag-filter-row${untagged ? " tag-filter-untagged-row" : ""}${isSelected ? " selected" : ""}`}
                  aria-label={untagged ? "Include untagged tasks" : `Include #${item.name}`}
                  aria-pressed={isSelected}
                  aria-describedby={`sidebar-filter-tag-count-${encodeURIComponent(item.name)}`}
                  onClick={() => toggleTagFilter(item.name)}
                  title={isSelected ? "Click to remove" : "Click to include"}
                >
                  <span class="tag-filter-check">{isSelected ? <Icon name="check" size={12} /> : null}</span>
                  {untagged ? (
                    <span class="tag-filter-untagged-label">untagged</span>
                  ) : (
                    <TagPill name={item.name} color={item.color} />
                  )}
                  <span class="grow"></span>
                  <span class="tag-filter-count num" aria-hidden="true">
                    {item.task_count}
                  </span>
                  <span class="sr-only" id={`sidebar-filter-tag-count-${encodeURIComponent(item.name)}`}>
                    {item.task_count} tasks
                  </span>
                </button>
              );
            })
          )}
        </fieldset>
      </div>
      <div class="tag-filter-foot">
        <button
          type="button"
          class="btn btn-link"
          onClick={() => {
            setFilter("tag", []);
            searchRef.current?.focus({ preventScroll: true });
          }}
          disabled={selectedCount === 0}
          title={selectedCount === 0 ? "No tag filters to clear" : "Clear all tag filters"}
        >
          Clear all
        </button>
        <span class="meta tag-filter-count-hint" aria-live="polite">
          {selectedCount} selected
        </span>
        <button type="button" class="btn btn-primary" onClick={close}>
          Done
        </button>
      </div>
    </div>
  );
}

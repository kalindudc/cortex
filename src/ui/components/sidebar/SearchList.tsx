// SearchList — the list column of the Search view: one search over every
// task (every lane, done tasks included, ignoring the task list's filters)
// with the palette's engine (lib/fuzzy.ts#searchTasks, no result cap). A
// result opens in the document beside the list, and the results stay.
// searchQuery is its own signal, so searching never touches workspaceQuery.

import type { JSX, VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";

import { searchQuery, selectedId, tasks } from "../../state/signals.ts";
import { activeTask } from "../../state/computed.ts";
import { clearWorkspaceTransientState } from "../../state/workspace.ts";
import { tip } from "../../state/tooltip.ts";
import { renderHighlightedText } from "../../lib/highlight.tsx";
import { searchTasks } from "../../../lib/fuzzy.ts";
import { STATUS_LABEL } from "../../../lib/constants.ts";
import { plural } from "../../../lib/format.ts";
import { Icon } from "../Icon.tsx";

function open(id: number): void {
  selectedId.value = id;
  // An explicit pick closes the narrow drawer even for the task already open.
  clearWorkspaceTransientState();
}

export function SearchList(): VNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const cursor = useSignal(0);
  useEffect(() => {
    inputRef.current?.focus();
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const row = document.querySelector(".search-results .search-row.cursor") as HTMLElement | null;
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  });

  const query = searchQuery.value;
  const results = searchTasks(tasks.value, query);
  const at = Math.min(cursor.value, Math.max(0, results.length - 1));
  const openId = activeTask.value?.id ?? null;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cursor.value = Math.min(results.length - 1, at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cursor.value = Math.max(0, at - 1);
    } else if (e.key === "Enter") {
      const r = results[at];
      if (!r) return;
      e.preventDefault();
      open(r.task.id);
    }
  };

  return (
    <div class="sidebar-body search-list">
      <div class="list-top">
        <div class="ws-search search-field">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            type="search"
            aria-label="Search all tasks"
            placeholder="Search every task"
            value={query}
            onInput={(e: JSX.TargetedInputEvent<HTMLInputElement>) => {
              searchQuery.value = e.currentTarget.value;
              cursor.value = 0;
            }}
            onKeyDown={onKeyDown}
            {...tip("@12 opens a task, @word searches titles, #tag matches a tag")}
          />
        </div>
      </div>
      {query.trim() === "" ? (
        <p class="meta search-meta">
          Search titles, bodies and tags across every lane, done tasks included. <code>@12</code> opens task 12,{" "}
          <code>@word</code> searches titles only, and <code>#tag</code> lists the tasks with that tag.
        </p>
      ) : (
        <>
          <p class="meta search-meta">{plural(results.length, "result")} · every lane, done included</p>
          <div class="search-results">
            {results.length === 0 ? <p class="meta search-empty">No task matches</p> : null}
            {results.map((r, i) => {
              const h = r.highlight;
              return (
                <button
                  type="button"
                  key={r.task.id}
                  class={`search-row${i === at ? " cursor" : ""}`}
                  aria-current={r.task.id === openId ? "page" : undefined}
                  onMouseEnter={() => (cursor.value = i)}
                  onClick={() => open(r.task.id)}
                >
                  <span class="search-row-top">
                    <span
                      class={`dot dot-status-${r.task.status}`}
                      role="img"
                      aria-label={STATUS_LABEL[r.task.status]}
                    ></span>
                    <span class="search-row-title">
                      {h?.field === "title" ? renderHighlightedText(r.task.title, h.ranges) : r.task.title}
                    </span>
                    <span class="search-row-id num">@{r.task.id}</span>
                  </span>
                  {h && h.field !== "title" ? (
                    <span class="search-row-excerpt">{renderHighlightedText(h.text, h.ranges)}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

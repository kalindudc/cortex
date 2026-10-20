// One filtering surface over the existing workspace signals. Search is
// composed with status/lane/tag state in computed.ts; presentation never
// owns a second query or silently changes an explicit task selection.
import type { VNode } from "preact";
import {
  filters,
  lanes,
  clearAllFilters,
  hasActiveFilters,
  sidebarFilter,
  type SidebarFilter,
  showAllTasks,
  workspaceQuery,
} from "../../state/signals.ts";
import { STATUS_LABEL } from "../../../lib/constants.ts";
import { toggleSidebarFilter } from "../../state/popovers.ts";
import { tip } from "../../state/tooltip.ts";
import { Icon } from "../Icon.tsx";
import { FilterChips } from "./FilterChips.tsx";

function triggerProps(kind: SidebarFilter) {
  return {
    id: `sidebar-filter-${kind}-trigger`,
    "aria-controls": `sidebar-filter-${kind}-panel`,
    "aria-expanded": sidebarFilter.value === kind,
    "data-pop": true,
    onClick: () => toggleSidebarFilter(kind),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      if (sidebarFilter.peek() !== kind) toggleSidebarFilter(kind);
    },
  };
}

export function WorkspaceFilters(): VNode {
  const f = filters.value;
  const active = hasActiveFilters();
  // Keep stale stored lanes visible and clearable, rather than displaying
  // 'All lanes' while an invisible constraint still filters the task list.
  const missingLane = f.lane != null && !lanes.value.some(l => l.name === f.lane) ? f.lane : null;
  return (
    <div class="workspace-filters">
      <label class="ws-search-label" for="workspace-search">
        Find a task
      </label>
      <div class="ws-search">
        <Icon name="search" size={14} />
        <input
          id="workspace-search"
          type="search"
          aria-label="Search tasks"
          placeholder="Search tasks…"
          value={workspaceQuery.value}
          onInput={(event: Event) => {
            workspaceQuery.value = (event.currentTarget as HTMLInputElement).value;
          }}
          {...tip("Search titles, bodies and tags — @id jumps, #tag matches exactly")}
        />
      </div>
      <div class="ws-controls">
        <div class="ws-select">
          <span>Status</span>
          <button
            type="button"
            class={`ws-filter-trigger${f.status != null ? " active" : ""}`}
            aria-label="Status filter"
            aria-haspopup="listbox"
            aria-describedby="sidebar-filter-status-value"
            {...triggerProps("status")}
          >
            <span id="sidebar-filter-status-value">{f.status == null ? "All statuses" : STATUS_LABEL[f.status]}</span>
            <Icon name="chevronDown" size={12} />
          </button>
        </div>
        <div class="ws-select">
          <span>Lane</span>
          <button
            type="button"
            class={`ws-filter-trigger${f.lane != null ? " active" : ""}`}
            aria-label="Lane filter"
            aria-haspopup="listbox"
            aria-describedby="sidebar-filter-lane-value"
            {...triggerProps("lane")}
          >
            <span id="sidebar-filter-lane-value">
              {f.lane == null ? "All lanes" : `${f.lane}${missingLane ? " (missing)" : ""}`}
            </span>
            <Icon name="chevronDown" size={12} />
          </button>
        </div>
      </div>
      <div class="ws-filter-actions">
        <button
          type="button"
          class={`ws-tags-button${f.tag.length > 0 ? " active" : ""}`}
          aria-label="Filter by tags"
          {...triggerProps("tags")}
          {...tip("Filter by tags")}
        >
          <Icon name="hash" size={13} />
          <span>Tags</span>
          {f.tag.length > 0 ? <span class="ws-filter-count num">{f.tag.length}</span> : null}
        </button>
        <button
          type="button"
          class={`ws-done-button${showAllTasks.value ? " active" : ""}`}
          aria-label={showAllTasks.value ? "Hide done tasks" : "Show done tasks too"}
          aria-pressed={showAllTasks.value}
          onClick={() => {
            showAllTasks.value = !showAllTasks.value;
          }}
          {...tip(showAllTasks.value ? "Hide done tasks from the list" : "Include done tasks in the list")}
        >
          <Icon name={showAllTasks.value ? "eye" : "eyeOff"} size={13} />
          <span>Include done</span>
        </button>
      </div>
      <FilterChips />
      <div class="ws-filter-foot">
        <span class="ws-search-hint">@id · @title · #tag</span>
        <button
          type="button"
          class="ws-clear"
          aria-label="Clear all filters"
          disabled={!active}
          onClick={() => clearAllFilters()}
          {...tip(active ? "Clear search, status, lane and tag filters" : "No filters active")}
        >
          Clear all
        </button>
      </div>
    </div>
  );
}

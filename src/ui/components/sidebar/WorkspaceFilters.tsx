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
  // an unset 'Lane' while an invisible constraint still filters the task list.
  const missingLane = f.lane != null && !lanes.value.some(l => l.name === f.lane) ? f.lane : null;
  return (
    <div class="workspace-filters">
      <div class="ws-search">
        <Icon name="search" size={14} />
        <input
          id="workspace-search"
          type="search"
          aria-label="Search tasks"
          placeholder="Filter tasks"
          value={workspaceQuery.value}
          onInput={(event: Event) => {
            workspaceQuery.value = (event.currentTarget as HTMLInputElement).value;
          }}
          {...tip("Search titles, bodies and tags — @id jumps, #tag matches exactly")}
        />
      </div>
      <div class="ws-chips">
        <button
          type="button"
          class={`ws-chip ws-filter-trigger${f.status != null ? " active" : ""}`}
          aria-label="Status filter"
          aria-haspopup="listbox"
          aria-describedby="sidebar-filter-status-value"
          {...triggerProps("status")}
        >
          <span id="sidebar-filter-status-value">{f.status == null ? "Status" : STATUS_LABEL[f.status]}</span>
          <Icon name="chevronDown" size={12} />
        </button>
        <button
          type="button"
          class={`ws-chip ws-filter-trigger${f.lane != null ? " active" : ""}`}
          aria-label="Lane filter"
          aria-haspopup="listbox"
          aria-describedby="sidebar-filter-lane-value"
          {...triggerProps("lane")}
        >
          <span id="sidebar-filter-lane-value">
            {f.lane == null ? "Lane" : `${f.lane}${missingLane ? " (missing)" : ""}`}
          </span>
          <Icon name="chevronDown" size={12} />
        </button>
        <button
          type="button"
          class={`ws-chip ws-tags-button${f.tag.length > 0 ? " active" : ""}`}
          aria-label="Filter by tags"
          {...triggerProps("tags")}
          {...tip("Filter by tags")}
        >
          <Icon name="hash" size={12} />
          <span>Tags</span>
          {f.tag.length > 0 ? <span class="ws-filter-count num">{f.tag.length}</span> : null}
        </button>
        <button
          type="button"
          class={`ws-chip ws-done-button${showAllTasks.value ? " active" : ""}`}
          aria-label={showAllTasks.value ? "Hide done tasks" : "Show done tasks too"}
          aria-pressed={showAllTasks.value}
          onClick={() => {
            showAllTasks.value = !showAllTasks.value;
          }}
          {...tip(showAllTasks.value ? "Hide done tasks from the list" : "Include done tasks in the list")}
        >
          <Icon name={showAllTasks.value ? "eye" : "eyeOff"} size={12} />
          <span>Done</span>
        </button>
        <button
          type="button"
          class="ws-chip ws-clear"
          aria-label="Clear all filters"
          disabled={!active}
          onClick={() => clearAllFilters()}
          {...tip(active ? "Clear search, status, lane and tag filters" : "No filters active")}
        >
          Clear
        </button>
      </div>
      <FilterChips />
    </div>
  );
}

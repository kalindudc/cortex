// SidebarSystemBar — top app-chrome strip on the unified SidebarPane.
//
// Consolidates ALL button-based controls + filter toggles in one strip so
// the section bodies stay focused on their data. Layout (left → right):
//
//   Theme toggle
//   Tag-management toggle (hash → swap to TAGS-only view; home ← back)
//   Show-done toggle (eye / eyeOff) — main-mode only
//   (grow spacer)
//   Reset filters (rotateCcw) — main-mode only; disabled when none active
//
// Mode-specific affordances render only in their relevant mode so the bar
// never advertises a control that does nothing for the current view.

import type { VNode } from "preact";
import { clearAllFilters, hasActiveFilters, showAllTasks, sidebarMode } from "../../state/signals.ts";
import { tip } from "../../state/tooltip.ts";
import { Icon } from "../Icon.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

export function SidebarSystemBar(): VNode {
  const inTags = sidebarMode.value === "tags";
  const active = hasActiveFilters();
  return (
    <div class="pane-system">
      <ThemeToggle />
      <button
        class={`btn-icon${inTags ? " btn-icon-active" : ""}`}
        aria-label={inTags ? "Back to main sidebar" : "Manage tags"}
        onClick={() => (sidebarMode.value = inTags ? "main" : "tags")}
        {...tip(inTags ? "Back to the main sidebar (views, lanes, tasks)" : "Switch to tag management")}
      >
        <Icon name={inTags ? "home" : "hash"} />
      </button>
      {inTags ? null : (
        <button
          class={`btn-icon${showAllTasks.value ? " btn-icon-active" : ""}`}
          aria-label={showAllTasks.value ? "Hide done tasks" : "Show done tasks too"}
          onClick={() => (showAllTasks.value = !showAllTasks.value)}
          {...tip(showAllTasks.value ? "Hide done tasks from the list" : "Include done tasks in the list")}
        >
          <Icon name={showAllTasks.value ? "eye" : "eyeOff"} />
        </button>
      )}
      <span class="grow"></span>
      {inTags ? null : (
        <button
          class="btn-icon"
          aria-label="Reset filters"
          disabled={!active}
          onClick={() => clearAllFilters()}
          {...tip(active ? "Clear every active filter (status, lane, tags)" : "No filters active")}
        >
          <Icon name="rotateCcw" />
        </button>
      )}
    </div>
  );
}

// SidebarPane — the unified left sidebar.
//
// Two modes (sidebarMode signal):
//   "main" — the primary work surface:
//     .pane-system    (theme + manage-tags toggle + reset filters)
//     .sidebar-body   (flex column)
//       section-views   — 5 built-in smart views (sized to content)
//       section-lanes   — lane rows; body scrolls; "+" opens NewLaneModal
//       <FilterChips/>  — only renders when at least one filter slot is set
//       section-tasks   — collapsible; "+" creates `untitled-<id>` and
//                         selects it for inline rename. Also hosts the
//                         show-all-tasks eye toggle.
//
//   "tags" — single-section pane for tag CRUD:
//     section-tags    — alphabetical tag list with edit affordance per
//                       row; "+" opens NewTagModal. The whole pane
//                       collapses to this one section so users have
//                       maximum vertical real estate to manage tags.
//
// New-task input + Commands button were removed from the pane foot. Their
// roles moved to the Tasks section "+" affordance and the StatusBar's
// clickable palette hint, respectively.
//
// Selection wiring is immutable via setFilter:
//   view-row click → setFilter("status", X) (or full clear for "All tasks")
//   lane-row click → setFilter("lane",   sel ? null : l.name)
//   tag-filter     → toggleTagFilter(name) inside TagFilterModal
// DnD (drag a task onto a lane row) is preserved from the old LanesPane.

import type { VNode } from "preact";

import {
  tasks,
  lanes,
  tags,
  filters,
  setFilter,
  clearAllFilters,
  sectionOpen,
  sidebarMode,
  selectedId,
  modal,
  showAllTasks,
} from "../../state/signals.ts";
import { createUntitledTask } from "../../lib/createTask.ts";
import { filteredTasks, activeTask } from "../../state/computed.ts";
import { tip } from "../../state/tooltip.ts";
import { api } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import type { TaskStatus } from "../../api/types.ts";
import { SidebarSystemBar } from "./SidebarSystemBar.tsx";
import { SectionHeader } from "./SectionHeader.tsx";
import { FilterChips } from "./FilterChips.tsx";
import { Icon } from "../Icon.tsx";
import { TagPill } from "../chips/TagPill.tsx";
import { PriorityChip } from "../chips/PriorityChip.tsx";

interface SmartView {
  id: string;
  label: string;
  icon: string;
  status: TaskStatus | null; // null = clear all filters ("All tasks")
  count: (allTasks: { status: TaskStatus }[]) => number;
}

const SMART_VIEWS: SmartView[] = [
  {
    id: "all",
    label: "All tasks",
    icon: "inbox",
    status: null,
    count: ts => ts.filter(t => t.status !== "done").length,
  },
  {
    id: "draft",
    label: "Draft",
    icon: "fileText",
    status: "draft",
    count: ts => ts.filter(t => t.status === "draft").length,
  },
  {
    id: "review",
    label: "In review",
    icon: "eye",
    status: "review",
    count: ts => ts.filter(t => t.status === "review").length,
  },
  {
    id: "blocked",
    label: "Blocked",
    icon: "ban",
    status: "blocked",
    count: ts => ts.filter(t => t.status === "blocked").length,
  },
  {
    id: "done",
    label: "Done",
    icon: "checkCircle",
    status: "done",
    count: ts => ts.filter(t => t.status === "done").length,
  },
];

function toggleSection(key: "views" | "lanes" | "tasks"): void {
  sectionOpen.value = { ...sectionOpen.value, [key]: !sectionOpen.value[key] };
}

export function SidebarPane(): VNode {
  if (sidebarMode.value === "tags") return <TagsModePane />;
  return <MainModePane />;
}

function MainModePane(): VNode {
  const f = filters.value;

  // Visible task list: AND-composed with the showAllTasks UI toggle (hide
  // done tasks when off). filteredTasks already applies status/lane/tag.
  const base = showAllTasks.value ? filteredTasks.value : filteredTasks.value.filter(t => t.status !== "done");
  // Render-time alphabetical sort with natural numeric ordering so
  // `task-2` precedes `task-12`. Server-side priority order is intentionally
  // discarded HERE only — `activeTask` still consumes the priority-sorted
  // `filteredTasks` for default-selection precedence.
  const visibleTasks = [...base].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }),
  );

  const renderViewRow = (v: SmartView): VNode => {
    const sel = v.status === null ? f.status === null && f.lane === null && f.tag.length === 0 : f.status === v.status;
    return (
      <button
        type="button"
        class={`view-row${sel ? " selected" : ""}`}
        onClick={() => {
          if (v.status === null) {
            clearAllFilters();
          } else {
            setFilter("status", v.status);
          }
        }}
        {...tip(
          v.status === null ? "Show every task (clears all filters)" : `Filter to ${v.label.toLowerCase()} tasks`,
        )}
      >
        <Icon name={v.icon} />
        <span class="view-name">{v.label}</span>
        <span class="view-count num">{v.count(tasks.value)}</span>
      </button>
    );
  };

  return (
    <aside class="pane pane-lanes sidebar-pane">
      <SidebarSystemBar />
      <div class="sidebar-body">
        <div class={`pane-section section-views ${sectionOpen.value.views ? "open" : "closed"}`}>
          <SectionHeader label="Views" open={sectionOpen.value.views} onToggle={() => toggleSection("views")} />
          {sectionOpen.value.views ? <div class="section-body">{SMART_VIEWS.map(renderViewRow)}</div> : null}
        </div>

        <div class={`pane-section section-lanes ${sectionOpen.value.lanes ? "open" : "closed"}`}>
          <SectionHeader
            label="Lanes"
            open={sectionOpen.value.lanes}
            count={lanes.value.length}
            onToggle={() => toggleSection("lanes")}
            trailing={
              <button
                class="btn-icon"
                aria-label="New lane"
                onClick={(e: MouseEvent) => {
                  e.stopPropagation();
                  modal.value = { kind: "new-lane" };
                }}
                {...tip("Create a new lane")}
              >
                <Icon name="plus" />
              </button>
            }
          />
          {sectionOpen.value.lanes ? (
            <div class="section-body">
              {lanes.value.map(l => {
                const open = tasks.value.filter(t => t.lane === l.name && t.status !== "done");
                const sel = f.lane === l.name;
                return (
                  <button
                    class={`lane-row${sel ? " selected" : ""}`}
                    onClick={() => {
                      setFilter("lane", sel ? null : l.name);
                    }}
                    onDragOver={(e: DragEvent) => {
                      e.preventDefault();
                      (e.currentTarget as HTMLElement).classList.add("dragover");
                    }}
                    onDragLeave={(e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("dragover")}
                    onDrop={async (e: DragEvent) => {
                      (e.currentTarget as HTMLElement).classList.remove("dragover");
                      const id = Number(e.dataTransfer?.getData("application/x-cortex-task-id"));
                      if (id) await tryApi(() => api.moveLane(id, l.name));
                    }}
                    title={`${open.length} open task${open.length === 1 ? "" : "s"}`}
                  >
                    <span class="lane-color" style={l.color ? `background: ${l.color}` : ""}></span>
                    <span class="lane-name">{l.name}</span>
                    <span class="lane-row-trail">
                      <span class="lane-count num">{open.length}</span>
                      <span
                        class="lane-edit-btn"
                        title="Edit lane"
                        onClick={(e: MouseEvent) => {
                          e.stopPropagation();
                          modal.value = { kind: "lane-edit", name: l.name };
                        }}
                      >
                        <Icon name="moreHorizontal" size={12} />
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <FilterChips />

        <div class={`pane-section section-tasks ${sectionOpen.value.tasks ? "open" : "closed"}`}>
          <SectionHeader
            label="Tasks"
            open={sectionOpen.value.tasks}
            count={visibleTasks.length}
            onToggle={() => toggleSection("tasks")}
            trailing={
              <button
                class="btn-icon"
                aria-label="New task"
                onClick={(e: MouseEvent) => {
                  e.stopPropagation();
                  void createUntitledTask(f.lane || "now");
                }}
                {...tip("Create a new task in the selected lane (or 'now')")}
              >
                <Icon name="plus" />
              </button>
            }
          />
          {sectionOpen.value.tasks ? (
            <div class="section-body">
              {visibleTasks.length === 0 ? (
                <p class="meta">no tasks match the current filters</p>
              ) : (
                visibleTasks.map(t => (
                  <button
                    class={`task-row${activeTask.value && t.id === activeTask.value.id ? " active" : ""}`}
                    draggable={true}
                    onDragStart={(e: DragEvent) =>
                      e.dataTransfer?.setData("application/x-cortex-task-id", String(t.id))
                    }
                    onClick={() => (selectedId.value = t.id)}
                    {...tip(t.title)}
                  >
                    <span class={`dot dot-status-${t.status}`}></span>
                    <span class="task-title">{t.title}</span>
                    <PriorityChip priority={t.priority} />
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

// Tag-management mode: single section listing every tag with edit affordance
// per row + a "+" trailing button to open NewTagModal. Mirrors the lanes-
// section UX so users have the same mental model for "manage <thing>". The
// pane chrome (system bar, FilterChips strip) is intentionally absent in
// this mode — tag MANAGEMENT is its own surface, distinct from tag
// FILTERING (which lives in the FilterChips strip + TagFilterModal).
function TagsModePane(): VNode {
  const sortedTags = [...tags.value].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <aside class="pane pane-lanes sidebar-pane">
      <SidebarSystemBar />
      <div class="sidebar-body">
        <div class="pane-section section-tags-manage open">
          <div class="section-head">
            <div class="row">
              <h1 class="eyebrow grow">Tags</h1>
              <span class="meta num" style="margin-right:6px">
                {sortedTags.length}
              </span>
              <button
                class="btn-icon"
                aria-label="New tag"
                onClick={() => (modal.value = { kind: "new-tag" })}
                {...tip("Create a new tag")}
              >
                <Icon name="plus" />
              </button>
            </div>
          </div>
          <div class="section-body">
            {sortedTags.length === 0 ? (
              <p class="meta">no tags yet — click + to create one</p>
            ) : (
              sortedTags.map(tg => (
                <button
                  class="lane-row"
                  onClick={() => (modal.value = { kind: "tag-edit", name: tg.name })}
                  {...tip(`Edit #${tg.name} (${tg.task_count} task${tg.task_count === 1 ? "" : "s"})`)}
                >
                  <TagPill name={tg.name} color={tg.color} interactive={true} />
                  <span class="lane-row-trail">
                    <span class="lane-count num">{tg.task_count}</span>
                    <span class="lane-edit-btn" title="Edit tag">
                      <Icon name="moreHorizontal" size={12} />
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

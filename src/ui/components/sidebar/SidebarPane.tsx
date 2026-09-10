// SidebarPane — the workspace navigation column.
//
// Three modes (sidebarMode signal):
//   "main" — the work surface:
//     .pane-system        (theme + management toggles + backup)
//     .sidebar-body
//       <WorkspaceFilters/> — THE filtering surface (search / status / lane
//                             / tags trigger / tag tokens / include-done /
//                             clear all) — see WorkspaceFilters.tsx (W2/W3)
//       section-tasks       — collapsible task list over orderedVisibleTasks;
//                             "+" creates `untitled-<id>` and selects it
//       lane-drop tray      — TRANSIENT: only while a task drag is active
//                             (draggedTaskId non-null). A drop surface, NOT
//                             a filter list (W5).
//
//   "lanes" / "tags" — explicit management panes ('Manage lanes' /
//     'Manage tags'): rows open the existing edit modals, "+" opens the
//     create modals. Opening a management mode never changes filters.
//
// Task rows are draggable (application/x-cortex-task-id). The header
// LanePicker remains the click/keyboard/touch alternative for moving tasks.

import type { ComponentChildren, VNode } from "preact";

import {
  tasks,
  lanes,
  tags,
  filters,
  sectionOpen,
  sidebarMode,
  selectedId,
  draggedTaskId,
  sidebarFilter,
  modal,
} from "../../state/signals.ts";
import { createUntitledTask } from "../../lib/createTask.ts";
import { clearWorkspaceTransientState } from "../../state/workspace.ts";
import { orderedVisibleTasks, activeTask } from "../../state/computed.ts";
import { tip } from "../../state/tooltip.ts";
import { api } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { SidebarSystemBar } from "./SidebarSystemBar.tsx";
import { SectionHeader } from "./SectionHeader.tsx";
import { WorkspaceFilters } from "./WorkspaceFilters.tsx";
import { SidebarFilterPanel } from "./SidebarFilterPanel.tsx";
import { Icon } from "../Icon.tsx";
import { TagPill } from "../chips/TagPill.tsx";
import { PriorityChip } from "../chips/PriorityChip.tsx";
import { STATUS_LABEL } from "../../lib/constants.ts";

export function SidebarPane(): VNode {
  if (sidebarMode.value === "tags") return <TagsModePane />;
  if (sidebarMode.value === "lanes") return <LanesModePane />;
  return <MainModePane />;
}

// Shared by the three actual navigation modes: one identity and one set
// of management/system actions, never a duplicate filter list.
function SidebarShell({ children }: { children: ComponentChildren }): VNode {
  return (
    <aside class="pane pane-lanes sidebar-pane">
      <header class="sidebar-brand">
        <span class="brand-mark" aria-hidden="true">
          c
        </span>
        <strong>cortex</strong>
        <span class="workspace-local">local</span>
      </header>
      {children}
      <SidebarSystemBar />
      {sidebarMode.value === "main" && sidebarFilter.value != null ? (
        <SidebarFilterPanel key={sidebarFilter.value} kind={sidebarFilter.value} />
      ) : null}
    </aside>
  );
}

function toggleTasksSection(): void {
  sectionOpen.value = { ...sectionOpen.value, tasks: !sectionOpen.value.tasks };
}

function MainModePane(): VNode {
  const f = filters.value;
  const rows = orderedVisibleTasks.value;
  const dragging = draggedTaskId.value != null;

  return (
    <SidebarShell>
      <div class="sidebar-body">
        <WorkspaceFilters />

        <div class={`pane-section section-tasks ${sectionOpen.value.tasks ? "open" : "closed"}`}>
          <SectionHeader
            label="Tasks"
            open={sectionOpen.value.tasks}
            count={rows.length}
            onToggle={toggleTasksSection}
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
              {rows.length === 0 ? (
                <p class="meta">no tasks match the current filters</p>
              ) : (
                rows.map(t => (
                  <button
                    key={t.id}
                    class={`task-row${activeTask.value && t.id === activeTask.value.id ? " active" : ""}`}
                    aria-current={activeTask.value?.id === t.id ? "page" : undefined}
                    draggable={true}
                    onDragStart={(e: DragEvent) => {
                      e.dataTransfer?.setData("application/x-cortex-task-id", String(t.id));
                      draggedTaskId.value = t.id;
                    }}
                    onDragEnd={() => {
                      // Fires on drop AND on cancelled drags (Esc) — the
                      // one reliable "drag is over" hook.
                      draggedTaskId.value = null;
                    }}
                    onClick={() => {
                      selectedId.value = t.id;
                      // An EXPLICIT pick dismisses filters/navigation even
                      // when this was already the selected or fallback task.
                      clearWorkspaceTransientState();
                    }}
                    {...tip(t.title)}
                  >
                    <span class={`dot dot-status-${t.status}`}></span>
                    <span class="task-row-main">
                      <span class="task-title">{t.title}</span>
                      <span class="task-row-meta">
                        <span class="num">@{t.id}</span>
                        <span aria-hidden="true">·</span>
                        <span>{STATUS_LABEL[t.status]}</span>
                      </span>
                    </span>
                    <PriorityChip priority={t.priority} />
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        {dragging ? <LaneDropTray /> : null}
      </div>
    </SidebarShell>
  );
}

// Transient drop tray, mounted ONLY during an actual task drag (W5). Each
// row is a drop target for the dragged task; dropping moves the task via
// the existing moveLane API. Deliberately NOT buttons and NOT filter rows —
// keyboard/touch moves go through the header LanePicker instead.
function LaneDropTray(): VNode {
  const finishDrop = async (e: DragEvent, laneName: string): Promise<void> => {
    (e.currentTarget as HTMLElement).classList.remove("dragover");
    // Prefer the drag payload MIME; fall back to the signal (covers test
    // environments and any browser that withholds dataTransfer on drop).
    const fromData = Number(e.dataTransfer?.getData("application/x-cortex-task-id"));
    const id = fromData > 0 ? fromData : draggedTaskId.value;
    draggedTaskId.value = null;
    if (id != null && id > 0) await tryApi(() => api.moveLane(id, laneName));
  };
  return (
    <fieldset class="lane-drop-tray" aria-label="Move to lane">
      <legend class="lane-drop-title">Move to lane</legend>
      {lanes.value.map(l => (
        <div
          key={l.name}
          class="lane-drop-target"
          onDragOver={(e: DragEvent) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).classList.add("dragover");
          }}
          onDragLeave={(e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("dragover")}
          onDrop={(e: DragEvent) => void finishDrop(e, l.name)}
        >
          <span class="lane-color" style={l.color ? `background: ${l.color}` : ""}></span>
          <span class="lane-name">{l.name}</span>
        </div>
      ))}
    </fieldset>
  );
}

// Lane-management mode: one section listing every lane with an edit
// affordance per row + a "+" trailing button to open NewLaneModal. Rows
// open LaneEditModal (rename / recolor / delete with the existing default-
// lane and nonempty-lane protections). NO filtering happens here (W5).
function LanesModePane(): VNode {
  const sorted = [...lanes.value].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  return (
    <SidebarShell>
      <div class="sidebar-body">
        <div class="pane-section section-lanes-manage open">
          <div class="section-head">
            <div class="row">
              <h1 class="eyebrow grow">Manage lanes</h1>
              <span class="meta num" style="margin-right:6px">
                {sorted.length}
              </span>
              <button
                class="btn-icon"
                aria-label="New lane"
                onClick={() => (modal.value = { kind: "new-lane" })}
                {...tip("Create a new lane")}
              >
                <Icon name="plus" />
              </button>
            </div>
          </div>
          <div class="section-body">
            {sorted.length === 0 ? (
              <p class="meta">no lanes yet — click + to create one</p>
            ) : (
              sorted.map(l => {
                const open = tasks.value.filter(t => t.lane === l.name && t.status !== "done").length;
                return (
                  <button
                    class="lane-row"
                    onClick={() => (modal.value = { kind: "lane-edit", name: l.name })}
                    {...tip(`Edit lane '${l.name}' (${open} open task${open === 1 ? "" : "s"})`)}
                  >
                    <span class="lane-color" style={l.color ? `background: ${l.color}` : ""}></span>
                    <span class="lane-name">{l.name}</span>
                    <span class="lane-row-trail">
                      <span class="lane-count num">{open}</span>
                      <span class="lane-edit-btn" title="Edit lane">
                        <Icon name="moreHorizontal" size={12} />
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </SidebarShell>
  );
}

// Tag-management mode: single section listing every tag with edit affordance
// per row + a "+" trailing button to open NewTagModal. Tag FILTERING lives
// in WorkspaceFilters; this pane is management only.
function TagsModePane(): VNode {
  const sortedTags = [...tags.value].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <SidebarShell>
      <div class="sidebar-body">
        <div class="pane-section section-tags-manage open">
          <div class="section-head">
            <div class="row">
              <h1 class="eyebrow grow">Manage tags</h1>
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
    </SidebarShell>
  );
}

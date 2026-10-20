// SidebarPane — the workspace navigation column.
//
// Three views (the rail's view signal):
//   "tasks" — the work surface (the rail beside it holds navigation,
//   theme and backup):
//     .sidebar-body
//       <WorkspaceFilters/> — THE filtering surface (search / status / lane
//                             / tags trigger / tag tokens / include-done /
//                             clear all) — see WorkspaceFilters.tsx
//       section-tasks       — collapsible task list over taskArrangement (the
//                             Sort and Group settings, or search relevance):
//                             an order line that opens the sort and group
//                             panel, then group headers (not rows) that fold
//                             their tasks away; "+" creates `untitled-<id>`
//                             and selects it
//       lane-drop tray      — TRANSIENT: only while a task drag is active
//                             (draggedTaskId non-null). A drop surface, NOT
//                             a filter list.
//
//   "lanes" / "tags" — the lists beside the Lanes and Tags panels: a search
//     field, then one row per entry; a row selects the entry its panel
//     shows, "+" opens the create modal. Opening them never changes filters.
//   "search" — SearchList: a search over every task beside the document.
//   "settings" — SettingsNav: the settings search and the panel's sections.
//   "backup", "agents" — App renders no list column at all.
//
// Task rows are draggable (application/x-cortex-task-id). The header
// LanePicker remains the click/keyboard/touch alternative for moving tasks.

import { type ComponentChildren, Fragment, type JSX, type VNode } from "preact";
import { useSignal } from "@preact/signals";

import {
  tasks,
  lanes,
  filters,
  sectionOpen,
  view,
  selectedId,
  draggedTaskId,
  sidebarFilter,
  modal,
  navigationOpen,
  selectedLane,
  selectedTag,
} from "../../state/signals.ts";
import { createUntitledTask } from "../../lib/createTask.ts";
import { clearWorkspaceTransientState } from "../../state/workspace.ts";
import { toggleSidebarFilter } from "../../state/popovers.ts";
import {
  collapseGroups,
  collapsedGroups,
  collapsedKeys,
  expandAllGroups,
  toggleGroupCollapsed,
} from "../../state/settings.ts";
import { taskArrangement, activeTask, shownLane, shownTag, sortedLanes, sortedTags } from "../../state/computed.ts";
import { tip } from "../../state/tooltip.ts";
import { api } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { SectionHeader } from "./SectionHeader.tsx";
import { WorkspaceFilters } from "./WorkspaceFilters.tsx";
import { SidebarFilterPanel } from "./SidebarFilterPanel.tsx";
import { SettingsNav } from "./SettingsNav.tsx";
import { SearchList } from "./SearchList.tsx";
import { Icon } from "../Icon.tsx";
import { TagPill } from "../chips/TagPill.tsx";
import { PriorityChip } from "../chips/PriorityChip.tsx";
import { STATUS_LABEL } from "../../../lib/constants.ts";
import type { Task } from "../../api/types.ts";
import { describeSort, type TaskListGroup } from "../../../lib/taskOrder.ts";
import { fmtAge } from "../../../lib/format.ts";
import { searchCatalog } from "../../../lib/catalogSearch.ts";

export function SidebarPane(): VNode {
  if (view.value === "tags") return <TagsModePane />;
  if (view.value === "lanes") return <LanesModePane />;
  if (view.value === "search")
    return (
      <SidebarShell>
        <SearchList />
      </SidebarShell>
    );
  if (view.value === "settings")
    return (
      <SidebarShell>
        <SettingsNav />
      </SidebarShell>
    );
  return <MainModePane />;
}

// Shared by every view with a list: one list column (navigation, theme and backup
// live in the rail), never a duplicate filter list.
function SidebarShell({ children }: { children: ComponentChildren }): VNode {
  return (
    <aside class="pane pane-lanes sidebar-pane">
      {children}
      {view.value === "tasks" && sidebarFilter.value != null ? (
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
  const { rows, order, group, groups } = taskArrangement.value;
  const folded = new Set(collapsedKeys(group, collapsedGroups.value));
  const dragging = draggedTaskId.value != null;
  const orderOpen = sidebarFilter.value === "order";

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
              <div class="meta task-order">
                <button
                  type="button"
                  id="sidebar-filter-order-trigger"
                  class="task-order-trigger"
                  aria-controls="sidebar-filter-order-panel"
                  aria-expanded={orderOpen}
                  data-pop
                  onClick={() => toggleSidebarFilter("order")}
                  {...tip("Change how the list is sorted and grouped")}
                >
                  <span>
                    Sorted by {order === "relevance" ? order : describeSort(order)}
                    {group === "none" ? "" : `, grouped by ${group}`}
                  </span>
                  <Icon name="chevronDown" size={12} />
                </button>
                {groups.length > 0 && group !== "none" ? (
                  <GroupFolds by={group} keys={groups.map(g => g.key)} folded={folded} />
                ) : null}
              </div>
              {rows.length === 0 ? (
                <p class="meta">no tasks match the current filters</p>
              ) : groups.length === 0 ? (
                rows.map(t => <TaskRow key={t.id} t={t} />)
              ) : (
                groups.map(g => (
                  <Fragment key={`group-${g.key}`}>
                    <GroupHeader group={g} by={group === "status" ? "status" : "lane"} folded={folded.has(g.key)} />
                    {folded.has(g.key)
                      ? null
                      : rows.slice(g.start, g.start + g.count).map(t => <TaskRow key={t.id} t={t} />)}
                  </Fragment>
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

// Collapse all folds every group the list shows; Expand all unfolds every
// group of the grouping. Each is disabled when it would change nothing.
function GroupFolds({
  by,
  keys,
  folded,
}: {
  by: "lane" | "status";
  keys: readonly string[];
  folded: ReadonlySet<string>;
}): VNode {
  const noun = by === "lane" ? "lanes" : "statuses";
  const shownFolded = keys.filter(k => folded.has(k)).length;
  return (
    <span class="task-order-folds">
      <button
        type="button"
        class="btn-icon"
        aria-label={`Collapse all ${noun}`}
        disabled={shownFolded === keys.length}
        onClick={() => collapseGroups(by, keys)}
        {...tip(`Collapse all ${noun}`)}
      >
        <Icon name="chevronsDownUp" size={14} />
      </button>
      <button
        type="button"
        class="btn-icon"
        aria-label={`Expand all ${noun}`}
        disabled={shownFolded === 0}
        onClick={() => expandAllGroups(by)}
        {...tip(`Expand all ${noun}`)}
      >
        <Icon name="chevronsUpDown" size={14} />
      </button>
    </span>
  );
}

// A group header folds its tasks away and back; the fold is remembered per
// grouping (lanes and statuses separately) and survives a relaunch.
function GroupHeader({ group, by, folded }: { group: TaskListGroup; by: "lane" | "status"; folded: boolean }): VNode {
  const color = by === "lane" ? lanes.value.find(l => l.name === group.key)?.color : null;
  return (
    <button
      type="button"
      class={`task-group-header${folded ? " folded" : ""}`}
      aria-expanded={!folded}
      onClick={() => toggleGroupCollapsed(by, group.key)}
      {...tip(folded ? `Show the tasks in ${group.label}` : `Hide the tasks in ${group.label}`)}
    >
      <Icon name="chevronDown" size={12} />
      {by === "lane" ? (
        <span class="lane-color" style={color ? `background: ${color}` : ""} aria-hidden="true"></span>
      ) : (
        <span class={`dot dot-status-${group.status}`} aria-hidden="true"></span>
      )}
      <span class="task-group-label">{group.label}</span>
      <span class="num task-group-count">{group.count}</span>
    </button>
  );
}

function TaskRow({ t }: { t: Task }): VNode {
  return (
    <button
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
      <span class={`dot dot-status-${t.status}`} role="img" aria-label={STATUS_LABEL[t.status]}></span>
      <span class="task-row-main">
        <span class="task-title">{t.title}</span>
        <span class="task-row-meta">
          <span class="num">@{t.id}</span>
          {t.tags.map(name => (
            <span key={name} class="task-row-tag">
              #{name}
            </span>
          ))}
        </span>
      </span>
      <span class="task-row-trail">
        <PriorityChip priority={t.priority} />
        <span class="task-row-time">{fmtAge(t.updated)}</span>
      </span>
    </button>
  );
}

// Transient drop tray, mounted ONLY during an actual task drag. Each
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

// The head of the Lanes and Tags lists: the title, the count, the one "+"
// button that opens the create modal, and a search field that narrows the
// rows (searchCatalog never caps).
function ListHead({
  title,
  count,
  create,
  find,
  query,
}: {
  title: string;
  count: number;
  create: { label: string; tip: string; kind: string };
  find: string;
  query: { value: string };
}): VNode {
  return (
    <div class="section-head list-head">
      <div class="row">
        <h1 class="list-title">{title}</h1>
        <span class="meta num">{count}</span>
        <span class="grow"></span>
        <button
          type="button"
          class="btn-icon"
          aria-label={create.label}
          onClick={() => (modal.value = { kind: create.kind })}
          {...tip(create.tip)}
        >
          <Icon name="plus" />
        </button>
      </div>
      <div class="catalog-search-field list-search">
        <Icon name="search" size={14} />
        <input
          type="search"
          aria-label={find}
          placeholder={find}
          value={query.value}
          onInput={(e: JSX.TargetedInputEvent<HTMLInputElement>) => (query.value = e.currentTarget.value)}
        />
      </div>
    </div>
  );
}

// A row selects its entry for the panel and, on a narrow window, closes the
// navigation drawer so the panel is usable.
function selectEntry(apply: () => void): void {
  apply();
  navigationOpen.value = false;
}

// The Lanes list: every lane in list order with its not-done count; the row
// of the lane the panel shows is marked. NO filtering happens here.
function LanesModePane(): VNode {
  const query = useSignal("");
  const sorted = sortedLanes.value;
  const shown = shownLane.value?.name ?? null;
  const { items } = searchCatalog(sorted, query.value, l => l.name);
  return (
    <SidebarShell>
      <div class="sidebar-body">
        <div class="pane-section section-lanes-manage open">
          <ListHead
            title="Lanes"
            count={sorted.length}
            create={{ label: "New lane", tip: "Create a new lane", kind: "new-lane" }}
            find="Find a lane"
            query={query}
          />
          <div class="section-body">
            {sorted.length === 0 ? (
              <p class="meta">no lanes yet — click + to create one</p>
            ) : items.length === 0 ? (
              <p class="meta">no lane matches</p>
            ) : (
              items.map(l => {
                const open = tasks.value.filter(t => t.lane === l.name && t.status !== "done").length;
                const current = l.name === shown;
                return (
                  <button
                    type="button"
                    key={l.name}
                    class={`lane-row${current ? " selected" : ""}`}
                    aria-current={current ? "true" : undefined}
                    onClick={() => selectEntry(() => (selectedLane.value = l.name))}
                    {...tip(`${l.name}: ${open} task${open === 1 ? "" : "s"} not done`)}
                  >
                    <span class="lane-color" style={l.color ? `background: ${l.color}` : ""}></span>
                    <span class="lane-name">{l.name}</span>
                    {l.name === "now" ? <span class="lane-default">default</span> : null}
                    <span class="lane-count num">{open}</span>
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

// The Tags list: every tag by name with its task count; the row of the tag
// the panel shows is marked. Tag FILTERING lives in WorkspaceFilters.
function TagsModePane(): VNode {
  const query = useSignal("");
  const sorted = sortedTags.value;
  const shown = shownTag.value?.name ?? null;
  const { items } = searchCatalog(sorted, query.value, tg => tg.name);
  return (
    <SidebarShell>
      <div class="sidebar-body">
        <div class="pane-section section-tags-manage open">
          <ListHead
            title="Tags"
            count={sorted.length}
            create={{ label: "New tag", tip: "Create a new tag", kind: "new-tag" }}
            find="Find a tag"
            query={query}
          />
          <div class="section-body">
            {sorted.length === 0 ? (
              <p class="meta">no tags yet — click + to create one</p>
            ) : items.length === 0 ? (
              <p class="meta">no tag matches</p>
            ) : (
              items.map(tg => {
                const current = tg.name === shown;
                return (
                  <button
                    type="button"
                    key={tg.name}
                    class={`lane-row${current ? " selected" : ""}`}
                    aria-current={current ? "true" : undefined}
                    onClick={() => selectEntry(() => (selectedTag.value = tg.name))}
                    {...tip(`#${tg.name}: ${tg.task_count} task${tg.task_count === 1 ? "" : "s"}`)}
                  >
                    <TagPill name={tg.name} color={tg.color} interactive={true} />
                    <span class="lane-count num">{tg.task_count}</span>
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

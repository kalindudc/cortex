// LanesPane — left sidebar in lanes mode.
//
// Layout: SidebarSystemBar | All-tasks view-row | Lanes section (list +
// new-lane form) | Tasks section (filtered by selectedLane) | pane-foot
// (new-task form + Commands palette button). The Lanes and Tasks sections
// live in SEPARATE scroll surfaces — see CSS .lanes-section / .tasks-section.

import type { JSX, VNode } from "preact";
import { useSignal } from "@preact/signals";

import {
  tasks,
  lanes,
  selectedLane,
  selectedId,
  modal,
  paletteOpen,
  newLaneOpen,
  showAllTasks,
} from "../../state/signals.ts";
import { tasksInLane, activeTask } from "../../state/computed.ts";
import { togglePopover } from "../../state/popovers.ts";
import { tip } from "../../state/tooltip.ts";
import { api } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { kbd, onSubmitKeys } from "../../lib/keys.ts";
import { SidebarSystemBar } from "./SidebarSystemBar.tsx";
import { Icon } from "../Icon.tsx";
import { PriorityChip } from "../chips/PriorityChip.tsx";

export function LanesPane(): VNode {
  // useSignal: stable across re-renders. With plain signal() the value reset
  // to "" on every keystroke (mutation -> re-render -> fresh signal) and
  // inputs felt frozen.
  const newLaneName = useSignal("");
  const newTaskTitle = useSignal("");
  // "All tasks" is a *view*, not a lane — it has no color, no editor, no
  // delete. Promote it to its own pane-section above "Lanes" so it doesn't
  // visually hijack a lane slot (where empty color/settings columns made it
  // look broken).
  const totalOpen = tasks.value.filter(t => t.status !== "done").length;

  const submitNewLane = async () => {
    const n = newLaneName.value.trim();
    if (!n) return;
    await tryApi(() => api.addLane({ name: n }));
    newLaneName.value = "";
    newLaneOpen.value = false;
  };

  const submitNewTask = async () => {
    const t = newTaskTitle.value.trim();
    if (!t) return;
    const lane = selectedLane.value || "now";
    const created = await tryApi(() => api.addTask({ title: t, lane }));
    newTaskTitle.value = "";
    if (created?.id) selectedId.value = created.id;
  };

  return (
    <aside class="pane pane-lanes">
      {/* System controls strip — lives at the top of the left sidebar so app-
           level toggles (theme today, settings/profile later) sit above any
           domain content. Right-aligned bare icon buttons; no eyebrow label
           because position + treatment already convey "app chrome". */}
      <SidebarSystemBar />
      <div class="pane-section" style="padding-bottom: 8px">
        <button
          class={`view-row${selectedLane.value === null ? " selected" : ""}`}
          onClick={() => {
            selectedLane.value = null;
            selectedId.value = null;
          }}
          title="Show every task across all lanes"
        >
          <Icon name="inbox" />
          <span class="view-name">All tasks</span>
          <span class="view-count">{totalOpen}</span>
        </button>
      </div>
      {/* Lanes and Tasks live in SEPARATE scroll surfaces — conceptually they
           answer different questions ("which lane am I in?" vs "which task in
           the current selection?") and merging their scroll context made it
           feel like the lane list was just a header for the task list.

           Lanes section: bounded to 50% of pane height when tasks list is
           also present (so a long lane list can't squeeze tasks out); takes
           all remaining middle space when tasks section is absent. Tasks
           section: takes the remaining vertical room and scrolls internally.
           All wired in CSS via :has() — see .lanes-section / .tasks-section. */}
      <div class="pane-section lanes-section">
        {/* .section-head is position:sticky inside the scroll container so the
             Lanes title + plus button stay visible as you scroll the lane
             list. The new-lane form (when open) lives in the head too so it
             anchors next to the trigger. */}
        <div class="section-head">
          <div class="row">
            <h1 class="eyebrow grow">Lanes</h1>
            <button
              class="btn-icon"
              data-pop
              title="New lane"
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                togglePopover(newLaneOpen);
              }}
            >
              <Icon name="plus" />
            </button>
          </div>
          {newLaneOpen.value ? (
            <form
              data-pop
              style="margin-top:8px"
              onSubmit={(e: Event) => {
                e.preventDefault();
                submitNewLane();
              }}
              onKeyDown={onSubmitKeys(submitNewLane)}
            >
              <input
                autoFocus
                placeholder="lane name"
                style="width:100%; height:28px; padding:4px 8px"
                value={newLaneName.value}
                onInput={(e: JSX.TargetedInputEvent<HTMLInputElement>) => (newLaneName.value = e.currentTarget.value)}
              />
            </form>
          ) : null}
        </div>
        <div class="section-body">
          {lanes.value.map(l => {
            const open = tasks.value.filter(t => t.lane === l.name && t.status !== "done");
            const sel = selectedLane.value === l.name;
            return (
              <button
                class={`lane-row${sel ? " selected" : ""}`}
                onClick={() => {
                  selectedLane.value = sel ? null : l.name;
                  selectedId.value = null;
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
              </button>
            );
          })}
        </div>
      </div>
      {tasks.value.length > 0 ? (
        <div class="pane-section tasks-section">
          <div class="section-head">
            <div class="row">
              <h1 class="eyebrow grow">
                {selectedLane.value ? <>Tasks &middot; {selectedLane.value}</> : <>All tasks</>}
              </h1>
              <button
                class="btn-icon"
                title={showAllTasks.value ? "Hide done tasks" : "Show done tasks too"}
                onClick={() => (showAllTasks.value = !showAllTasks.value)}
              >
                <Icon name={showAllTasks.value ? "eye" : "eyeOff"} />
              </button>
            </div>
          </div>
          <div class="section-body">
            {(() => {
              const visibleTasks = showAllTasks.value
                ? tasksInLane.value
                : tasksInLane.value.filter(t => t.status !== "done");
              return visibleTasks.length === 0 ? (
                <p class="meta">no tasks in this lane</p>
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
              );
            })()}
          </div>
        </div>
      ) : null}
      <div class="pane-foot">
        <form
          onSubmit={(e: Event) => {
            e.preventDefault();
            submitNewTask();
          }}
          onKeyDown={onSubmitKeys(submitNewTask)}
        >
          <div class="row">
            <input
              id="new-task-input"
              class="grow"
              placeholder="New task…"
              value={newTaskTitle.value}
              onInput={(e: JSX.TargetedInputEvent<HTMLInputElement>) => (newTaskTitle.value = e.currentTarget.value)}
              style="height:32px"
            />
            <button type="submit" class="btn btn-primary" style="height:32px" title="Add task">
              <Icon name="plus" />
            </button>
          </div>
        </form>
        <div class="row" style="margin-top:8px; justify-content:space-between">
          <button class="btn" style="height:24px; padding:0 8px" onClick={() => (paletteOpen.value = true)}>
            <Icon name="keyboard" size={12} />
            <span>Commands</span>
            <span class="kbd">{kbd("P")}</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

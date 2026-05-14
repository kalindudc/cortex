// TagsPane — sidebar swap-target when sidebarView==="tags". Mirrors LanesPane
// structure:
//   .pane-system | All-tags view-row | Tags section (list + new-tag form) |
//   pane-foot (Commands palette button).
// Click a tag row → toggle selectedTag (filters the right-pane task list).
// Hover a tag row → reveals an edit affordance that opens TagEditModal.

import type { VNode } from "preact";
import { useSignal } from "@preact/signals";

import { tasks, tags, selectedTag, selectedId, modal, paletteOpen, newTagOpen } from "../../state/signals.ts";
import { tasksInLane, activeTask, UNTAGGED } from "../../state/computed.ts";
import { togglePopover } from "../../state/popovers.ts";
import { tip } from "../../state/tooltip.ts";
import { api } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { kbd, onSubmitKeys } from "../../lib/keys.ts";
import { SidebarSystemBar } from "./SidebarSystemBar.tsx";
import { Icon } from "../Icon.tsx";
import { TagPill } from "../chips/TagPill.tsx";
import { PriorityChip } from "../chips/PriorityChip.tsx";

export function TagsPane(): VNode {
  const newTagName = useSignal("");
  // Sort tags alphabetically (server already does, but be defensive in case
  // a future tag.changed payload arrives in a different order).
  const sortedTags = [...tags.value].sort((a, b) => a.name.localeCompare(b.name));
  const totalTagged = tasks.value.filter(t => Array.isArray(t.tags) && t.tags.length > 0).length;

  const submitNewTag = async () => {
    const n = newTagName.value.trim();
    if (!n) return;
    await tryApi(() => api.addTag({ name: n }));
    newTagName.value = "";
    newTagOpen.value = false;
  };

  // When no tag is selected, show only tasks that carry at least one
  // tag — "All tagged tasks" should never list untagged ones.
  const taggedTaskList = selectedTag.value
    ? tasksInLane.value
    : tasksInLane.value.filter(t => Array.isArray(t.tags) && t.tags.length > 0);

  return (
    <aside class="pane pane-lanes pane-tags">
      <SidebarSystemBar />
      <div class="pane-section" style="padding-bottom: 8px">
        <button
          class={"view-row" + (selectedTag.value === null ? " selected" : "")}
          onClick={() => {
            selectedTag.value = null;
            selectedId.value = null;
          }}
          title="Show every tagged task across all tags"
        >
          <Icon name="hash" />
          <span class="view-name">All tags</span>
          <span class="view-count">{totalTagged}</span>
        </button>
        <button
          class={"view-row" + (selectedTag.value === UNTAGGED ? " selected" : "")}
          onClick={() => {
            selectedTag.value = UNTAGGED;
            selectedId.value = null;
          }}
          title="Show only tasks that carry no tags"
        >
          <Icon name="ban" />
          <span class="view-name">Untagged</span>
          <span class="view-count">{tasks.value.length - totalTagged}</span>
        </button>
      </div>
      <div class="pane-section lanes-section">
        <div class="section-head">
          <div class="row">
            <h1 class="eyebrow grow">Tags</h1>
            <button
              class="btn-icon"
              data-pop
              title="New tag"
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                togglePopover(newTagOpen);
              }}
            >
              <Icon name="plus" />
            </button>
          </div>
          {newTagOpen.value ? (
            <form
              data-pop
              style="margin-top:8px"
              onSubmit={(e: Event) => {
                e.preventDefault();
                submitNewTag();
              }}
              onKeyDown={onSubmitKeys(submitNewTag)}
            >
              <input
                autoFocus
                placeholder="tag name (a-z, 0-9, _ @ -)"
                style="width:100%; height:28px; padding:4px 8px"
                value={newTagName.value}
                onInput={(e: any) => (newTagName.value = e.currentTarget.value)}
              />
            </form>
          ) : null}
        </div>
        <div class="section-body">
          {sortedTags.length === 0 ? (
            <p class="meta">no tags yet</p>
          ) : (
            sortedTags.map(tg => {
              const sel = selectedTag.value === tg.name;
              return (
                <button
                  class={"lane-row" + (sel ? " selected" : "")}
                  onClick={() => {
                    selectedTag.value = sel ? null : tg.name;
                    selectedId.value = null;
                  }}
                  {...tip(`#${tg.name}  \u00b7  ${tg.task_count} task${tg.task_count === 1 ? "" : "s"}`)}
                >
                  <TagPill name={tg.name} color={tg.color} interactive={true} />
                  <span class="grow"></span>
                  <span class="lane-count num">{tg.task_count}</span>
                  <span
                    class="lane-edit-btn"
                    title="Edit tag"
                    onClick={(e: MouseEvent) => {
                      e.stopPropagation();
                      modal.value = { kind: "tag-edit", name: tg.name };
                    }}
                  >
                    <Icon name="moreHorizontal" size={12} />
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
      {/* Tasks section: same shape and CSS as LanesPane's tasks-section so a
           tag click in the row above shows the matching tasks in-place. The
           tasksInLane computed already AND-filters by selectedTag, so this is
           pure presentation. Header label adapts: '#tagname' when filtered,
           'All tagged tasks' when not (matches the All-tags view-row above). */}
      {tasks.value.length > 0 ? (
        <div class="pane-section tasks-section">
          <div class="section-head">
            <h1 class="eyebrow">
              {selectedTag.value === UNTAGGED ? (
                <>Untagged tasks</>
              ) : selectedTag.value ? (
                <>Tasks &middot; #{selectedTag.value}</>
              ) : (
                <>All tagged tasks</>
              )}
            </h1>
          </div>
          <div class="section-body">
            {taggedTaskList.length === 0 ? (
              <p class="meta">
                {selectedTag.value === UNTAGGED ? (
                  <>no untagged tasks</>
                ) : selectedTag.value ? (
                  <>no tasks carry #{selectedTag.value}</>
                ) : (
                  <>no tagged tasks yet</>
                )}
              </p>
            ) : (
              taggedTaskList.map(t => (
                <button
                  class={"task-row" + (activeTask.value && t.id === activeTask.value.id ? " active" : "")}
                  draggable={true}
                  onDragStart={(e: DragEvent) => e.dataTransfer!.setData("application/x-cortex-task-id", String(t.id))}
                  onClick={() => (selectedId.value = t.id)}
                  {...tip(t.title)}
                >
                  <span class={"dot dot-status-" + t.status}></span>
                  <span class="task-title">{t.title}</span>
                  <PriorityChip priority={t.priority} />
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
      <div class="pane-foot">
        <div class="row" style="justify-content:space-between">
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

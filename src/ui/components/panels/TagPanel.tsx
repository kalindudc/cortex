// TagPanel — the Tags view's main area: the tag the list shows (shownTag),
// its name and colour with one Save, the tasks that carry it (a click opens
// one), and its delete section. Creating a tag stays in NewTagModal (the
// list's "+"), and deleting still goes through the confirm-tag-delete
// dialog, which keeps the tasks.
//
// Edits use the same non-versioned write as the old edit dialog
// (api.editTag with only the changed fields; the server validates the name
// against TAG_NAME_RE); a rename follows the tag filter and the selection.

import type { JSX, VNode } from "preact";
import { useSignal } from "@preact/signals";

import { api, type EditTagBody } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import {
  filters,
  modal,
  selectedId,
  selectedTag,
  setFilter,
  tasks,
  view,
  type TagWithCount,
} from "../../state/signals.ts";
import { shownTag } from "../../state/computed.ts";
import { LANE_COLORS, STATUS_LABEL } from "../../../lib/constants.ts";
import { plural } from "../../../lib/format.ts";
import { onSubmitKeys } from "../../lib/keys.ts";
import { Icon } from "../Icon.tsx";
import { TagPill } from "../chips/TagPill.tsx";
import { PanelSheet } from "./PanelSheet.tsx";

function TagForm({ tag }: { tag: TagWithCount }): VNode {
  const renameTo = useSignal(tag.name);
  const color = useSignal<string | null>(tag.color || null);

  const fields = (): EditTagBody => {
    const out: EditTagBody = {};
    if (color.value !== (tag.color || null)) out.color = color.value;
    const name = renameTo.value.trim();
    if (name && name !== tag.name) out.rename = name;
    return out;
  };
  const changed = Object.keys(fields()).length > 0;

  const discard = (): void => {
    renameTo.value = tag.name;
    color.value = tag.color || null;
  };
  const save = async (): Promise<void> => {
    const patch = fields();
    if (Object.keys(patch).length === 0) return;
    try {
      await tryApi(() => api.editTag(tag.name, patch));
    } catch {
      return; // tryApi has shown the error; the form keeps the user's edits
    }
    const renamed = patch.rename;
    if (renamed) {
      // The tag filter is multi-select: swap the renamed entry in place.
      if (filters.value.tag.includes(tag.name)) {
        setFilter(
          "tag",
          filters.value.tag.map(n => (n === tag.name ? renamed : n)),
        );
      }
      selectedTag.value = renamed;
    }
  };

  return (
    <div class="panel-card" onKeyDown={onSubmitKeys(() => void save())}>
      <div class="panel-row">
        <label class="panel-row-label" for="tag-panel-name">
          <b>Name</b>
          <span>Lowercase letters, digits, _, @ and -, up to 32. Renaming keeps it on every task.</span>
        </label>
        <input
          id="tag-panel-name"
          class="panel-input"
          aria-label="Tag name"
          value={renameTo.value}
          onInput={(e: JSX.TargetedInputEvent<HTMLInputElement>) => (renameTo.value = e.currentTarget.value)}
        />
      </div>
      <div class="panel-row panel-row-top panel-row-colour">
        <div class="panel-row-label">
          <b>Colour</b>
          <span>The colour of the tag's pill everywhere.</span>
        </div>
        <div class="color-grid">
          {LANE_COLORS.map(c => (
            <button
              type="button"
              key={c ?? "none"}
              class={`color-swatch${color.value === c ? " selected" : ""}${c === null ? " clear" : ""}`}
              style={c ? `background: ${c}` : ""}
              title={c || "no color"}
              aria-label={c ? `Colour ${c}` : "No colour"}
              aria-pressed={color.value === c}
              onClick={() => (color.value = c)}
            />
          ))}
        </div>
      </div>
      <div class="panel-row panel-row-foot">
        <button type="button" class="btn btn-ghost" disabled={!changed} onClick={discard}>
          Discard changes
        </button>
        <button type="button" class="btn btn-primary" disabled={!changed} onClick={() => void save()}>
          Save changes
        </button>
      </div>
    </div>
  );
}

export function TagPanel(): VNode {
  const tag = shownTag.value;
  if (!tag) {
    return (
      <section class="pane panel-view tag-panel" aria-label="Tags">
        <header class="panel-head">
          <div class="panel-crumb">
            <b>Tags</b>
          </div>
        </header>
        <PanelSheet>
          <div class="empty">
            <Icon name="hash" size={32} />
            <div class="empty-title">No tags yet</div>
            <div class="empty-sub">Create one with the + button beside "Tags".</div>
          </div>
        </PanelSheet>
      </section>
    );
  }

  const carrying = tasks.value.filter(t => t.tags.includes(tag.name));
  const taskCount = tag.task_count ?? 0;

  return (
    <section class="pane panel-view tag-panel" aria-label={`Tag ${tag.name}`}>
      <header class="panel-head">
        <div class="panel-crumb">
          <span>Tags</span>
          <Icon name="chevronRight" size={12} />
          <b>#{tag.name}</b>
        </div>
        <span class="grow"></span>
        <button
          type="button"
          class="btn"
          aria-label={`Show tasks tagged ${tag.name}`}
          onClick={() => {
            setFilter("tag", [tag.name]);
            view.value = "tasks";
          }}
        >
          Show its tasks
        </button>
      </header>
      <PanelSheet>
        <div class="panel-inner">
          <h1 class="panel-title">
            <TagPill name={tag.name} color={tag.color} />
          </h1>
          <p class="panel-lede">On {plural(taskCount, "task")}.</p>

          <h2 class="panel-card-title">Tag</h2>
          <TagForm key={tag.name} tag={tag} />

          <h2 class="panel-card-title">
            Tasks with <span class="panel-card-title-name">#{tag.name}</span>
          </h2>
          <div class="panel-card panel-task-list">
            {carrying.length === 0 ? (
              <p class="meta panel-empty-line">No task carries this tag.</p>
            ) : (
              carrying.map(t => (
                <button
                  type="button"
                  key={t.id}
                  class="panel-task"
                  onClick={() => {
                    selectedId.value = t.id;
                    view.value = "tasks";
                  }}
                >
                  <span class={`dot dot-status-${t.status}`} role="img" aria-label={STATUS_LABEL[t.status]}></span>
                  <span class="panel-task-id num">@{t.id}</span>
                  <span class="panel-task-title">{t.title}</span>
                </button>
              ))
            )}
          </div>

          <h2 class="panel-card-title">Delete</h2>
          <div class="panel-card">
            <div class="panel-row">
              <div class="panel-row-label">
                <b>Delete this tag</b>
                <span>
                  {taskCount > 0
                    ? `Removes #${tag.name} from its ${plural(taskCount, "task")}. The tasks themselves are kept.`
                    : "No task carries it."}
                </span>
              </div>
              <button
                type="button"
                class="btn btn-danger"
                onClick={() => (modal.value = { kind: "confirm-tag-delete", name: tag.name, taskCount })}
              >
                <Icon name="trash" size={12} />
                <span>Delete tag</span>
              </button>
            </div>
          </div>
        </div>
      </PanelSheet>
    </section>
  );
}

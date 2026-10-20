// Persistent workspace chrome, separate from the document's title/metadata.
// All task mutations retain the existing API + confirmation paths; body-mode
// changes go through the workspace controller, never a new draft owner.
// TaskDocument hands in its Document / Activity tablist (`tabs`), which sits
// right after the breadcrumb so the task takes one header row.
import type { VNode } from "preact";
import type { Task } from "../../api/types.ts";
import { api } from "../../api/client.ts";
import { tryApi } from "../../api/errors.ts";
import { STATUS_LABEL, nextStatusFor, nextActionLabel } from "../../../lib/constants.ts";
import {
  lanes,
  modal,
  statusPopover,
  taskActionsPopover,
  readerMode,
  tab,
  focusReading,
  type ReaderMode,
} from "../../state/signals.ts";
import { togglePopover } from "../../state/popovers.ts";
import { contextShown, contextTab, hideContext, showContext } from "../../state/context.ts";
import { requestMode } from "../../state/workspace.ts";
import { tip } from "../../state/tooltip.ts";
import { modeShortcutHint, modeShortcutAria, modeShortcutDigit } from "../../lib/keys.ts";
import { Icon } from "../Icon.tsx";
import { StatusPopover } from "../chips/StatusPopover.tsx";

const MODES: Array<{ id: ReaderMode; label: string }> = [
  { id: "read", label: "Read" },
  { id: "edit", label: "Edit" },
  { id: "split", label: "Split" },
];

export function TaskToolbar({ task, tabs }: { task: Task; tabs?: VNode }): VNode {
  const next = nextStatusFor(task.status);
  const panelShown = contextShown();
  const panelLabel = panelShown ? "Hide the side panel" : "Show the side panel";
  const laneColor = lanes.value.find(l => l.name === task.lane)?.color ?? null;
  return (
    <div class="workspace-toolbar" role="toolbar" aria-label="Task toolbar">
      <div class="workspace-toolbar-leading">
        <div class="workspace-breadcrumb">
          <span class="lane-color" style={laneColor ? `background: ${laneColor}` : ""} aria-hidden="true"></span>
          <span>{task.lane}</span>
          <Icon name="chevronRight" size={12} />
          <span class="num">@{task.id}</span>
        </div>
        {tabs}
        {tab.value === "document" ? (
          <fieldset class="doc-mode-switch" aria-label="Body view mode">
            {MODES.map(mode => (
              <button
                key={mode.id}
                type="button"
                aria-label={mode.label}
                aria-pressed={readerMode.value === mode.id}
                aria-keyshortcuts={modeShortcutAria(mode.id)}
                {...tip(`${mode.label} (${modeShortcutHint(mode.id)})`)}
                class={readerMode.value === mode.id ? "active" : ""}
                onClick={() => requestMode(mode.id)}
              >
                <span>{mode.label}</span>
                <span class="mode-switch-digit" aria-hidden="true">
                  {modeShortcutDigit(mode.id)}
                </span>
              </button>
            ))}
          </fieldset>
        ) : null}
      </div>
      <div class="workspace-toolbar-actions">
        <div class="status-anchor" data-pop>
          <button
            type="button"
            class="status-pill"
            data-pop
            aria-label="Change status"
            aria-expanded={statusPopover.value}
            onClick={(event: MouseEvent) => {
              event.stopPropagation();
              togglePopover(statusPopover);
            }}
            {...tip("Change status")}
          >
            <span class={`dot dot-status-${task.status}`}></span>
            <span>{STATUS_LABEL[task.status]}</span>
            <Icon name="chevronDown" size={12} />
          </button>
          <StatusPopover task={task} />
        </div>
        <button
          type="button"
          class="btn btn-primary task-next-status"
          onClick={() => void tryApi(() => api.versioned.setStatus(task.id, { status: next })).catch(() => {})}
          {...tip(`Move to ${STATUS_LABEL[next]}`)}
        >
          {nextActionLabel(task.status)}
        </button>
        <button
          type="button"
          class="btn-icon focus-reading-toggle"
          aria-label={focusReading.value ? "Show navigation" : "Focus reading"}
          aria-pressed={focusReading.value}
          onClick={() => {
            focusReading.value = !focusReading.value;
          }}
          {...tip(focusReading.value ? "Show navigation" : "Focus on the document")}
        >
          <Icon name={focusReading.value ? "minimize" : "maximize"} size={16} />
        </button>
        <div class="task-actions-anchor" data-pop>
          <button
            type="button"
            class="btn-icon task-actions-trigger"
            data-pop
            aria-label="Task actions"
            aria-expanded={taskActionsPopover.value}
            onClick={(event: MouseEvent) => {
              event.stopPropagation();
              togglePopover(taskActionsPopover);
            }}
            {...tip("Task actions")}
          >
            <Icon name="moreHorizontal" size={16} />
          </button>
          {taskActionsPopover.value ? (
            <div class="popover task-actions-menu" data-pop role="menu" aria-label="Task actions">
              <button
                type="button"
                class="popover-row task-action-delete"
                role="menuitem"
                aria-label="Delete task"
                onClick={() => {
                  taskActionsPopover.value = false;
                  modal.value = { kind: "confirm-delete", id: task.id };
                }}
              >
                <Icon name="trash" size={14} />
                <span>Delete task…</span>
              </button>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          class="btn-icon side-panel-toggle"
          aria-label={panelLabel}
          aria-pressed={panelShown}
          onClick={() => (panelShown ? hideContext() : showContext(contextTab.value))}
          {...tip(panelLabel)}
        >
          <Icon name="panelRight" size={16} />
        </button>
      </div>
    </div>
  );
}

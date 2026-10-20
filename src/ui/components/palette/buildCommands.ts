// buildCommands — assemble the live command list for the command palette.
//
// Command shape:
//   { id, label, hint?, icon, action }   — leaf: runs and closes the palette
//   { id, label, hint?, icon, submenu }  — branch: clicking dives into a
//                                          new scope; `submenu()` returns
//                                          the next list of commands
//
// Branches keep the root short (one "Edit lane…" entry, not 50). Picking a
// branch pushes it onto the palette's scope stack; Esc / Backspace / clicking
// the breadcrumb pops back. Lazy `submenu` evaluation means we don't build
// per-lane lists until the user actually opens that scope.

import {
  setFilter,
  clearAllFilters,
  modal,
  paletteOpen,
  tagsPopover,
  lanes,
  tasks,
  tags,
  filters,
  tab,
  pendingTitleFocus,
  selectedLane,
  selectedTag,
} from "../../state/signals.ts";
import { createUntitledTask } from "../../lib/createTask.ts";
import { closeAllPopovers } from "../../state/popovers.ts";
import { contextShown, contextTab, hideContext, showContext } from "../../state/context.ts";
import { moveSelection } from "../../state/selection.ts";
import { openSettings, requestMode, requestPostUpdate, revealSidebarFilter } from "../../state/workspace.ts";
import { view } from "../../state/signals.ts";
import { theme, toggleTheme } from "../../state/theme.ts";
import { collapseGroups, expandAllGroups, SETTINGS, taskGroup, taskSort } from "../../state/settings.ts";
import { activeTask, resumeCandidatesForTask, taskArrangement } from "../../state/computed.ts";
import { resumeSession } from "../../lib/resume.ts";
import { setTaskMemory } from "../../lib/memory.ts";
import {
  GROUP_HELP,
  isDescending,
  SORT_FIELDS,
  SORT_HELP,
  sortField,
  sortOf,
  TASK_GROUPS,
} from "../../../lib/taskOrder.ts";
import { api } from "../../api/client.ts";
import { STATUS, STATUS_LABEL } from "../../../lib/constants.ts";
import { kbd, modeShortcutHint } from "../../lib/keys.ts";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  // Return value is intentionally `unknown` so action bodies can be terse
  // arrow expressions (e.g. `() => api.editTask(...)` returning a Promise<Task>)
  // without forcing every caller to wrap in a block to discard the result.
  action?: () => unknown | Promise<unknown>;
  submenu?: () => Command[];
}

export function buildCommands(): Command[] {
  const at = activeTask.value;
  const cmds: Command[] = [];

  // ----- always-available -----
  cmds.push({
    id: "new-task",
    label: "New task",
    hint: "",
    icon: "plus",
    action: () => {
      paletteOpen.value = false;
      const lane = filters.value.lane || "now";
      void createUntitledTask(lane);
    },
  });
  cmds.push({
    id: "post-update",
    label: "Post an update",
    hint: kbd("/"),
    icon: "eye",
    action: () => {
      paletteOpen.value = false;
      // ONE entry point: reveals Activity, expands the composer
      // disclosure and focuses its textarea. No active task → no-op.
      requestPostUpdate();
    },
  });
  cmds.push({ id: "next", label: "Next task", hint: "", icon: "chevronDown", action: () => moveSelection(+1) });
  cmds.push({ id: "prev", label: "Previous task", hint: "", icon: "chevronDown", action: () => moveSelection(-1) });

  // ----- active-task scoped -----
  if (at) {
    cmds.push({
      id: "set-status",
      label: "Set status\u2026",
      hint: `[${at.id}]`,
      icon: "checkCircle",
      submenu: () =>
        STATUS.filter(s => s !== at.status).map(s => ({
          id: `status-${s}`,
          label: STATUS_LABEL[s],
          hint: "",
          icon: "checkCircle",
          action: () => api.versioned.setStatus(at.id, { status: s }),
        })),
    });
    cmds.push({
      id: "set-priority",
      label: "Set priority\u2026",
      hint: `[${at.id}]`,
      icon: "star",
      submenu: () => {
        const numericEntries = [0, 1, 2, 3, 5]
          .filter(p => p !== at.priority)
          .map(p => ({
            id: `priority-${p}`,
            label: `P${p}${p === 0 ? " (urgent)" : ""}`,
            hint: "",
            icon: "star" as const,
            action: () => api.editTask(at.id, { priority: p }),
          }));
        // Only offer "Clear" when there is something to clear — omitting it
        // on already-unset tasks keeps the submenu noise-free.
        if (at.priority === null) return numericEntries;
        return [
          {
            id: "priority-clear",
            label: "Clear priority",
            hint: "",
            icon: "star" as const,
            action: () => api.editTask(at.id, { priority: null }),
          },
          ...numericEntries,
        ];
      },
    });
    cmds.push({
      id: "edit-task-tags",
      label: "Tags\u2026",
      hint: `[${at.id}]`,
      icon: "hash",
      action: () => {
        paletteOpen.value = false;
        // Open the picker on the current active task. The TagsHeaderChip
        // mounts the picker freshly when tagsPopover flips true (see the
        // mount-discipline note above TagsHeaderChip). closeAllPopovers()
        // first preserves the single-popover-at-a-time invariant.
        closeAllPopovers();
        tagsPopover.value = true;
        // Refocus the search input on next tick so keyboard flow stays
        // continuous (palette → picker, no mouse needed).
        setTimeout(() => (document.querySelector(".tag-picker-search input") as HTMLElement | null)?.focus(), 0);
      },
    });
    // Reading is IN PLACE now: the old view-markdown modal entry retargets
    // to Document/Read (the modal remains only as a legacy consumer).
    cmds.push({
      id: "view-markdown",
      label: "Read document",
      hint: modeShortcutHint("read"),
      icon: "book-open",
      action: () => requestMode("read"),
    });
    cmds.push({
      id: "edit-body",
      label: "Edit description",
      hint: modeShortcutHint("edit"),
      icon: "edit",
      action: () => requestMode("edit", "body"),
    });
    cmds.push({
      id: "split-view",
      label: "Split editor and preview",
      hint: modeShortcutHint("split"),
      icon: "fileText",
      action: () => requestMode("split"),
    });
    cmds.push({
      id: "edit-title",
      label: "Edit title",
      hint: `[${at.id}]`,
      icon: "edit",
      action: () => {
        // Editing a title does not choose a different body-mode preference.
        tab.value = "document";
        pendingTitleFocus.value = at.id;
      },
    });
    // Both always listed: the one that matches the task's state says "already".
    cmds.push({
      id: "memory-off",
      label: "Keep out of agent memory",
      hint: `[${at.id}]`,
      icon: "ban",
      action: () => setTaskMemory(at.id, true),
    });
    cmds.push({
      id: "memory-on",
      label: "Let agent memory offer this task",
      hint: `[${at.id}]`,
      icon: "rotateCcw",
      action: () => setTaskMemory(at.id, false),
    });
    cmds.push({
      id: "delete-task",
      label: "Delete task\u2026",
      hint: `[${at.id}]`,
      icon: "trash",
      action: () => (modal.value = { kind: "confirm-delete", id: at.id }),
    });
  }

  // ----- top-level smart-view filter shortcuts -----
  // Mirrors the View rows in SidebarPane so filter swaps stay one-key-away.
  cmds.push({
    id: "filter-review",
    label: "Filter: In review",
    hint: "",
    icon: "eye",
    action: () => {
      setFilter("status", "review");
    },
  });
  cmds.push({
    id: "filter-blocked",
    label: "Filter: Blocked",
    hint: "",
    icon: "ban",
    action: () => {
      setFilter("status", "blocked");
    },
  });
  cmds.push({
    id: "filter-clear",
    label: "Clear filters",
    hint: "",
    icon: "rotateCcw",
    action: () => {
      clearAllFilters();
    },
  });

  // ----- lane scoped (one root entry per verb) -----
  cmds.push({
    id: "filter-lane",
    label: "Filter by lane\u2026",
    hint: "",
    icon: "inbox",
    submenu: () => [
      {
        id: "lane-all",
        label: "All lanes",
        hint: "",
        icon: "inbox",
        action: () => {
          setFilter("lane", null);
        },
      },
      ...lanes.value.map(l => ({
        id: `lane-${l.name}`,
        label: l.name,
        hint: "",
        icon: "inbox",
        action: () => {
          setFilter("lane", l.name);
        },
      })),
    ],
  });
  if (lanes.value.length > 0) {
    cmds.push({
      id: "edit-lane",
      label: "Edit lane\u2026",
      hint: "",
      icon: "eye",
      submenu: () =>
        lanes.value.map(l => ({
          id: `lane-open-${l.name}`,
          label: l.name,
          hint: "",
          icon: "eye",
          action: () => {
            selectedLane.value = l.name;
            view.value = "lanes";
          },
        })),
    });
  }
  // Delete lane: only show if there's at least one deletable lane (not 'now',
  // no tasks). If none qualify, hide the verb entirely — a sub-menu with zero
  // entries is a dead end.
  const deletable = lanes.value.filter(l => l.name !== "now" && !tasks.value.some(t => t.lane === l.name));
  if (deletable.length > 0) {
    cmds.push({
      id: "delete-lane",
      label: "Delete lane\u2026",
      hint: "",
      icon: "trash",
      submenu: () =>
        deletable.map(l => ({
          id: `lane-del-${l.name}`,
          label: l.name,
          hint: "",
          icon: "trash",
          action: () => (modal.value = { kind: "confirm-lane-delete", name: l.name }),
        })),
    });
  }
  cmds.push({
    id: "new-lane",
    label: "New lane\u2026",
    hint: "",
    icon: "plus",
    action: () => {
      // Routes through ModalRoot → NewLaneModal so the name input is
      // reliably focused on open.
      closeAllPopovers();
      modal.value = { kind: "new-lane" };
    },
  });

  // ----- tag scoped (filter + the Tags panel) -----
  // The palette reveals the canonical attached sidebar filter, including
  // search and multi-select. Keep the historical command id for matching;
  // no per-tag flat commands or detached filtering modal.
  // Standalone tag CREATION lives in TagPicker on the active task.
  cmds.push({
    id: "filter-tags-modal",
    label: "Filter by tags\u2026",
    hint: "sidebar filter",
    icon: "hash",
    action: () => revealSidebarFilter("tags"),
  });
  if (tags.value.length > 0) {
    cmds.push({
      id: "edit-tag",
      label: "Edit tag\u2026",
      hint: "",
      icon: "eye",
      submenu: () =>
        [...tags.value]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(tg => ({
            id: `tag-open-${tg.name}`,
            label: `#${tg.name}`,
            hint: "",
            icon: "eye",
            action: () => {
              selectedTag.value = tg.name;
              view.value = "tags";
            },
          })),
    });
  }

  // ----- management (the rail's panels — never filter changes) -----
  cmds.push({
    id: "manage-lanes",
    label: "Manage lanes",
    hint: "",
    icon: "layers",
    action: () => {
      view.value = "lanes";
    },
  });
  cmds.push({
    id: "manage-tags",
    label: "Manage tags",
    hint: "",
    icon: "hash",
    action: () => {
      view.value = "tags";
    },
  });
  cmds.push({
    id: "backup",
    label: "Backup\u2026",
    hint: "",
    icon: "archive",
    action: () => {
      view.value = "backup";
    },
  });

  // ----- side panel (the same toggle as the task toolbar's button) -----
  const panelShown = contextShown();
  cmds.push({
    id: "side-panel",
    label: panelShown ? "Hide the side panel" : "Show the side panel",
    hint: "",
    icon: "panelRight",
    action: () => (panelShown ? hideContext() : showContext(contextTab.value)),
  });

  // ----- resume (only when the active task has a pi or bb author) -----
  const candidates = resumeCandidatesForTask.value;
  if (at && candidates.length > 0) {
    cmds.push({
      id: "resume-session",
      label: "Resume a session\u2026",
      hint: `[${at.id}]`,
      icon: "play",
      submenu: () =>
        candidates.map(c => ({
          id: `resume-${c.author}`,
          label: c.author,
          hint: c.harness === "bb" ? "open in bb" : "copy the pi command",
          icon: "play",
          action: () => {
            showContext("details");
            return resumeSession(at.id, c.author);
          },
        })),
    });
  }

  // ----- settings -----
  const current = (on: boolean): string => (on ? "current" : "");
  cmds.push({
    id: "sort-group",
    label: "Sort and group\u2026",
    hint: "",
    icon: "layers",
    submenu: () => [
      ...SORT_FIELDS.map(v => ({
        id: `sort-${v}`,
        label: `Sort by ${v}: ${SORT_HELP[v]}`,
        hint: current(sortField(taskSort.value) === v),
        icon: "chevronDown",
        action: () => {
          taskSort.value = sortOf(v, isDescending(taskSort.value));
        },
      })),
      ...[false, true].map(descending => ({
        id: descending ? "sort-descending" : "sort-ascending",
        label: descending ? "Sort descending: highest first" : "Sort ascending: lowest first",
        hint: current(isDescending(taskSort.value) === descending),
        icon: descending ? "chevronDown" : "chevronUp",
        action: () => {
          taskSort.value = sortOf(sortField(taskSort.value), descending);
        },
      })),
      ...TASK_GROUPS.map(v => ({
        id: `group-${v}`,
        label: `Group by ${v}: ${GROUP_HELP[v]}`,
        hint: current(taskGroup.value === v),
        icon: "layers",
        action: () => {
          taskGroup.value = v;
        },
      })),
    ],
  });
  // Fold or unfold the list's groups, while it shows some.
  const { group: grouping, groups: shownGroups } = taskArrangement.value;
  if (grouping !== "none" && shownGroups.length > 0) {
    const noun = grouping === "lane" ? "lanes" : "statuses";
    cmds.push({
      id: "collapse-groups",
      label: `Collapse all ${noun}`,
      hint: "",
      icon: "chevronsDownUp",
      action: () =>
        collapseGroups(
          grouping,
          shownGroups.map(g => g.key),
        ),
    });
    cmds.push({
      id: "expand-groups",
      label: `Expand all ${noun}`,
      hint: "",
      icon: "chevronsUpDown",
      action: () => expandAllGroups(grouping),
    });
  }
  const appearanceSetting = SETTINGS.find(s => s.key === "appearance");
  if (appearanceSetting) {
    cmds.push({
      id: "appearance",
      label: "Appearance\u2026",
      hint: "",
      icon: "monitor",
      submenu: () =>
        appearanceSetting.choices.map(c => ({
          id: `appearance-${c.value}`,
          label: `${c.label}: ${c.help}`,
          hint: current(appearanceSetting.current() === c.value),
          icon: "monitor",
          action: () => appearanceSetting.set(c.value),
        })),
    });
  }
  cmds.push({
    id: "settings",
    label: "Settings",
    hint: kbd(","),
    icon: "settings",
    action: () => openSettings(),
  });

  // ----- system -----
  cmds.push({
    id: "theme-toggle",
    label: theme.value === "dark" ? "Switch to light mode" : "Switch to dark mode",
    hint: "",
    icon: theme.value === "dark" ? "sun" : "moon",
    action: () => toggleTheme(),
  });
  return cmds;
}

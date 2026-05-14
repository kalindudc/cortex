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

import { activeTask } from "../../state/computed.ts";
import {
  setFilter,
  clearAllFilters,
  modal,
  paletteOpen,
  tagsPopover,
  lanes,
  tasks,
  tags,
  selectedId,
} from "../../state/signals.ts";
import { closeAllPopovers } from "../../state/popovers.ts";
import { moveSelection } from "../../state/selection.ts";
import { theme, toggleTheme } from "../../state/theme.ts";
import { api } from "../../api/client.ts";
import { STATUS, STATUS_LABEL } from "../../lib/constants.ts";
import { kbd } from "../../lib/keys.ts";

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
      setTimeout(() => document.getElementById("new-task-input")?.focus(), 0);
    },
  });
  cmds.push({
    id: "post-update",
    label: "Focus post-update box",
    hint: kbd("/"),
    icon: "eye",
    action: () => {
      paletteOpen.value = false;
      setTimeout(() => document.getElementById("post-update-input")?.focus(), 0);
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
          action: () => api.setStat(at.id, s),
        })),
    });
    cmds.push({
      id: "set-priority",
      label: "Set priority\u2026",
      hint: `[${at.id}]`,
      icon: "star",
      submenu: () =>
        [0, 1, 2, 3, 5]
          .filter(p => p !== at.priority)
          .map(p => ({
            id: `priority-${p}`,
            label: `P${p}${p === 0 ? " (urgent)" : ""}`,
            hint: "",
            icon: "star",
            action: () => api.editTask(at.id, { priority: p }),
          })),
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
      selectedId.value = null;
    },
  });
  cmds.push({
    id: "filter-blocked",
    label: "Filter: Blocked",
    hint: "",
    icon: "ban",
    action: () => {
      setFilter("status", "blocked");
      selectedId.value = null;
    },
  });
  cmds.push({
    id: "filter-clear",
    label: "Clear filters",
    hint: "",
    icon: "rotateCcw",
    action: () => {
      clearAllFilters();
      selectedId.value = null;
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
          selectedId.value = null;
        },
      },
      ...lanes.value.map(l => ({
        id: `lane-${l.name}`,
        label: l.name,
        hint: "",
        icon: "inbox",
        action: () => {
          setFilter("lane", l.name);
          selectedId.value = null;
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
          id: `lane-edit-${l.name}`,
          label: l.name,
          hint: "",
          icon: "eye",
          action: () => (modal.value = { kind: "lane-edit", name: l.name }),
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
      // Routes through ModalRoot → NewLaneModal so creation matches the
      // edit/delete flow and the name input is reliably focused on open.
      closeAllPopovers();
      modal.value = { kind: "new-lane" };
    },
  });

  // ----- tag scoped (filter + edit) -----
  // Single top-level "Filter by tags…" entry opens TagFilterModal — that's
  // the canonical entry for ALL tag filtering, including search and multi-
  // select. We deliberately do NOT flatten per-tag toggle commands into the
  // root list: it bloats the palette and the modal's own search already
  // covers "type a tag name to find it" use case.
  // Standalone tag CREATION lives in TagPicker on the active task.
  cmds.push({
    id: "filter-tags-modal",
    label: "Filter by tags\u2026",
    hint: "opens modal",
    icon: "hash",
    action: () => (modal.value = { kind: "filter-tags" }),
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
            id: `tag-edit-${tg.name}`,
            label: `#${tg.name}`,
            hint: "",
            icon: "eye",
            action: () => (modal.value = { kind: "tag-edit", name: tg.name }),
          })),
    });
  }

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

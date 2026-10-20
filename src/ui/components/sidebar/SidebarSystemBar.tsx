// SidebarSystemBar — top app-chrome strip on the unified SidebarPane.
//
// Layout (left → right):
//
//   Theme toggle
//   Back to tasks (home) — ONLY while a management mode is active
//   Manage lanes (layers) — explicit lane-management mode toggle
//   Manage tags (hash)    — explicit tag-management mode toggle
//   Backup now (download) — writes a data-only backup via POST /api/backup
//   (grow spacer)
//
// Filtering toggles (include-done, clear-all) live in WorkspaceFilters —
// the bar is app chrome, not a second filter surface. Entering or
// leaving a management mode never touches the filter signals.

import type { VNode } from "preact";
import { useSignal } from "@preact/signals";
import { api } from "../../api/client.ts";
import { showError } from "../../api/errors.ts";
import { sidebarMode } from "../../state/signals.ts";
import { tip } from "../../state/tooltip.ts";
import { Icon } from "../Icon.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

export function SidebarSystemBar(): VNode {
  const mode = sidebarMode.value;
  const backingUp = useSignal(false);
  const backupTip = useSignal("Write a data-only backup now");
  const backupSaved = useSignal(false);

  const runBackup = async (): Promise<void> => {
    if (backingUp.value) return;
    backingUp.value = true;
    backupSaved.value = false;
    backupTip.value = "Writing backup…";
    try {
      const result = await api.backup();
      backupSaved.value = true;
      backupTip.value = `Backup saved to ${result.outPath}`;
    } catch (err) {
      backupTip.value = "Backup failed";
      showError(err);
    } finally {
      backingUp.value = false;
    }
  };

  return (
    <div class="pane-system">
      {mode !== "main" ? (
        <button
          class="sidebar-back"
          aria-label="Back to tasks"
          onClick={() => (sidebarMode.value = "main")}
          {...tip("Back to the task list")}
        >
          <Icon name="home" />
          <span>Back to tasks</span>
        </button>
      ) : null}
      <button
        class={`btn-icon sidebar-manage${mode === "lanes" ? " btn-icon-active" : ""}`}
        aria-label="Manage lanes"
        onClick={() => (sidebarMode.value = mode === "lanes" ? "main" : "lanes")}
        {...tip(mode === "lanes" ? "Close lane management" : "Manage lanes (create, edit, delete)")}
      >
        <Icon name="layers" />
        <span>Lanes</span>
      </button>
      <button
        class={`btn-icon sidebar-manage${mode === "tags" ? " btn-icon-active" : ""}`}
        aria-label="Manage tags"
        onClick={() => (sidebarMode.value = mode === "tags" ? "main" : "tags")}
        {...tip(mode === "tags" ? "Close tag management" : "Manage tags (create, edit, delete)")}
      >
        <Icon name="hash" />
        <span>Tags</span>
      </button>
      <span class="grow"></span>
      <ThemeToggle />
      <button
        class={`btn-icon${backupSaved.value ? " btn-icon-active" : ""}`}
        aria-label={backingUp.value ? "Backing up" : "Back up now"}
        disabled={backingUp.value}
        onClick={() => void runBackup()}
        {...tip(backupTip.value)}
      >
        <Icon name="download" />
      </button>
    </div>
  );
}

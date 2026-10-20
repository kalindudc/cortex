// BackupPanel — the Backup view (no list column): the last backup, "Back up
// now" with a visible result, where backups go and how many the folder
// keeps, and the terminal steps to restore one.
//
// The last backup is the newest notification titled
// BACKUP_NOTIFICATION_TITLE; its message is "<path> (<bytes> bytes; N tasks,
// M updates)". The daemon deletes all but the newest `rotate` backups after
// writing, so the Keep backups setting is sent as `rotate` (0 keeps all and
// is not sent). Restore stays in the terminal: `cortex restore` refuses
// while a daemon runs, and the app restarts its daemon on the next request,
// so the app must be quit first.

import type { VNode } from "preact";
import { useSignal } from "@preact/signals";

import type { BackupResult } from "../../../contracts.ts";
import type { Notification } from "../../api/types.ts";
import { api } from "../../api/client.ts";
import { showError } from "../../api/errors.ts";
import { notifications } from "../../state/notifications.ts";
import { backupKeep, SETTINGS } from "../../state/settings.ts";
import { BACKUP_NOTIFICATION_TITLE } from "../../../lib/constants.ts";
import { fmtTime, plural } from "../../../lib/format.ts";
import { Icon } from "../Icon.tsx";
import { SettingRow } from "./SettingRow.tsx";

const RESTORE_COMMANDS = "cortex stop\ncortex restore --dry-run <file>\ncortex restore <file>";

// The path at the front of a backup notification's message.
function backupPathOf(message: string): string {
  const cut = message.lastIndexOf(" (");
  return cut < 0 ? message : message.slice(0, cut);
}

function folderOf(file: string): string {
  return file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")));
}

function CopyButton({ label, text, disabled = false }: { label: string; text: string; disabled?: boolean }): VNode {
  const state = useSignal<"idle" | "copied" | "failed">("idle");
  const copy = (): void => {
    const clip = navigator.clipboard;
    if (!clip || typeof clip.writeText !== "function") {
      state.value = "failed";
      return;
    }
    clip.writeText(text).then(
      () => {
        state.value = "copied";
        setTimeout(() => (state.value = "idle"), 1500);
      },
      () => (state.value = "failed"),
    );
  };
  return (
    <button type="button" class="btn" disabled={disabled} onClick={copy}>
      <Icon name={state.value === "copied" ? "check" : "copy"} />
      <span>{state.value === "copied" ? "Copied" : state.value === "failed" ? "Copy failed" : label}</span>
    </button>
  );
}

export function BackupPanel(): VNode {
  const running = useSignal(false);
  const result = useSignal<BackupResult | null>(null);
  const failed = useSignal(false);

  const last = notifications.value
    .filter(n => n.title === BACKUP_NOTIFICATION_TITLE)
    .reduce<Notification | null>((a, n) => (a == null || n.created > a.created ? n : a), null);
  const knownPath = result.value?.outPath ?? (last ? backupPathOf(last.message) : null);
  const folder = knownPath ? folderOf(knownPath) : null;
  const keepSpec = SETTINGS.find(s => s.key === "backup");

  const run = async (): Promise<void> => {
    if (running.value) return;
    running.value = true;
    failed.value = false;
    try {
      const keep = backupKeep.value;
      result.value = await api.backup(keep > 0 ? { rotate: keep } : undefined);
    } catch (err) {
      result.value = null;
      failed.value = true;
      showError(err);
    } finally {
      running.value = false;
    }
  };

  const saved = result.value;
  return (
    <section class="pane panel-view backup-panel" aria-label="Backup">
      <header class="panel-head">
        <div class="panel-crumb">
          <b>Backup</b>
        </div>
      </header>
      <div class="panel-body">
        <div class="panel-inner">
          <h1 class="panel-title">Backup</h1>
          <p class="panel-lede">
            A backup is one zip file with every task, update, lane, tag and notification. It is safe to take while
            agents are writing.
          </p>

          <div class="panel-card">
            <div class="panel-row backup-status">
              <span class="backup-icon" aria-hidden="true">
                <Icon name="archive" size={18} />
              </span>
              <div class="panel-row-label">
                <b class="backup-last">{last ? `Last backup ${fmtTime(last.created)}` : "No backup yet"}</b>
                {last ? <span class="mono backup-last-detail">{last.message}</span> : null}
              </div>
              <button
                type="button"
                class="btn btn-primary"
                aria-label={running.value ? "Backing up" : "Back up now"}
                disabled={running.value}
                onClick={() => void run()}
              >
                <Icon name="download" />
                <span>{running.value ? "Backing up…" : "Back up now"}</span>
              </button>
            </div>
            {saved ? (
              <div class="panel-row backup-result backup-ok" role="status">
                <Icon name="check" />
                <div class="panel-row-label">
                  <b>
                    Backup saved to <span class="mono">{saved.outPath}</span>
                  </b>
                  <span>
                    {saved.bytes.toLocaleString("en-US")} bytes · {plural(saved.stats.tasks, "task")} ·{" "}
                    {plural(saved.stats.updates, "update")}
                  </span>
                </div>
              </div>
            ) : failed.value ? (
              <div class="panel-row backup-result backup-failed" role="status">
                <Icon name="x" />
                <span>Backup failed</span>
              </div>
            ) : null}
          </div>

          <h2 class="panel-card-title">Where backups go</h2>
          <div class="panel-card">
            <div class="panel-row">
              <div class="panel-row-label">
                <b>Folder</b>
                {folder ? (
                  <span class="mono backup-folder">{folder}</span>
                ) : (
                  <span class="backup-folder">the backups folder in your cortex configuration directory</span>
                )}
              </div>
              <CopyButton label="Copy path" text={folder ?? ""} disabled={folder == null} />
            </div>
            {keepSpec ? <SettingRow spec={keepSpec} /> : null}
          </div>

          <h2 class="panel-card-title">Restore</h2>
          <div class="panel-callout">
            <p>Restoring merges a backup into this database and needs the daemon stopped, so it runs in a terminal:</p>
            <ol>
              <li>Quit the cortex app.</li>
              <li>
                <code>cortex stop</code>
              </li>
              <li>
                <code>cortex restore --dry-run &lt;file&gt;</code> to preview, then{" "}
                <code>cortex restore &lt;file&gt;</code>
              </li>
            </ol>
            <CopyButton label="Copy commands" text={RESTORE_COMMANDS} />
          </div>
        </div>
      </div>
    </section>
  );
}

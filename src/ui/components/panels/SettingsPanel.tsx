// SettingsPanel — the Settings view's main area: every setting in cards by
// section, the Shortcuts and Commands, and About. One search (settingsQuery,
// typed in the list column's SettingsNav) filters settings, commands and
// shortcuts together (lib/help.ts); settings change in place and persist in
// this window's localStorage. The ONLY renderer of the desktop's help
// registry; each setting renders through SettingRow.

import type { ComponentChildren, VNode } from "preact";
import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";

import type { HealthResponse } from "../../../contracts.ts";
import { slugify } from "../../../lib/slug.ts";
import { api } from "../../api/client.ts";
import { filterHelp, type HelpRow, helpRows } from "../../lib/help.ts";
import { IS_MAC } from "../../lib/keys.ts";
import { SETTINGS, type SettingSpec } from "../../state/settings.ts";
import { meAuthor, settingsQuery } from "../../state/signals.ts";
import { buildCommands } from "../palette/buildCommands.ts";
import { PanelSheet } from "./PanelSheet.tsx";
import { SettingRow } from "./SettingRow.tsx";

export const SETTING_SECTIONS: readonly SettingSpec["section"][] = [
  "Appearance",
  "Task list",
  "Documents",
  "Notifications",
  "Backup",
];
const ABOUT_LABELS = ["About", "Version", "Database", "Daemon", "Author"];

/** The id a section's heading scrolls to, shared with SettingsNav. */
export const sectionId = (name: string): string => `settings-${slugify(name)}`;

function Section({ name, children }: { name: string; children: ComponentChildren }): VNode {
  return (
    <section class="settings-section" aria-label={name} id={sectionId(name)}>
      <h2 class="panel-card-title">{name}</h2>
      {children}
    </section>
  );
}

function HelpSection({ name, rows }: { name: string; rows: readonly HelpRow[] }): VNode | null {
  if (rows.length === 0) return null;
  return (
    <Section name={name}>
      <div class="panel-card">
        {rows.map(r => (
          <div class="help-row" key={r.id} data-help-id={r.id}>
            <span class="help-title">{r.title}</span>
            {r.keys ? (
              <span class="help-keys">
                <span class="kbd">{r.keys}</span>
                {r.where ? <span class="meta"> {r.where}</span> : null}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </Section>
  );
}

function AboutSection(): VNode {
  const health = useSignal<HealthResponse | "failed" | null>(null);
  useEffect(() => {
    api.health().then(
      h => (health.value = h),
      () => (health.value = "failed"),
    );
  }, []);
  const h = health.value;
  const loaded = h !== null && h !== "failed" ? h : null;
  const identity = loaded?.identity;
  const value = (text: string | undefined): string => (h === null ? "Loading…" : (text ?? "Unavailable"));
  return (
    <Section name="About">
      <div class="panel-card">
        <dl class="about-list">
          <div class="panel-row">
            <dt>Version</dt>
            <dd>{value(loaded?.version)}</dd>
          </div>
          <div class="panel-row">
            <dt>Database</dt>
            <dd class="mono">{value(identity?.databasePath)}</dd>
          </div>
          <div class="panel-row">
            <dt>Daemon</dt>
            <dd class="mono">
              {value(identity ? `${identity.instanceId.slice(0, 8)} · pid ${identity.pid}` : undefined)}
            </dd>
          </div>
          <div class="panel-row">
            <dt>Author</dt>
            <dd class="mono">{meAuthor.value}</dd>
          </div>
        </dl>
      </div>
    </Section>
  );
}

export function SettingsPanel(): VNode {
  const query = settingsQuery.value;
  const rows = filterHelp(helpRows({ settings: SETTINGS, commands: buildCommands(), mac: IS_MAC }), query);
  const shown = new Set(rows.filter(r => r.section === "Settings").map(r => r.id));
  const settings = SETTINGS.filter(s => shown.has(s.key));
  const needle = query.trim().toLowerCase();
  const about = needle === "" || ABOUT_LABELS.some(l => l.toLowerCase().includes(needle));

  return (
    <section class="pane panel-view settings-panel" aria-label="Settings">
      <header class="panel-head">
        <div class="panel-crumb">
          <b>Settings</b>
        </div>
      </header>
      <PanelSheet>
        <div class="panel-inner">
          {rows.length === 0 && !about ? (
            <p class="meta settings-empty">No setting, command or shortcut matches</p>
          ) : null}
          {SETTING_SECTIONS.map(name => {
            const specs = settings.filter(s => s.section === name);
            return specs.length === 0 ? null : (
              <Section name={name} key={name}>
                <div class="panel-card">
                  {specs.map(s => (
                    <SettingRow spec={s} key={s.key} />
                  ))}
                </div>
              </Section>
            );
          })}
          <HelpSection name="Shortcuts" rows={rows.filter(r => r.section === "Shortcuts")} />
          <HelpSection name="Commands" rows={rows.filter(r => r.section === "Commands")} />
          {about ? <AboutSection /> : null}
        </div>
      </PanelSheet>
    </section>
  );
}

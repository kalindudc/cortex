// SettingsModal — the settings and help pane (Mod+, or the palette). One
// search field filters every setting, command and shortcut (lib/help.ts);
// settings change in place and persist in this window's localStorage.
// The ONLY renderer of the desktop's help registry.

import type { VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";

import { SETTINGS } from "../../state/settings.ts";
import { filterHelp, type HelpRow, helpRows } from "../../lib/help.ts";
import { IS_MAC } from "../../lib/keys.ts";
import { buildCommands } from "../palette/buildCommands.ts";
import { Icon } from "../Icon.tsx";
import { DialogFrame } from "./DialogFrame.tsx";

function Section({ title, rows }: { title: string; rows: readonly HelpRow[] }): VNode | null {
  if (rows.length === 0) return null;
  return (
    <section class="settings-section" aria-label={title}>
      <h3>{title}</h3>
      <dl class="help-rows">
        {rows.map(r => (
          <div class="help-row" key={r.id} data-help-id={r.id}>
            <dt>{r.title}</dt>
            <dd class="meta">{r.detail}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function SettingsModal({ close }: { close: () => void }): VNode {
  const query = useSignal("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  const rows = filterHelp(helpRows({ settings: SETTINGS, commands: buildCommands(), mac: IS_MAC }), query.value);
  const shown = new Set(rows.filter(r => r.section === "Settings").map(r => r.id));
  const settings = SETTINGS.filter(s => shown.has(s.key));

  return (
    <DialogFrame label="Settings and help" onClose={close}>
      <div class="modal settings-modal">
        <div class="row">
          <h2 class="grow">Settings and help</h2>
          <button type="button" class="btn-icon" onClick={close} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <input
          ref={inputRef}
          class="settings-search"
          type="search"
          aria-label="Search settings, commands and shortcuts"
          placeholder="Search settings, commands and shortcuts…"
          value={query.value}
          onInput={e => (query.value = (e.currentTarget as HTMLInputElement).value)}
        />
        {rows.length === 0 ? <p class="meta settings-empty">No setting, command or shortcut matches</p> : null}
        {settings.length > 0 ? (
          <section class="settings-section" aria-label="Settings">
            <h3>Settings</h3>
            {settings.map(s => {
              const current = s.current();
              const choice = s.choices.find(c => c.value === current);
              return (
                <div class="setting-row" key={s.key} data-setting={s.key}>
                  <label class="setting-label" for={`setting-${s.key}`}>
                    {s.label}
                    <span class="meta"> — {s.meaning}</span>
                  </label>
                  <div class="setting-control">
                    <select
                      id={`setting-${s.key}`}
                      value={current}
                      onChange={e => s.set((e.currentTarget as HTMLSelectElement).value)}
                    >
                      {s.choices.map(c => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      class="btn"
                      disabled={current === s.defaultValue}
                      aria-label={`Reset ${s.label} to its default`}
                      onClick={() => s.set(s.defaultValue)}
                    >
                      Default
                    </button>
                  </div>
                  {choice ? <p class="meta setting-help">{choice.help}</p> : null}
                </div>
              );
            })}
          </section>
        ) : null}
        <Section title="Commands" rows={rows.filter(r => r.section === "Commands")} />
        <Section title="Shortcuts" rows={rows.filter(r => r.section === "Shortcuts")} />
      </div>
    </DialogFrame>
  );
}

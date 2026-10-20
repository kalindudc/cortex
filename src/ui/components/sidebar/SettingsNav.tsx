// SettingsNav — the list column of the Settings view: the one search over
// settings, commands and shortcuts (settingsQuery, read by SettingsPanel)
// and a link to each section of the panel. The field takes focus on mount
// and on every openSettings() (settingsFocusRequest); the second, delayed
// focus wins over DialogFrame's initial focus when a narrow window shows
// this column inside the navigation drawer.

import type { JSX, VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";

import type { SettingSpec } from "../../state/settings.ts";
import { navigationOpen, settingsFocusRequest, settingsQuery } from "../../state/signals.ts";
import { SETTING_SECTIONS, sectionId } from "../panels/SettingsPanel.tsx";
import { Icon } from "../Icon.tsx";

type SectionName = SettingSpec["section"] | "Shortcuts" | "Commands" | "About";
const ICONS: Readonly<Record<SectionName, string>> = {
  Appearance: "monitor",
  "Task list": "list",
  Documents: "fileText",
  Notifications: "bell",
  Backup: "archive",
  Shortcuts: "keyboard",
  Commands: "search",
  About: "info",
};
const SECTIONS: readonly SectionName[] = [...SETTING_SECTIONS, "Shortcuts", "Commands", "About"];

function goTo(name: string): void {
  // On a narrow window the drawer covers the panel it scrolls.
  navigationOpen.value = false;
  document.getElementById(sectionId(name))?.scrollIntoView({ block: "start" });
}

export function SettingsNav(): VNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const request = settingsFocusRequest.value;
  useEffect(() => {
    inputRef.current?.focus();
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [request]);

  return (
    <div class="sidebar-body settings-nav">
      <div class="list-top">
        <div class="ws-search">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            type="search"
            aria-label="Search settings, commands and shortcuts"
            placeholder="Search settings, commands and shortcuts"
            value={settingsQuery.value}
            onInput={(e: JSX.TargetedInputEvent<HTMLInputElement>) => (settingsQuery.value = e.currentTarget.value)}
          />
        </div>
      </div>
      <nav class="settings-nav-list" aria-label="Settings sections">
        {SECTIONS.map(name => (
          <button type="button" class="settings-nav-item" key={name} onClick={() => goTo(name)}>
            <Icon name={ICONS[name]} />
            <span>{name}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// lib/help.ts — The desktop's help registry: every keyboard shortcut
// (SHORTCUTS), plus the rows the settings and help pane renders from the
// settings (state/settings.ts#SETTINGS), the palette's root commands
// (components/palette/buildCommands.ts) and the shortcuts. Search is a
// literal, case-insensitive substring over a row's whole text.

import type { Command } from "../components/palette/buildCommands.ts";
import type { SettingSpec } from "../state/settings.ts";
import { modeShortcutHint } from "./keys.ts";

export interface Shortcut {
  readonly id: string;
  readonly keys: (mac: boolean) => string;
  readonly description: string;
  readonly where: "anywhere" | "composer" | "forms" | "editor";
}

const chord = (key: string) => (mac: boolean) => `${mac ? "⌘" : "Ctrl"} + ${key}`;

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "palette-commands", keys: chord("P"), description: "Open the command palette", where: "anywhere" },
  { id: "palette-search", keys: chord("K"), description: "Search tasks in the palette", where: "anywhere" },
  { id: "post-update", keys: chord("/"), description: "Write an update on the task", where: "anywhere" },
  { id: "post-submit", keys: chord("Enter"), description: "Post the update", where: "composer" },
  { id: "mode-read", keys: mac => modeShortcutHint("read", mac), description: "Read the document", where: "anywhere" },
  { id: "mode-edit", keys: mac => modeShortcutHint("edit", mac), description: "Edit the document", where: "anywhere" },
  {
    id: "mode-split",
    keys: mac => modeShortcutHint("split", mac),
    description: "Edit beside the rendered document",
    where: "anywhere",
  },
  {
    id: "editor-save",
    keys: chord("S"),
    description: "Save the document being edited now",
    where: "editor",
  },
  {
    id: "ref-follow",
    keys: mac => `${mac ? "⌘" : "Ctrl"} + click`,
    description: "Follow an @id or #tag reference",
    where: "editor",
  },
  {
    id: "form-submit",
    keys: mac => `${chord("S")(mac)} or ${chord("Enter")(mac)}`,
    description: "Save the open form",
    where: "forms",
  },
  { id: "escape", keys: () => "Esc", description: "Close the palette, dialog or popover", where: "anywhere" },
  { id: "settings", keys: chord(","), description: "Open settings and help", where: "anywhere" },
  { id: "history-back", keys: chord("["), description: "Back to the task opened before", where: "anywhere" },
  { id: "history-forward", keys: chord("]"), description: "Forward to the next task opened", where: "anywhere" },
  {
    id: "focus",
    keys: () => "Tab / Shift + Tab",
    description: "Move focus between the task list and the document",
    where: "anywhere",
  },
];

const WHERE: Readonly<Record<Shortcut["where"], string>> = {
  anywhere: "anywhere",
  composer: "in the update composer",
  forms: "in a form",
  editor: "in the document editor",
};

export interface HelpRow {
  readonly section: "Settings" | "Commands" | "Shortcuts";
  readonly id: string;
  readonly title: string;
  readonly detail: string;
}

export function helpRows(input: {
  settings: readonly SettingSpec[];
  commands: readonly Command[];
  mac: boolean;
}): HelpRow[] {
  const settings = input.settings.map(
    (s): HelpRow => ({
      section: "Settings",
      id: s.key,
      title: s.label,
      detail: `${s.meaning}: ${s.choices.map(c => `${c.label} (${c.help})`).join(", ")}`,
    }),
  );
  const commands = input.commands.map(
    (c): HelpRow => ({ section: "Commands", id: c.id, title: c.label, detail: c.hint ?? "" }),
  );
  const shortcuts = SHORTCUTS.map(
    (s): HelpRow => ({
      section: "Shortcuts",
      id: s.id,
      title: s.description,
      detail: `${s.keys(input.mac)}, ${WHERE[s.where]}`,
    }),
  );
  return [...settings, ...commands, ...shortcuts];
}

/** Rows whose whole text contains `query` literally, ignoring case; an empty query keeps every row. */
export function filterHelp(rows: readonly HelpRow[], query: string): HelpRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...rows];
  return rows.filter(r => `${r.title} ${r.detail}`.toLowerCase().includes(needle));
}

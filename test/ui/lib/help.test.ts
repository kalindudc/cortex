// lib/help.ts — the desktop help registry the Settings panel renders.

import { describe, expect, test } from "bun:test";
import { buildCommands } from "../../../src/ui/components/palette/buildCommands.ts";
import { filterHelp, helpRows, SHORTCUTS } from "../../../src/ui/lib/help.ts";
import { SETTINGS } from "../../../src/ui/state/settings.ts";

const rows = (mac = true) => helpRows({ settings: SETTINGS, commands: buildCommands(), mac });

describe("helpRows", () => {
  test("every setting, root command and shortcut appears exactly once, in its section", () => {
    const all = rows();
    const ids = (section: string) => all.filter(r => r.section === section).map(r => r.id);
    expect(ids("Settings")).toEqual(SETTINGS.map(s => s.key));
    expect(ids("Commands")).toEqual(buildCommands().map(c => c.id));
    expect(ids("Shortcuts")).toEqual(SHORTCUTS.map(s => s.id));
    for (const section of ["Settings", "Commands", "Shortcuts"]) {
      expect(new Set(ids(section)).size).toBe(ids(section).length);
    }
  });

  test("the shortcuts the plan names are all listed", () => {
    expect(SHORTCUTS.map(s => s.id)).toEqual(
      expect.arrayContaining([
        "palette-commands",
        "palette-search",
        "post-update",
        "post-submit",
        "mode-read",
        "mode-edit",
        "mode-split",
        "form-submit",
        "escape",
        "settings",
        "history-back",
        "history-forward",
        "focus",
      ]),
    );
  });

  test("keys follow the platform", () => {
    const mac = rows(true).find(r => r.section === "Shortcuts" && r.id === "settings");
    const other = rows(false).find(r => r.section === "Shortcuts" && r.id === "settings");
    expect(mac?.detail).toContain("⌘ + ,");
    expect(other?.detail).toContain("Ctrl + ,");
  });

  test("shortcut rows carry their keys and where they work; command rows carry their hint", () => {
    const all = rows(true);
    const settings = all.find(r => r.section === "Shortcuts" && r.id === "settings");
    expect(settings?.title).toBe("Open settings");
    expect(settings?.keys).toBe("⌘ + ,");
    expect(settings?.where).toBe("anywhere");
    const command = all.find(r => r.section === "Commands" && r.id === "settings");
    expect(command?.title).toBe("Settings");
    expect(command?.keys).toBe(buildCommands().find(c => c.id === "settings")?.hint);
  });

  test("a submenu root shows as its label", () => {
    expect(rows().find(r => r.id === "sort-group")?.title).toBe("Sort and group…");
  });
});

describe("filterHelp", () => {
  test("an empty or blank query keeps everything", () => {
    const all = rows();
    expect(filterHelp(all, "")).toEqual(all);
    expect(filterHelp(all, "   ")).toEqual(all);
  });

  test("matching is a literal, case-insensitive substring over the whole row", () => {
    const all = rows();
    // A choice's help text (detail), not the title.
    expect(filterHelp(all, "NEWEST TASK").map(r => r.id)).toEqual(["direction"]);
    // Keys are part of the row.
    expect(filterHelp(all, "⌘ + [").map(r => r.id)).toEqual(["history-back"]);
    // Regex characters are literal.
    expect(filterHelp(all, "a.*z")).toEqual([]);
    expect(filterHelp(all, "settings").map(r => r.section)).toEqual(expect.arrayContaining(["Commands", "Shortcuts"]));
  });
});

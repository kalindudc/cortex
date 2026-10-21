// SettingsPanel — every setting in its section's card, then Shortcuts,
// Commands and About, all filtered by the one settings search; About reads
// GET /api/health and the author name. SettingsNav — the list column's
// search field (focused on mount and on each openSettings()) and the
// section links.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { HealthResponse } from "../../../../src/contracts.ts";

const health = mock((): Promise<HealthResponse> => Promise.reject(new Error("unset")));
// bun's mock.module is process-global: the canonical SidebarPane stub shape
// keeps a sibling test that triggers refresh.ts from reaching a missing method.
mock.module("../../../../src/ui/api/client.ts", () => ({
  api: {
    tasks: mock(() => Promise.resolve([])),
    lanes: mock(() => Promise.resolve([])),
    tags: mock(() => Promise.resolve([])),
    updates: mock(() => Promise.resolve([])),
    addLane: mock(() => Promise.resolve({})),
    addTag: mock(() => Promise.resolve({})),
    addTask: mock(() => Promise.resolve({})),
    moveLane: mock(() => Promise.resolve({})),
    editLane: mock(() => Promise.resolve({})),
    editTag: mock(() => Promise.resolve({})),
    delLane: mock(() => Promise.resolve()),
    delTag: mock(() => Promise.resolve()),
    delTask: mock(() => Promise.resolve()),
    versioned: { setStatus: mock(() => Promise.resolve({})), changeTags: mock(() => Promise.resolve({})) },
    editTask: mock(() => Promise.resolve({})),
    postUpd: mock(() => Promise.resolve({})),
    health,
  },
}));

import { act, fireEvent, render } from "@testing-library/preact";
import { SettingsPanel } from "../../../../src/ui/components/panels/SettingsPanel.tsx";
import { SettingsNav } from "../../../../src/ui/components/sidebar/SettingsNav.tsx";
import { SETTINGS } from "../../../../src/ui/state/settings.ts";
import { meAuthor, navigationOpen, settingsFocusRequest, settingsQuery } from "../../../../src/ui/state/signals.ts";
import { sheetBody } from "./sheet.ts";

const IDENTITY = {
  protocol: 1 as const,
  instanceId: "0f3a9c51d2e84b7a",
  databaseId: "db-1",
  databasePath: "/tmp/cortex-test/cortex.db",
  endpoint: { kind: "unix" as const, socketPath: "/tmp/cortex-test/cortex.sock" },
  pid: 4242,
};
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

const sections = (c: Element): string[] =>
  Array.from(c.querySelectorAll(".settings-panel section[aria-label]")).map(s => s.getAttribute("aria-label") ?? "");
const settingKeys = (c: Element): string[] =>
  Array.from(c.querySelectorAll("[data-setting]")).map(el => el.getAttribute("data-setting") ?? "");
const helpIds = (c: Element, section: string): string[] =>
  Array.from(c.querySelectorAll(`section[aria-label="${section}"] [data-help-id]`)).map(
    el => el.getAttribute("data-help-id") ?? "",
  );
const about = (c: Element): Record<string, string> =>
  Object.fromEntries(
    Array.from(c.querySelectorAll(".about-list > div")).map(row => [
      row.querySelector("dt")?.textContent ?? "",
      row.querySelector("dd")?.textContent ?? "",
    ]),
  );

describe("SettingsPanel", () => {
  beforeEach(() => {
    settingsQuery.value = "";
    meAuthor.value = "bb-thr_test";
    health.mockReset();
    health.mockImplementation(() => Promise.resolve({ ok: true, version: "9.8.7", identity: IDENTITY }));
  });
  afterEach(() => {
    settingsQuery.value = "";
  });

  test("the sections in order, each setting once in its section's card", async () => {
    const { container } = render(<SettingsPanel />);
    await act(tick);
    expect(sections(container)).toEqual([
      "Appearance",
      "Task list",
      "Documents",
      "Notifications",
      "Backup",
      "Shortcuts",
      "Commands",
      "About",
    ]);
    expect(settingKeys(container)).toEqual(SETTINGS.map(s => s.key));
    for (const s of SETTINGS) {
      expect(container.querySelector(`section[aria-label="${s.section}"] [data-setting="${s.key}"]`)).not.toBeNull();
    }
    expect(container.querySelector("#settings-task-list")?.getAttribute("aria-label")).toBe("Task list");
    expect(helpIds(container, "Shortcuts")).toContain("settings");
    expect(helpIds(container, "Commands")).toContain("settings");
    expect(container.querySelector(".settings-empty")).toBeNull();
  });

  test("every section and its settings lie on one dotted sheet", async () => {
    const { container } = render(<SettingsPanel />);
    await act(tick);
    const body = sheetBody(container);
    expect(body.querySelectorAll("section.settings-section")).toHaveLength(8);
    expect(Array.from(body.querySelectorAll("[data-setting]")).map(el => el.getAttribute("data-setting"))).toEqual(
      SETTINGS.map(s => s.key),
    );
    expect(body.querySelector("#setting-appearance")?.getAttribute("role")).toBe("radiogroup");
  });

  test('"group" leaves only the Group row and the sort-group command', async () => {
    settingsQuery.value = "group";
    const { container } = render(<SettingsPanel />);
    await act(tick);
    expect(settingKeys(container)).toEqual(["group"]);
    expect(helpIds(container, "Commands")).toEqual(["sort-group"]);
    expect(sections(container)).toEqual(["Task list", "Commands"]);
  });

  test("a query with no match shows the empty line and no section", async () => {
    settingsQuery.value = "no such words anywhere";
    const { container } = render(<SettingsPanel />);
    await act(tick);
    expect(container.querySelector(".settings-empty")?.textContent).toBe("No setting, command or shortcut matches");
    expect(sections(container)).toEqual([]);
  });

  test("a shortcut row shows its keys in a key cap and where it works", async () => {
    settingsQuery.value = "open settings";
    const { container } = render(<SettingsPanel />);
    await act(tick);
    const row = container.querySelector('section[aria-label="Shortcuts"] [data-help-id="settings"]');
    expect(row?.querySelector(".help-title")?.textContent).toBe("Open settings");
    expect(row?.querySelector(".kbd")?.textContent).toMatch(/ \+ ,$/);
    expect(row?.textContent).toContain("anywhere");
  });

  test("About shows the version, the database, the daemon and the author", async () => {
    const { container } = render(<SettingsPanel />);
    await act(tick);
    expect(health).toHaveBeenCalledTimes(1);
    expect(about(container)).toEqual({
      Version: "9.8.7",
      Database: "/tmp/cortex-test/cortex.db",
      Daemon: "0f3a9c51 · pid 4242",
      Author: "bb-thr_test",
    });
  });

  test("About says Unavailable when health fails, and when the daemon published no identity", async () => {
    health.mockImplementation(() => Promise.reject(new Error("down")));
    const failed = render(<SettingsPanel />);
    await act(tick);
    expect(about(failed.container)).toEqual({
      Version: "Unavailable",
      Database: "Unavailable",
      Daemon: "Unavailable",
      Author: "bb-thr_test",
    });
    failed.unmount();

    health.mockImplementation(() => Promise.resolve({ ok: true, version: "9.8.7" }));
    const bare = render(<SettingsPanel />);
    await act(tick);
    expect(about(bare.container)).toEqual({
      Version: "9.8.7",
      Database: "Unavailable",
      Daemon: "Unavailable",
      Author: "bb-thr_test",
    });
  });

  test("About stays during a search only when the query matches one of its labels", async () => {
    settingsQuery.value = "daemon";
    const { container } = render(<SettingsPanel />);
    await act(tick);
    expect(sections(container)).toEqual(["About"]);
    expect(container.querySelector(".settings-empty")).toBeNull();
    await act(() => {
      settingsQuery.value = "group";
    });
    expect(sections(container)).not.toContain("About");
  });
});

describe("SettingsNav", () => {
  beforeEach(() => {
    settingsQuery.value = "";
    navigationOpen.value = false;
  });
  afterEach(() => {
    settingsQuery.value = "";
    navigationOpen.value = false;
  });

  test("the search field is focused on mount and again on each focus request, and types into settingsQuery", async () => {
    const { container } = render(<SettingsNav />);
    const field = container.querySelector(
      'input[type="search"][aria-label="Search settings, commands and shortcuts"]',
    ) as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    field.blur();
    await act(() => {
      settingsFocusRequest.value = settingsFocusRequest.value + 1;
    });
    expect(document.activeElement).toBe(field);
    fireEvent.input(field, { target: { value: "density" } });
    expect(settingsQuery.value).toBe("density");
  });

  test("one link per section, in the panel's order; a link scrolls to its section and closes the drawer", async () => {
    const panel = render(<SettingsPanel />);
    const nav = render(<SettingsNav />);
    await act(tick);
    const links = Array.from(nav.container.querySelectorAll<HTMLButtonElement>(".settings-nav-item"));
    expect(links.map(b => b.textContent)).toEqual(sections(panel.container));
    const target = panel.container.querySelector("#settings-notifications") as HTMLElement;
    const scrolled = mock((_opts?: ScrollIntoViewOptions) => {});
    target.scrollIntoView = scrolled;
    navigationOpen.value = true;
    fireEvent.click(links.find(b => b.textContent === "Notifications") as HTMLButtonElement);
    expect(scrolled).toHaveBeenCalledWith({ block: "start" });
    expect(navigationOpen.value).toBe(false);
  });
});

// BackupPanel — "Back up now" sends the Keep backups setting as `rotate`
// (nothing at All), shows its result or failure, the last backup comes from
// the newest backup notification, and the copy buttons write the folder and
// the restore commands.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const backup = mock((_body?: { rotate?: number }) =>
  Promise.resolve({
    outPath: "/tmp/cfg/cortex/backups/cortex-host-2026.zip",
    bytes: 421880,
    stats: { lanes: 1, tags: 0, tasks: 2, updates: 1, task_tags: 0, notifications: 0, memory_exclusions: 0 },
    notification: null,
  }),
);
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
    backup: backup,
  },
}));

// Other test files replace errors.ts process-wide, so assert on this file's
// own showError rather than on the notifications it would push.
const showError = mock((_err: unknown) => {});
mock.module("../../../../src/ui/api/errors.ts", () => ({
  showError,
  tryApi: async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      showError(err);
      throw err;
    }
  },
}));

import { act, fireEvent, render } from "@testing-library/preact";
import { BackupPanel } from "../../../../src/ui/components/panels/BackupPanel.tsx";
import { notifications } from "../../../../src/ui/state/notifications.ts";
import { backupKeep } from "../../../../src/ui/state/settings.ts";
import type { Notification } from "../../../../src/ui/api/types.ts";
import { sheetBody } from "./sheet.ts";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

const notification = (over: Partial<Notification>): Notification => ({
  id: 1,
  task_id: null,
  author: null,
  status: "done",
  title: "Backup created",
  message: "",
  read: false,
  created: Date.now(),
  ...over,
});

function button(root: ParentNode, text: string): HTMLButtonElement {
  const b = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(x => x.textContent?.trim() === text);
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

const writeText = mock((_text: string) => Promise.resolve());

describe("BackupPanel", () => {
  beforeEach(() => {
    backup.mockClear();
    writeText.mockClear();
    backupKeep.value = 0;
    notifications.value = [];
    showError.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });
  afterEach(() => {
    backupKeep.value = 0;
    notifications.value = [];
  });

  test("Back up now sends no rotate at All, then shows where the backup went", async () => {
    const { container } = render(<BackupPanel />);
    const run = container.querySelector('button[aria-label="Back up now"]') as HTMLButtonElement;
    fireEvent.click(run);
    expect(container.querySelector('button[aria-label="Backing up"]')?.hasAttribute("disabled")).toBe(true);
    await act(flush);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(backup.mock.calls[0]?.[0]).toBeUndefined();
    const result = container.querySelector(".backup-result[role=status]");
    expect(result?.textContent).toContain("Backup saved to /tmp/cfg/cortex/backups/cortex-host-2026.zip");
    expect(result?.textContent).toContain("421,880 bytes · 2 tasks · 1 update");
    expect(container.querySelector(".backup-folder")?.textContent).toBe("/tmp/cfg/cortex/backups");
  });

  test("lies on one dotted sheet, with the Keep backups setting and the restore steps inside it", () => {
    const { container } = render(<BackupPanel />);
    const body = sheetBody(container);
    expect(body.querySelector(".panel-title")?.textContent).toBe("Backup");
    expect(body.querySelector('[data-setting="backup"] #setting-backup')).not.toBeNull();
    expect(body.querySelectorAll(".panel-callout li")).toHaveLength(3);
  });

  test("Keep backups at Last 10 sends { rotate: 10 }", async () => {
    const { container } = render(<BackupPanel />);
    const keep = container.querySelector("#setting-backup") as HTMLSelectElement;
    fireEvent.change(keep, { target: { value: "10" } });
    expect(backupKeep.value).toBe(10);
    fireEvent.click(container.querySelector('button[aria-label="Back up now"]') as HTMLButtonElement);
    await act(flush);
    expect(backup.mock.calls[0]?.[0]).toEqual({ rotate: 10 });
  });

  test("a failure says so and reports the error", async () => {
    backup.mockImplementationOnce(() => Promise.reject(new Error("zip is missing")));
    const { container } = render(<BackupPanel />);
    fireEvent.click(container.querySelector('button[aria-label="Back up now"]') as HTMLButtonElement);
    await act(flush);
    expect(container.querySelector(".backup-result")?.textContent).toContain("Backup failed");
    expect((showError.mock.calls[0]?.[0] as Error | undefined)?.message).toBe("zip is missing");
    expect(container.querySelector('button[aria-label="Back up now"]')?.hasAttribute("disabled")).toBe(false);
  });

  test("the last backup comes from the newest backup notification", () => {
    const now = Date.now();
    notifications.value = [
      notification({
        id: 1,
        message: "/old/backups/a.zip (1 bytes; 1 tasks, 1 updates)",
        created: now - 3 * 86_400_000,
      }),
      notification({ id: 2, title: "Restore completed", message: "/x.zip (…)", created: now }),
      notification({
        id: 3,
        message: "/cfg/cortex/backups/cortex-b.zip (10 bytes; 4 tasks, 9 updates)",
        created: now - 2 * 3_600_000,
      }),
    ];
    const { container } = render(<BackupPanel />);
    expect(container.querySelector(".backup-last")?.textContent).toBe("Last backup 2h ago");
    expect(container.querySelector(".backup-last-detail")?.textContent).toBe(
      "/cfg/cortex/backups/cortex-b.zip (10 bytes; 4 tasks, 9 updates)",
    );
    expect(container.querySelector(".backup-folder")?.textContent).toBe("/cfg/cortex/backups");
  });

  test("no backup yet: the folder is described and Copy path is disabled", () => {
    const { container } = render(<BackupPanel />);
    expect(container.querySelector(".backup-last")?.textContent).toBe("No backup yet");
    expect(container.querySelector(".backup-folder")?.textContent).toContain("cortex configuration directory");
    expect(button(container, "Copy path").disabled).toBe(true);
  });

  test("Copy path writes the folder and Copy commands writes the restore steps", async () => {
    notifications.value = [
      notification({ message: "/cfg/cortex/backups/cortex-b.zip (10 bytes; 4 tasks, 9 updates)" }),
    ];
    const { container } = render(<BackupPanel />);
    fireEvent.click(button(container, "Copy path"));
    await act(flush);
    expect(writeText.mock.calls[0]?.[0]).toBe("/cfg/cortex/backups");
    expect(button(container, "Copied")).toBeTruthy();
    fireEvent.click(button(container, "Copy commands"));
    await act(flush);
    expect(writeText.mock.calls[1]?.[0]).toBe("cortex stop\ncortex restore --dry-run <file>\ncortex restore <file>");
  });

  test("the restore steps say to quit the app, stop the daemon and restore", () => {
    const { container } = render(<BackupPanel />);
    const steps = Array.from(container.querySelectorAll(".panel-callout li")).map(li => li.textContent);
    expect(steps).toEqual([
      "Quit the cortex app.",
      "cortex stop",
      "cortex restore --dry-run <file> to preview, then cortex restore <file>",
    ]);
  });
});

// AgentsPanel — checks on open and shows each tool's state; Install runs the
// install, then checks again; Reset asks first (ModalRoot) and lists the
// folders it deletes; failures show in the panel and in the Inbox's errors.
// window.cortex.agents is a fake that records every action it is asked for.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Other test files replace errors.ts process-wide, so assert on this file's own showError.
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
import type { AgentsReply } from "../../../../src/desktop/agents.ts";
import type { AgentsResult, AgentsStatus } from "../../../../src/lib/agentTools.ts";
import { ModalRoot } from "../../../../src/ui/components/modals/ModalRoot.tsx";
import { AgentsPanel } from "../../../../src/ui/components/panels/AgentsPanel.tsx";
import { agentsBusy, agentsCheckError, agentsOutcome, agentsStatus } from "../../../../src/ui/state/agents.ts";
import { modal } from "../../../../src/ui/state/signals.ts";
import { sheetBody } from "./sheet.ts";

const SKILLS = "/home/you/.agents/skills";
const EXT = "/home/you/.pi/agent/extensions/cortex";
const BB_DIR = "/home/you/.config/cortex/bb-plugin";

function status(over: Partial<AgentsStatus> = {}): AgentsStatus {
  return {
    version: "0.2.0",
    skills: [
      { name: "cortex", dir: `${SKILLS}/cortex`, state: "installed", differs: [] },
      { name: "cortex-planner", dir: `${SKILLS}/cortex-planner`, state: "outdated", differs: ["SKILL.md"] },
    ],
    extensions: [{ name: "pi", dir: EXT, state: "missing", differs: ["index.ts", "memory-view.ts"] }],
    skipped: [],
    bb: { state: "installed", dir: BB_DIR, plugin: { status: "running", cortexPath: "/usr/local/bin/cortex" } },
    suggest: "install",
    ...over,
  };
}

const UP_TO_DATE = status({
  skills: [
    { name: "cortex", dir: `${SKILLS}/cortex`, state: "installed", differs: [] },
    { name: "cortex-planner", dir: `${SKILLS}/cortex-planner`, state: "installed", differs: [] },
  ],
  extensions: [{ name: "pi", dir: EXT, state: "installed", differs: [] }],
  suggest: "none",
});

const INSTALLED: AgentsResult = {
  skills: [
    { name: "cortex", dir: `${SKILLS}/cortex` },
    { name: "cortex-planner", dir: `${SKILLS}/cortex-planner` },
  ],
  extensions: [{ name: "pi", dir: EXT }],
  skipped: [],
  bb: { status: "unchanged", dir: BB_DIR, plugin: { status: "running" } },
};

let actions: string[] = [];
let replies: Record<string, AgentsReply[]> = {};

function reply(action: string, ...queue: AgentsReply[]): void {
  replies[action] = queue;
}

const w = window as unknown as { cortex?: unknown };
let previousBridge: unknown;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function button(root: ParentNode, label: string): HTMLButtonElement {
  const b =
    root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
    Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(x => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}

const badge = (root: ParentNode, tool: string): string | undefined =>
  root.querySelector(`[data-agent-tool="${tool}"] .agents-badge`)?.textContent ?? undefined;

describe("AgentsPanel", () => {
  beforeEach(() => {
    actions = [];
    replies = {};
    showError.mockClear();
    agentsStatus.value = null;
    agentsCheckError.value = null;
    agentsOutcome.value = null;
    agentsBusy.value = null;
    modal.value = null;
    previousBridge = w.cortex;
    w.cortex = {
      agents: async ({ action }: { action: string }): Promise<AgentsReply> => {
        actions.push(action);
        const next = replies[action]?.shift();
        if (!next) throw new Error(`no reply queued for ${action}`);
        return next;
      },
    };
  });
  afterEach(() => {
    w.cortex = previousBridge;
    modal.value = null;
    agentsBusy.value = null;
  });

  test("checks on open, then shows the summary and every tool's state", async () => {
    reply("status", { ok: true, action: "status", status: status() });
    const { container } = render(<AgentsPanel />);
    expect(container.querySelector(".agents-headline")?.textContent).toBe("Checking the agent tools…");
    await act(flush);
    expect(actions).toEqual(["status"]);
    expect(container.querySelector(".agents-headline")?.textContent).toBe("2 agent tools to install or update");
    expect(container.querySelector(".agents-detail")?.textContent).toBe(
      "Install writes the versions cortex 0.2.0 ships.",
    );
    expect(badge(container, "cortex")).toBe("Up to date");
    expect(badge(container, "cortex-planner")).toBe("Out of date");
    expect(container.querySelector('[data-agent-tool="cortex-planner"]')?.textContent).toContain(
      "1 file missing or different from this version",
    );
    expect(badge(container, "pi extension")).toBe("Not installed");
    expect(badge(container, "bb plugin")).toBe("Up to date");
    expect(container.querySelector('[data-agent-tool="bb plugin"]')?.textContent).toContain(
      "bb reports it running · runs cortex at /usr/local/bin/cortex",
    );
  });

  test("lies on one dotted sheet, with the summary, every tool and Reset inside it", async () => {
    reply("status", { ok: true, action: "status", status: status() });
    const { container } = render(<AgentsPanel />);
    await act(flush);
    const body = sheetBody(container);
    expect(body.querySelector(".panel-title")?.textContent).toBe("Agent tools");
    expect(body.querySelector(".agents-headline")?.textContent).toBe("2 agent tools to install or update");
    const tools = container.querySelectorAll("[data-agent-tool]");
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of Array.from(tools)) expect(body.contains(tool)).toBe(true);
    expect(body.querySelector(".agents-reset")).not.toBeNull();
  });

  test("up to date: the summary says which cortex they match", async () => {
    reply("status", { ok: true, action: "status", status: UP_TO_DATE });
    const { container } = render(<AgentsPanel />);
    await act(flush);
    expect(container.querySelector(".agents-headline")?.textContent).toBe("Every agent tool is up to date");
    expect(container.querySelector(".agents-detail")?.textContent).toBe("They match cortex 0.2.0.");
  });

  test("skipped pi and bb show their reasons, a foreign plugin suggests Reset", async () => {
    reply("status", {
      ok: true,
      action: "status",
      status: status({
        skills: UP_TO_DATE.skills,
        extensions: [],
        skipped: [{ name: "pi", reason: "pi not found (no `pi` on PATH, no pi agent dir)" }],
        bb: {
          state: "foreign",
          dir: BB_DIR,
          reason: "the bb plugin is installed from git:x; `cortex agents reset` replaces it",
        },
        suggest: "reset",
      }),
    });
    const { container } = render(<AgentsPanel />);
    await act(flush);
    expect(container.querySelector(".agents-headline")?.textContent).toBe("The bb plugin was installed another way");
    expect(badge(container, "pi extension")).toBe("Skipped");
    expect(container.querySelector('[data-agent-tool="pi extension"] code')?.textContent).toBe("pi");
    expect(badge(container, "bb plugin")).toBe("Installed another way");
    expect(container.querySelector('[data-agent-tool="bb plugin"] code')?.textContent).toBe("cortex agents reset");
  });

  test("Install runs the install, shows its outcome, then checks again", async () => {
    reply(
      "status",
      { ok: true, action: "status", status: status() },
      { ok: true, action: "status", status: UP_TO_DATE },
    );
    reply("install", { ok: true, action: "install", result: INSTALLED });
    const { container } = render(<AgentsPanel />);
    await act(flush);
    fireEvent.click(button(container, "Install"));
    expect(button(container, "Installing").disabled).toBe(true);
    expect(button(container, "Check again").disabled).toBe(true);
    expect(container.querySelector(".agents-outcome[role=status]")?.textContent).toContain("Installing.");
    await act(flush);
    expect(actions).toEqual(["status", "install", "status"]);
    expect(container.querySelector(".agents-outcome-info")?.textContent).toBe(
      "Installed 2 skills and the pi extension; bb plugin up to date",
    );
    expect(container.querySelector(".agents-headline")?.textContent).toBe("Every agent tool is up to date");
    expect(showError).not.toHaveBeenCalled();
  });

  test("a failed bb plugin is an error outcome and reaches the Inbox", async () => {
    reply("status", { ok: true, action: "status", status: status() }, { ok: true, action: "status", status: status() });
    reply("install", {
      ok: true,
      action: "install",
      result: { ...INSTALLED, bb: { status: "failed", dir: BB_DIR, reason: "npm not found" } },
    });
    const { container } = render(<AgentsPanel />);
    await act(flush);
    fireEvent.click(button(container, "Install"));
    await act(flush);
    expect(container.querySelector(".agents-outcome-error")?.textContent).toBe(
      "Installed 2 skills and the pi extension; the bb plugin failed: npm not found",
    );
    expect((showError.mock.calls[0]?.[0] as Error | undefined)?.message).toContain("npm not found");
  });

  test("a check that fails says why, and Check again retries", async () => {
    reply(
      "status",
      { ok: false, error: "cortex agents status --json failed (exit 1)" },
      {
        ok: true,
        action: "status",
        status: UP_TO_DATE,
      },
    );
    const { container } = render(<AgentsPanel />);
    await act(flush);
    expect(container.querySelector(".agents-headline")?.textContent).toBe("Could not check the agent tools");
    expect(container.querySelector(".agents-detail")?.textContent).toBe("cortex agents status --json failed (exit 1)");
    expect(button(container, "Reset…").disabled).toBe(true);
    fireEvent.click(button(container, "Check again"));
    await act(flush);
    expect(container.querySelector(".agents-headline")?.textContent).toBe("Every agent tool is up to date");
  });

  test("Reset asks first, lists the folders it deletes, and runs only once confirmed", async () => {
    reply(
      "status",
      { ok: true, action: "status", status: status() },
      { ok: true, action: "status", status: UP_TO_DATE },
    );
    reply("reset", { ok: true, action: "reset", result: INSTALLED });
    const panel = render(<AgentsPanel />);
    await act(flush);
    fireEvent.click(button(panel.container, "Reset…"));
    const dialog = render(<ModalRoot />);
    const frame = dialog.container.querySelector('dialog[aria-label="Reset agent tools"]');
    if (!frame) throw new Error("expected the reset dialog");
    expect(Array.from(frame.querySelectorAll(".agents-reset-dirs li")).map(li => li.textContent)).toEqual([
      `${SKILLS}/cortex`,
      `${SKILLS}/cortex-planner`,
      EXT,
      BB_DIR,
    ]);
    expect(frame.textContent).toContain("resets its settings");

    fireEvent.click(button(frame, "Cancel"));
    await act(flush);
    expect(modal.value).toBeNull();
    expect(actions).toEqual(["status"]);

    act(() => {
      modal.value = { kind: "confirm-agents-reset" };
    });
    const again = dialog.container.querySelector('dialog[aria-label="Reset agent tools"]');
    fireEvent.click(button(again as Element, "Reset"));
    await act(flush);
    expect(modal.value).toBeNull();
    expect(actions).toEqual(["status", "reset", "status"]);
    expect(panel.container.querySelector(".agents-outcome-info")?.textContent).toBe(
      "Installed 2 skills and the pi extension; bb plugin up to date",
    );
  });

  test("without bb the reset dialog lists no plugin folder and says nothing about its settings", async () => {
    reply("status", {
      ok: true,
      action: "status",
      status: status({ bb: { state: "skipped", reason: "bb not found" } }),
    });
    render(<AgentsPanel />);
    await act(flush);
    act(() => {
      modal.value = { kind: "confirm-agents-reset" };
    });
    const dialog = render(<ModalRoot />);
    const frame = dialog.container.querySelector('dialog[aria-label="Reset agent tools"]') as Element;
    expect(frame.querySelectorAll(".agents-reset-dirs li").length).toBe(3);
    expect(frame.textContent).not.toContain("resets its settings");
  });
});

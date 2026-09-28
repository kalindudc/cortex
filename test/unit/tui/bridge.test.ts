// The TUI's bridges to other programs (plan @400 Task 10 B, N5/N20/N21):
// `:preview` (the exact current draft in the browser, through the SAME
// daemon's loopback dashboard) and the terminal handoff for external
// programs. Every seam is a fake: no daemon, no browser, no process.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpError } from "../../../src/api.ts";
import type {
  CortexClient,
  DaemonIdentity,
  PreviewCreated,
  PreviewRequest,
  WorkspaceSnapshot,
} from "../../../src/contracts.ts";
import type { Task, Update } from "../../../src/store.ts";
import { type BridgeDeps, openRichPreview, resumeTask, withExternalProgram } from "../../../src/tui/bridge.ts";
import { CommandError, COMMANDS, parseCommand } from "../../../src/tui/commands.ts";
import { DEFAULT_KEYS } from "../../../src/tui/keys.ts";
import { openPreferences } from "../../../src/tui/preferences.ts";
import { TuiSession } from "../../../src/tui/session.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
const IDENTITY: DaemonIdentity = {
  protocol: 1,
  instanceId: "inst-bridge",
  databaseId: "0b6a2f4e-0c1d-4e5f-8a9b-1c2d3e4f5a6b",
  databasePath: "/tmp/bridge.db",
  endpoint: { kind: "unix", socketPath: "/tmp/bridge.sock" },
  pid: 4242,
  capabilities: ["control.shutdown", "control.web", "control.preview"],
};

const task = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  lane: "inbox",
  title: `Task ${id}`,
  body: `saved body ${id}`,
  status: "open",
  priority: null,
  created: 1,
  updated: 1,
  tags: [],
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tui-bridge-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type Harness = { session: TuiSession; writes: unknown[] };

function harness(identity: DaemonIdentity = IDENTITY, tasks: Task[] = [task(1), task(2)]): Harness {
  const writes: unknown[] = [];
  const snapshot: WorkspaceSnapshot = { identity, cursor: "e:1", tasks, lanes: [], tags: [], notifications: [] };
  const versions = { entity: "e", title: "t", body: "b", priority: "p", lane: "l", status: "s" };
  const client = {
    workspace: async () => snapshot,
    taskState: async (id: number) => ({
      task: tasks.find(t => t.id === id),
      updates: [],
      versions,
      cursor: "e:1",
    }),
    versioned: new Proxy(
      {},
      {
        get:
          (_target, name) =>
          async (...args: unknown[]) => {
            writes.push({ name, args });
            throw new Error("a preview must never write");
          },
      },
    ),
  } as unknown as CortexClient;
  const session = new TuiSession({
    client,
    identity,
    keys: DEFAULT_KEYS,
    preferences: openPreferences(path.join(dir, "tui", "default.state.json")),
    schedule: () => () => {}, // no autosave: an edited draft stays unsaved
  });
  session.applySnapshot(snapshot);
  return { session, writes };
}

type Calls = {
  enable: string[];
  create: { identity: DaemonIdentity; request: PreviewRequest }[];
  launched: (readonly string[])[];
};

function fakes(over: Partial<BridgeDeps> = {}): { deps: Partial<BridgeDeps>; calls: Calls } {
  const calls: Calls = { enable: [], create: [], launched: [] };
  const deps: Partial<BridgeDeps> = {
    enableWeb: async identity => {
      calls.enable.push(identity.instanceId);
      return { ...identity, webUrl: "http://cortex.localhost:7777" };
    },
    createPreview: async (identity, request) => {
      calls.create.push({ identity, request });
      const created: PreviewCreated = {
        token: TOKEN,
        path: `/preview/${TOKEN}`,
        expiresAt: new Date(Date.UTC(2026, 0, 2, 3, 14)).toISOString(),
        bytes: 42,
      };
      return created;
    },
    browserCommand: url => ({ argv: ["open", url] }),
    launch: argv => {
      calls.launched.push(argv);
      return { exited: Promise.resolve(0) };
    },
    ...over,
  };
  return { deps, calls };
}

const lastMessage = (session: TuiSession): string => session.messages.at(-1)?.text ?? "";

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a rejection");
}

describe("openRichPreview (:preview)", () => {
  test("enables the SAME daemon's dashboard, sends the EXACT unsaved draft, opens the browser by argv", async () => {
    const { session, writes } = harness();
    session.select(1);
    const doc = await session.openDocument(1);
    const unsaved = "# Unsaved\r\n\n\ttyped but not saved \u{1F600}\n```mermaid\ngraph TD; A-->B;\n```\n";
    doc?.draft?.set("body", unsaved);
    doc?.draft?.set("title", "Retitled, unsaved");
    const { deps, calls } = fakes();
    await openRichPreview(session, deps);
    expect(calls.enable).toEqual([IDENTITY.instanceId]);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]?.identity.instanceId).toBe(IDENTITY.instanceId);
    expect(calls.create[0]?.request).toEqual({
      taskId: 1,
      title: "Retitled, unsaved",
      source: unsaved,
      unsaved: true,
    });
    const url = `http://cortex.localhost:7777/preview/${TOKEN}`;
    expect(calls.launched).toEqual([["open", url]]);
    // The URL is in :messages (the browser may not open), with what was sent.
    const reported = session.messages.map(m => m.text).join("\n");
    expect(reported).toContain(url);
    expect(reported).toContain("@1");
    expect(reported).toContain("unsaved");
    // A preview never writes: no versioned write was attempted.
    expect(writes).toEqual([]);
    expect(session.documentOf(1)?.draft?.text("body")).toBe(unsaved);
  });

  test("a running dashboard is reused (no enable-web request); saved text is sent as saved", async () => {
    const { session } = harness({ ...IDENTITY, webUrl: "http://cortex.localhost:7788" });
    session.select(2);
    const { deps, calls } = fakes();
    await openRichPreview(session, deps);
    expect(calls.enable).toEqual([]);
    expect(calls.create[0]?.request).toEqual({ taskId: 2, title: "Task 2", source: "saved body 2", unsaved: false });
    expect(calls.launched).toEqual([["open", `http://cortex.localhost:7788/preview/${TOKEN}`]]);
    expect(session.messages.map(m => m.text).join("\n")).toContain("saved text");
  });

  test("an empty body previews as an empty source", async () => {
    const { session } = harness(IDENTITY, [task(1, { body: null })]);
    session.select(1);
    const { deps, calls } = fakes();
    await openRichPreview(session, deps);
    expect(calls.create[0]?.request.source).toBe("");
  });

  test("no selected task: an explicit error and nothing is sent", async () => {
    const { session } = harness(IDENTITY, []);
    const { deps, calls } = fakes();
    const err = await rejection(openRichPreview(session, deps));
    expect(err).toBeInstanceOf(CommandError);
    expect(err.message).toContain("No task selected");
    expect(calls).toEqual({ enable: [], create: [], launched: [] });
  });

  test("a daemon without the preview capability is named before any request", async () => {
    const { session } = harness({ ...IDENTITY, capabilities: ["control.shutdown", "control.web"] });
    session.select(1);
    const { deps, calls } = fakes();
    const err = await rejection(openRichPreview(session, deps));
    expect(err).toBeInstanceOf(CommandError);
    expect(err.message).toContain("pid 4242");
    expect(err.message).toContain("restart");
    expect(calls).toEqual({ enable: [], create: [], launched: [] });
  });

  test("the daemon's limit error is explicit and nothing is opened", async () => {
    const { session } = harness();
    session.select(1);
    const { deps, calls } = fakes({
      createPreview: async () => {
        throw new HttpError(
          413,
          "The preview is 1.5 MiB; one preview may hold at most 1 MiB (its title and source together)",
          "preview_too_large",
        );
      },
    });
    const err = await rejection(openRichPreview(session, deps));
    expect(err).toBeInstanceOf(CommandError);
    expect(err.message).toContain("at most 1 MiB");
    expect(calls.launched).toEqual([]);
  });

  test("a dashboard that cannot start is explicit and nothing is created", async () => {
    const { session } = harness();
    session.select(1);
    const { deps, calls } = fakes({
      enableWeb: async () => {
        throw new HttpError(409, "port 7777 is in use", "web_unavailable");
      },
    });
    const err = await rejection(openRichPreview(session, deps));
    expect(err).toBeInstanceOf(CommandError);
    expect(err.message).toContain("port 7777 is in use");
    expect(calls.create).toEqual([]);
  });

  test("an unsafe dashboard URL is never launched", async () => {
    for (const webUrl of ["file:///tmp", "javascript:alert(1)", "http://cortex.localhost:7777\u001b]8;;x\u0007"]) {
      const { session } = harness({ ...IDENTITY, webUrl });
      session.select(1);
      const { deps, calls } = fakes();
      const err = await rejection(openRichPreview(session, deps));
      expect(err).toBeInstanceOf(CommandError);
      expect(calls.launched).toEqual([]);
    }
  });

  test("a browser that cannot open is reported; the URL stays in :messages", async () => {
    const { session } = harness();
    session.select(1);
    const url = `http://cortex.localhost:7777/preview/${TOKEN}`;
    const missing = fakes({ browserCommand: () => ({ problem: "xdg-open not on PATH" }) });
    await openRichPreview(session, missing.deps);
    expect(missing.calls.launched).toEqual([]);
    expect(lastMessage(session)).toContain("xdg-open not on PATH");
    expect(session.messages.map(m => m.text).join("\n")).toContain(url);

    let exit: (code: number) => void = () => {};
    const failing = fakes({
      launch: argv => {
        failing.calls.launched.push(argv);
        return { exited: new Promise<number>(resolve => (exit = resolve)) };
      },
    });
    await openRichPreview(session, failing.deps);
    exit(1);
    await Bun.sleep(0);
    expect(lastMessage(session)).toContain("exited with 1");
    expect(lastMessage(session)).toContain(url);
  });

  test(":preview is a registered command without arguments, and the reader's Mermaid hint names it", async () => {
    const parsed = parseCommand("preview", COMMANDS);
    expect(parsed.spec.name).toBe("preview");
    expect(parsed.spec.description).toContain("10 minutes");
    const { session } = harness();
    session.select(1);
    await expect(async () => parsed.spec.run(session, "now")).toThrow(":preview takes no argument");
    const reader = fs.readFileSync(path.join(import.meta.dir, "../../../src/tui/reader.ts"), "utf8");
    expect(reader).toContain('"rich preview: :preview"');
  });
});

describe("withExternalProgram (terminal handoff)", () => {
  test("hands the terminal over, runs the argv, takes it back and returns the exit code", async () => {
    const { session } = harness();
    const order: string[] = [];
    session.setTerminalHandoff(async run => {
      order.push("restore");
      try {
        return await run();
      } finally {
        order.push("reclaim");
      }
    });
    const code = await withExternalProgram(session, ["pi", "--resume", "a b; rm -rf ~"], {
      run: async argv => {
        order.push(`run ${JSON.stringify(argv)}`);
        return 3;
      },
    });
    expect(code).toBe(3);
    // The argv stays an argv: no element was joined or re-split through a shell.
    expect(order).toEqual(["restore", 'run ["pi","--resume","a b; rm -rf ~"]', "reclaim"]);
  });

  test("a program that cannot start is an explicit error after the terminal came back", async () => {
    const { session } = harness();
    const order: string[] = [];
    session.setTerminalHandoff(async run => {
      order.push("restore");
      try {
        return await run();
      } finally {
        order.push("reclaim");
      }
    });
    const err = await rejection(
      withExternalProgram(session, ["no-such-program"], {
        run: async () => {
          throw new Error("Executable not found in $PATH");
        },
      }),
    );
    expect(err).toBeInstanceOf(CommandError);
    expect(err.message).toContain("no-such-program");
    expect(err.message).toContain("Executable not found");
    expect(order).toEqual(["restore", "reclaim"]);
  });

  test("without a shell, or without a program, nothing runs", async () => {
    const { session } = harness();
    let ran = 0;
    const run = async (): Promise<number> => {
      ran++;
      return 0;
    };
    expect(await rejection(withExternalProgram(session, ["vim"], { run }))).toBeInstanceOf(CommandError);
    session.setTerminalHandoff(async inner => inner());
    for (const argv of [[], [""]] as string[][]) {
      expect(await rejection(withExternalProgram(session, argv, { run }))).toBeInstanceOf(CommandError);
    }
    expect(ran).toBe(0);
  });
});

describe(":resume (P10): the existing cortex resume flow on the handed-over terminal", () => {
  const PI = "pi-0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  const note = (id: number, author: string): Update => ({
    id,
    task_id: 1,
    author,
    summary: `note ${id}`,
    body: null,
    severity: "progress",
    created: id,
  });
  function withUpdates(updates: Update[]) {
    const h = harness();
    const reads: number[] = [];
    Object.assign(h.session.client, {
      updates: async (id: number) => {
        reads.push(id);
        return updates;
      },
    });
    const order: string[] = [];
    h.session.setTerminalHandoff(async run => {
      order.push("restore");
      try {
        return await run();
      } finally {
        order.push("reclaim");
      }
    });
    return { ...h, reads, order };
  }

  test("hands the terminal to `cortex resume <id>` (this binary, an argv), takes it back and reports how it exited", async () => {
    const h = withUpdates([note(1, "alice"), note(2, PI)]);
    const code = await resumeTask(h.session, 1, {
      command: ["/opt/cortex/bin/cortex"],
      run: async argv => {
        h.order.push(JSON.stringify(argv));
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(h.reads).toEqual([1]);
    expect(h.order).toEqual(["restore", '["/opt/cortex/bin/cortex","resume","1"]', "reclaim"]);
    expect(h.session.status?.text).toContain("Back from cortex resume @1");
    const failed = await resumeTask(h.session, 1, { command: ["bun", "src/cli.ts"], run: async () => 130 });
    expect(failed).toBe(130);
    expect(h.session.status?.level).toBe("warn");
    expect(h.session.status?.text).toContain("cortex resume @1 exited with status 130");
  });

  test("without a resumable pi session nothing runs and the terminal is never handed over", async () => {
    const h = withUpdates([
      note(1, "alice"),
      note(2, "pi-not-a-uuid"),
      note(3, "claude-0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"),
    ]);
    let ran = 0;
    const err = await rejection(
      resumeTask(h.session, 1, {
        run: async () => {
          ran++;
          return 0;
        },
      }),
    );
    expect(err).toBeInstanceOf(CommandError);
    expect(err.message).toContain("No pi session to resume on @1");
    expect(ran).toBe(0);
    expect(h.order).toEqual([]);
  });

  test(":resume is in the registry and acts on the current task", async () => {
    expect(parseCommand("resume", COMMANDS).spec.name).toBe("resume");
    const h = withUpdates([]);
    await h.session.execute("resume");
    expect(h.reads).toEqual([1]);
    expect(h.session.status?.text).toContain("No pi session to resume on @1");
  });
});

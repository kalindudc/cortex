// The TUI's bridges to other programs (plan @400 Task 10 B, N5/N20/N21):
// the terminal handoff for external programs and `:resume`. Every seam is a
// fake: no daemon, no process.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CortexClient, DaemonIdentity, WorkspaceSnapshot } from "../../../src/contracts.ts";
import type { Task, Update } from "../../../src/store.ts";
import { resumeTask, withExternalProgram } from "../../../src/tui/bridge.ts";
import { CommandError, COMMANDS, parseCommand } from "../../../src/tui/commands.ts";
import { DEFAULT_KEYS } from "../../../src/tui/keys.ts";
import { openPreferences } from "../../../src/tui/preferences.ts";
import { TuiSession } from "../../../src/tui/session.ts";

const IDENTITY: DaemonIdentity = {
  protocol: 1,
  instanceId: "inst-bridge",
  databaseId: "0b6a2f4e-0c1d-4e5f-8a9b-1c2d3e4f5a6b",
  databasePath: "/tmp/bridge.db",
  endpoint: { kind: "unix", socketPath: "/tmp/bridge.sock" },
  pid: 4242,
  capabilities: ["control.shutdown"],
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
            throw new Error("a bridge must never write");
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

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a rejection");
}

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
    expect(err.message).toContain("No resumable session on @1");
    expect(ran).toBe(0);
    expect(h.order).toEqual([]);
  });

  test(":resume is in the registry and acts on the current task", async () => {
    expect(parseCommand("resume", COMMANDS).spec.name).toBe("resume");
    const h = withUpdates([]);
    await h.session.execute("resume");
    expect(h.reads).toEqual([1]);
    expect(h.session.status?.text).toContain("No resumable session on @1");
  });
});

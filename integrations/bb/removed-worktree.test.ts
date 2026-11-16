import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { expect, test, vi } from "vitest";
import { createCortexState } from "./state";
import type { CortexRunner } from "./cli";
test("removed worktrees stop refreshing and log once, but can warm again at a new path", async () => {
  vi.useFakeTimers();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-removed-"));
  let cwd = path.join(root, "checkout");
  fs.mkdirSync(cwd);
  const host = createFakePluginHost({ pluginId: "cortex", sdk: {
    threads: { get: async () => makeThreadResponse({ id: "thr_aaaaaaaa", projectId: "project", environmentId: "environment" }) },
    environments: { get: async () => ({ id: "environment", path: cwd, hostId: "host" }) as never },
    system: { config: async () => ({ primaryHostId: "host" }) as never },
  } });
  const run = vi.fn(async (_args, schema) => schema.parse({ lane: "test", primer: "primer", primerIds: [] }));
  const state = createCortexState(host.bb, { binary: "fake", run, text: async () => { throw new Error("Unexpected text read"); } } as CortexRunner);
  try {
    await state.warmProject("thr_aaaaaaaa");
    fs.rmSync(cwd, { recursive: true });
    await state.refreshAll(); await vi.runAllTimersAsync();
    await state.refreshAll(); await vi.runAllTimersAsync();
    await state.warmProject("thr_aaaaaaaa");
    expect(run).toHaveBeenCalledTimes(1);
    expect(host.harness.inspection.logEntries.filter(row => row.message.includes("directory is gone"))).toHaveLength(1);
    cwd = path.join(root, "new-checkout"); fs.mkdirSync(cwd);
    await state.warmProject("thr_aaaaaaaa");
    expect(run).toHaveBeenCalledTimes(2);
  } finally { await host.harness.lifecycle.dispose(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); }
});

import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, test, vi } from "vitest";
import type { CortexRunner } from "./cli";
import type { Knowledge, Workstream } from "./workstream-contract";
import { createWorkstreams } from "./workstreams";
import { workstreamConfiguration } from "./workstream-agents";

const T = "thr_aaaaaaaa",
  P = "thr_bbbbbbbb",
  A = "ws_primary",
  B = "ws_granted",
  C = "ws_unrelated";
const at = "2026-01-01T00:00:00.000Z";
const actor = { id: "you", type: "human" as const };
const applicability = { environment: { mode: "not-applicable" as const }, host: { mode: "not-applicable" as const } };
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of disposers.splice(0)) await dispose();
});
function setup(child = false) {
  const primary: Workstream = {
    id: A,
    name: "Primary",
    description: "",
    revision: 1,
    archived: false,
    actor,
    createdAt: at,
    updatedAt: at,
  };
  let granted: Knowledge = {
    id: "kn_granted",
    workstreamId: B,
    subject: "safety",
    title: "Granted Rule",
    text: "Granted Rule B must not be withdrawn silently.",
    kind: "directive",
    state: "approved",
    facet: "orientation",
    applicability,
    sources: [{ ref: "manual", authorType: "human", observedAt: at }],
    revision: 1,
    actor,
    createdAt: at,
    updatedAt: at,
    expiresAt: null,
    approval: { actor, at },
    supersedes: [],
    supersededBy: null,
    conflicts: [],
  };
  const thread = makeThreadResponse({
    id: T,
    sectionId: child ? null : "sec_one",
    parentThreadId: child ? P : null,
    environmentId: "env_test",
  });
  let beforeGrantReturn = async () => {};
  let beforePrimaryReturn = async () => {};
  const runner: CortexRunner = {
    binary: "fake",
    async run(args, schema) {
      if (args[1] === "read") {
        const snapshot = structuredClone(primary);
        await beforePrimaryReturn();
        return schema.parse({ workstream: snapshot, entries: [], notices: [], applicability, topic: null });
      }
      if (args[1] === "entry") {
        const snapshot = structuredClone(granted);
        await beforeGrantReturn();
        return schema.parse(snapshot);
      }
      throw new Error(`Unexpected CLI ${args.join(" ")}`);
    },
    async text() {
      throw new Error("No legacy fallback");
    },
  };
  const host = createFakePluginHost({
    pluginId: "cortex",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          threadId === T ? thread : makeThreadResponse({ id: P, sectionId: "sec_one", environmentId: "env_test" }),
      },
      environments: { get: async () => ({ id: "env_test", name: "sandbox", hostId: "host_test", path: "/sandbox" }) },
    },
  });
  disposers.push(() => host.harness.lifecycle.dispose());
  const service = createWorkstreams(host.bb, runner, { userAuthor: "you", widgetDefault: () => true });
  service.store.setSection("sec_one", 0, {
    workstreamId: A,
    topic: null,
    budgetTokens: 1000,
    requiredKnowledgeIds: [],
    applicability,
  });
  service.store.setGrant(T, 0, "knowledge", granted.id, true, actor);
  const config = makePluginAgentConfigurationContext({
    thread: { id: T, parentThreadId: thread.parentThreadId, sourceThreadId: thread.sourceThreadId },
    project: { id: thread.projectId },
    environment: { id: "env_test" },
    host: { id: "host_test" },
  });
  return {
    ...host,
    service,
    config,
    dispatch: () =>
      service.predispatch(
        makeMessageDispatchHookContext({
          thread,
          project: { id: thread.projectId },
          environment: { id: "env_test" },
          host: { id: "host_test" },
        }),
      ),
    onGrantRead: (f: () => Promise<void>) => {
      beforeGrantReturn = f;
    },
    onPrimaryRead: (f: () => Promise<void>) => {
      beforePrimaryReturn = f;
    },
    archiveGrant: () => {
      granted = { ...granted, state: "archived", revision: 2 };
    },
    expires: (date: string) => {
      granted = { ...granted, expiresAt: date };
    },
    withdraw: () => service.store.setGrant(T, service.store.thread(T).revision, "knowledge", granted.id, false, actor),
    configuredText: () => workstreamConfiguration(service, config, "read")?.instructions ?? "",
    grantText: () => granted.text,
  };
}

test.each([A, B, C])("canonical mutation during grant snapshot read is scoped: %s", async target => {
  const s = setup();
  await s.service.context(T);
  s.harness.realtimeSignals.length = 0;
  s.onGrantRead(async () => {
    if (target === B) s.archiveGrant();
    s.service.invalidateScope({ workstreamId: target });
  });
  const decision = await s.dispatch();
  expect(decision.action).toBe(target === C ? "proceed" : "reject");
  if (target !== C) {
    expect(s.service.peek(T)).toBeUndefined();
    expect(s.service.prepared(s.config)).toBeNull();
    expect(s.configuredText()).not.toContain(s.grantText());
  } else expect(s.service.prepared(s.config)?.entries.some(e => e.knowledge.workstreamId === B)).toBe(true);
  expect(s.harness.realtimeSignals.every(e => e.payload !== null)).toBe(true);
});

test("unknown grant workstream mutation before its async read starts invalidates the eventual dependency", async () => {
  const s = setup();
  s.onPrimaryRead(async () => {
    s.service.invalidateScope({ workstreamId: B }, false);
  });
  expect((await s.dispatch()).action).toBe("reject");
  expect(s.service.prepared(s.config)).toBeNull();
  expect(s.configuredText()).not.toContain(s.grantText());
});

test("already admitted grant dependencies survive a preview refresh that no longer includes the Rule", async () => {
  const s = setup();
  expect((await s.dispatch()).action).toBe("proceed");
  s.archiveGrant();
  expect((await s.service.context(T)).entries).toEqual([]);
  s.service.invalidateScope({ workstreamId: B }, false);
  expect(s.service.prepared(s.config)).toBeNull();
  expect(s.configuredText()).not.toContain(s.grantText());
});

test("child inherited primary scope rejects a granted-workstream mutation during read", async () => {
  const s = setup(true);
  s.onGrantRead(async () => {
    s.archiveGrant();
    s.service.invalidateScope({ workstreamId: B }, false);
  });
  expect((await s.dispatch()).action).toBe("reject");
  expect(s.service.prepared(s.config)).toBeNull();
});

test("grant removal during a read is a revision change, even before a separate invalidation signal", async () => {
  const s = setup();
  s.onGrantRead(async () => {
    s.withdraw();
  });
  expect((await s.dispatch()).action).toBe("reject");
  expect(s.service.prepared(s.config)).toBeNull();
});

test("grant removal after admission cannot prepare old context", async () => {
  const s = setup();
  expect((await s.dispatch()).action).toBe("proceed");
  s.withdraw();
  expect(s.service.prepared(s.config)).toBeNull();
  expect(s.configuredText()).not.toContain(s.grantText());
});

test("an admitted grant expires before configure even within the preparation lifetime", async () => {
  const s = setup();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(at));
  s.expires(new Date(Date.now() + 1000).toISOString());
  expect((await s.dispatch()).action).toBe("proceed");
  vi.setSystemTime(Date.now() + 1001);
  expect(s.service.prepared(s.config)).toBeNull();
  expect(s.configuredText()).not.toContain(s.grantText());
});

test("a grant expiring during the read is withheld from the admitted text", async () => {
  const s = setup();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(at));
  s.expires(new Date(Date.now() + 1000).toISOString());
  s.onGrantRead(async () => {
    vi.setSystemTime(Date.now() + 1001);
  });
  expect((await s.dispatch()).action).toBe("proceed");
  expect(s.service.prepared(s.config)?.entries).toEqual([]);
  expect(s.configuredText()).not.toContain(s.grantText());
});

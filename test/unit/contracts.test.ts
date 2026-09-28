import { describe, expect, expectTypeOf, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import * as contracts from "../../src/contracts.ts";
import type {
  ApiClient,
  BlockedTransition,
  CortexClient,
  DaemonIdentity,
  Endpoint,
  LaneStateSnapshot,
  LiveEvent,
  NotificationChange,
  PostUpdateResult,
  ReadyPayload,
  ResourceScope,
  ResyncPayload,
  TagStateSnapshot,
  TagWithCount,
  TaskState,
  TaskStateSnapshot,
  TaskWriteResult,
  VersionConflict,
  Versions,
  WorkspaceSnapshot,
  WriteGuard,
} from "../../src/contracts.ts";
import type { EventKind } from "../../src/events.ts";
import type { Lane, Notification, Store, Tag, Task, TaskStatus, Update } from "../../src/store.ts";

// src/contracts.ts is the shared wire vocabulary (plan @400 N7/N11): the
// daemon, the native client and the retained browser all import it, so it
// must stay TYPE-ONLY. A runtime import (bun:sqlite via store.ts, node:*, a
// DOM helper) would leak into the browser bundle; these tests pin that and
// the exact shapes the plan specifies. The expectTypeOf/@ts-expect-error
// checks are enforced by `tsc --noEmit` (pnpm run style:check).

const SOURCE = fs.readFileSync(path.resolve(import.meta.dir, "../../src/contracts.ts"), "utf8");

describe("contracts: zero runtime footprint", () => {
  test("the module exports no runtime values", () => {
    expect(Object.keys(contracts)).toEqual([]);
  });

  test("every import is type-only and comes from store.ts or events.ts", () => {
    const imports = [...SOURCE.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["'];?/gm)];
    expect(imports.length).toBeGreaterThan(0);
    for (const [statement, typeKeyword, specifier] of imports) {
      expect(typeKeyword, `runtime import: ${statement.trim()}`).toBe("type ");
      expect(["./store.ts", "./events.ts"]).toContain(specifier);
    }
    // No side-effect imports (`import "x"`) and no dynamic imports either.
    expect(SOURCE).not.toMatch(/^\s*import\s+["']/m);
    expect(SOURCE).not.toMatch(/\bimport\s*\(/);
  });
});

describe("contracts: shapes (compile-time, checked by tsc)", () => {
  test("ResourceScope and Versions", () => {
    expectTypeOf<ResourceScope>().toEqualTypeOf<
      "entity" | "title" | "body" | "priority" | "lane" | "status" | "definition"
    >();
    expectTypeOf<Versions>().toEqualTypeOf<Partial<Record<ResourceScope, string>>>();
    const versions: Versions = { title: "a", body: "b" };
    // @ts-expect-error — `tags` is not a revision scope (tag deltas are unguarded commutative ops)
    const bad: Versions = { tags: "x" };
    expect([versions, bad].length).toBe(2);
  });

  test("WriteGuard carries optional expected versions and a mutation id", () => {
    expectTypeOf<WriteGuard["expected"]>().toEqualTypeOf<Versions | undefined>();
    expectTypeOf<WriteGuard["mutationId"]>().toEqualTypeOf<string | undefined>();
    const dedupeOnly: WriteGuard = { mutationId: "m-1" };
    const casOnly: WriteGuard = { expected: { body: "t" } };
    expect([dedupeOnly, casOnly].length).toBe(2);
  });

  test("TaskState pairs a task with its updates and versions, and is what Store.taskState returns", () => {
    expectTypeOf<TaskState["task"]>().toEqualTypeOf<Task>();
    expectTypeOf<TaskState["updates"]>().toEqualTypeOf<Update[]>();
    expectTypeOf<TaskState["versions"]>().toEqualTypeOf<Versions>();
    expectTypeOf<ReturnType<Store["taskState"]>>().toEqualTypeOf<TaskState | null>();
  });

  test("Endpoint is a unix-socket or http discriminated union", () => {
    expectTypeOf<Extract<Endpoint, { kind: "unix" }>>().toEqualTypeOf<{ kind: "unix"; socketPath: string }>();
    expectTypeOf<Extract<Endpoint, { kind: "http" }>>().toEqualTypeOf<{ kind: "http"; url: string }>();
    // @ts-expect-error — a unix endpoint needs its socket path
    const bad: Endpoint = { kind: "unix", url: "http://127.0.0.1:1" };
    expect(bad.kind).toBe("unix");
  });

  test("DaemonIdentity pins protocol 1 and names the database it serves", () => {
    expectTypeOf<DaemonIdentity["protocol"]>().toEqualTypeOf<1>();
    expectTypeOf<DaemonIdentity["databaseId"]>().toEqualTypeOf<string>();
    expectTypeOf<DaemonIdentity["endpoint"]>().toEqualTypeOf<Endpoint>();
    expectTypeOf<DaemonIdentity["webUrl"]>().toEqualTypeOf<string | undefined>();
    const identity: DaemonIdentity = {
      protocol: 1,
      instanceId: "i",
      databaseId: "d",
      databasePath: "/tmp/cortex.db",
      endpoint: { kind: "unix", socketPath: "/tmp/cortex.sock" },
      pid: 1,
    };
    // @ts-expect-error — only protocol 1 exists
    const future: DaemonIdentity = { ...identity, protocol: 2 };
    expect([identity, future].length).toBe(2);
  });

  test("LiveEvent kinds extend the existing event names with ready/resync", () => {
    expectTypeOf<LiveEvent["kind"]>().toEqualTypeOf<EventKind | "ready" | "resync">();
    expectTypeOf<LiveEvent["cursor"]>().toEqualTypeOf<string>();
  });

  test("WorkspaceSnapshot reuses the store DTOs (tags carry their task_count)", () => {
    // An in-process app (no runtime identity) answers with null rather than a fabricated endpoint.
    expectTypeOf<WorkspaceSnapshot["identity"]>().toEqualTypeOf<DaemonIdentity | null>();
    expectTypeOf<WorkspaceSnapshot["tasks"]>().toEqualTypeOf<Task[]>();
    expectTypeOf<WorkspaceSnapshot["lanes"]>().toEqualTypeOf<Lane[]>();
    expectTypeOf<WorkspaceSnapshot["tags"]>().toEqualTypeOf<(Tag & { task_count: number })[]>();
    expectTypeOf<WorkspaceSnapshot["tags"]>().toEqualTypeOf<ReturnType<Store["listTags"]>>();
    expectTypeOf<WorkspaceSnapshot["notifications"]>().toEqualTypeOf<Notification[]>();
  });
});

describe("contracts: wire DTOs and clients (Task 5)", () => {
  test("versioned write results pair the written row with its versions and replay flag", () => {
    expectTypeOf<TaskWriteResult>().toEqualTypeOf<{ task: Task; versions: Versions; replayed: boolean }>();
    expectTypeOf<PostUpdateResult["update"]>().toEqualTypeOf<Update>();
    expectTypeOf<PostUpdateResult["audit"]>().toEqualTypeOf<Update | null>();
    expectTypeOf<TaskStateSnapshot>().toMatchTypeOf<TaskState>();
    expectTypeOf<TaskStateSnapshot["cursor"]>().toEqualTypeOf<string>();
  });

  test("catalog states pair a lane or tag (with its member count) with its versions and the cursor", () => {
    expectTypeOf<LaneStateSnapshot>().toEqualTypeOf<{
      lane: Lane & { task_count: number };
      versions: Versions;
      cursor: string;
    }>();
    expectTypeOf<TagStateSnapshot>().toEqualTypeOf<{ tag: TagWithCount; versions: Versions; cursor: string }>();
    expectTypeOf<ReturnType<CortexClient["laneState"]>>().toEqualTypeOf<Promise<LaneStateSnapshot>>();
    expectTypeOf<ReturnType<CortexClient["tagState"]>>().toEqualTypeOf<Promise<TagStateSnapshot>>();
  });

  test("a 412 body names the stale scopes and every current token", () => {
    expectTypeOf<VersionConflict["kind"]>().toEqualTypeOf<"task" | "lane" | "tag">();
    expectTypeOf<VersionConflict["mismatches"][number]["scope"]>().toEqualTypeOf<ResourceScope>();
    expectTypeOf<VersionConflict["current"]>().toEqualTypeOf<Versions>();
  });

  test("stream payloads", () => {
    expectTypeOf<ReadyPayload>().toEqualTypeOf<{
      cursor: string;
      epoch: string;
      instanceId: string | null;
      databaseId: string;
    }>();
    expectTypeOf<ResyncPayload["reason"]>().toEqualTypeOf<"overflow" | "gap" | "epoch">();
    expectTypeOf<BlockedTransition>().toEqualTypeOf<{ task: Task; previous: TaskStatus; author: string }>();
    expectTypeOf<NotificationChange["action"]>().toEqualTypeOf<
      "read" | "unread" | "read_all" | "dismiss" | "clear" | "task_removed"
    >();
  });

  test("CortexClient extends the corrected ApiClient with snapshots and versioned writes", () => {
    expectTypeOf<CortexClient>().toMatchTypeOf<ApiClient>();
    expectTypeOf<ReturnType<CortexClient["workspace"]>>().toEqualTypeOf<Promise<WorkspaceSnapshot>>();
    expectTypeOf<ReturnType<CortexClient["taskState"]>>().toEqualTypeOf<Promise<TaskStateSnapshot>>();
    expectTypeOf<ReturnType<CortexClient["versioned"]["editTask"]>>().toEqualTypeOf<Promise<TaskWriteResult>>();
    // Posting requires an author (the server has always rejected author-less posts).
    expectTypeOf<Parameters<ApiClient["postUpd"]>[1]["author"]>().toEqualTypeOf<string>();
  });
});

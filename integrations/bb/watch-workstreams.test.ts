import { expect, test, vi } from "vitest";
import { routeCortexEvent } from "./watch";

test("canonical watch mutations invalidate and publish only the changed workstream; no-save/malformed are ignored", () => {
  const calls: unknown[] = [];
  const publish = (channel: string, payload: unknown) => calls.push([channel, payload]);
  const refresh = vi.fn();
  const shared = vi.fn((id?: string) => calls.push(["invalidate", id]));
  routeCortexEvent(
    { kind: "workstream.changed", payload: { outcome: "updated", entry: { workstreamId: "ws_envoy" } } },
    publish,
    refresh,
    shared,
  );
  expect(calls).toEqual([
    ["invalidate", "ws_envoy"],
    ["workstreams", { workstreamId: "ws_envoy" }],
  ]);
  expect(refresh).not.toHaveBeenCalled();
  calls.length = 0;
  routeCortexEvent(
    { kind: "workstream.changed", payload: { outcome: "no-save", entry: { workstreamId: "ws_envoy" } } },
    publish,
    refresh,
    shared,
  );
  routeCortexEvent(
    { kind: "workstream.changed", payload: { outcome: "updated", workstream: { id: "wrong" } } },
    publish,
    refresh,
    shared,
  );
  expect(calls).toEqual([]);
});

test("watch resync invalidates shared context globally but ordinary task activity never does", () => {
  const shared = vi.fn();
  const publish = vi.fn();
  const refresh = vi.fn();
  routeCortexEvent({ kind: "task.updated", payload: { id: 14 } }, publish, refresh, shared);
  expect(shared).not.toHaveBeenCalled();
  expect(publish).toHaveBeenCalledExactlyOnceWith("task", { taskId: 14 });
  routeCortexEvent({ kind: "resync" }, publish, refresh, shared);
  expect(shared).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(publish).toHaveBeenCalledWith("all", null);
});

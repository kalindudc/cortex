// @vitest-environment jsdom
import { useMemo } from "react";
import { cleanup, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, test, vi } from "vitest";
import { rpcContract } from "./server";
import { useNeedsYouBadge } from "./ui/page";

vi.mock("@get-bb/plugin-sdk/app", async importOriginal => {
  const sdk = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return { ...sdk, useRpc: () => {
    const transport = sdk.useRpc();
    return useMemo(() => ({ call: transport.call }), [transport]);
  } };
});

afterEach(cleanup);

function Badge() {
  const badge = useNeedsYouBadge();
  return <output>{badge?.count ?? 0}</output>;
}

function mountBadge() {
  const problems = vi.fn(() => ({ problems: [] }));
  const slot = renderSlot({ component: Badge }, {}, {
    realtimeConnectionState: "connected",
    experimental_rpcContract: rpcContract,
    rpc: { problems, reviewQueue: () => ({ items: [], total: 0, limit: 100, offset: 0 }) },
  });
  return { slot, problems };
}

test.each(["workstreams", "sections"])("the badge does not refetch for a thread-only %s signal", async channel => {
  const { slot, problems } = mountBadge();
  await waitFor(() => expect(problems).toHaveBeenCalledTimes(1));
  await slot.behavior.emitRealtime(channel, { threadId: "thr_aaaaaaaa" });
  expect(problems).toHaveBeenCalledTimes(1);
});

test.each([
  ["workstreams", { sectionId: "sec_one" }],
  ["workstreams", { workstreamId: "ws_one" }],
  ["workstreams", null],
  ["sections", { sectionId: "sec_one" }],
  ["sections", null],
  ["drafts", { sectionId: "sec_one" }],
  ["all", null],
] as const)("the badge refetches for %s %j", async (channel, payload) => {
  const { slot, problems } = mountBadge();
  await waitFor(() => expect(problems).toHaveBeenCalledTimes(1));
  await slot.behavior.emitRealtime(channel, payload);
  await waitFor(() => expect(problems).toHaveBeenCalledTimes(2));
});

test("the badge still refetches on reconnect", async () => {
  const { slot, problems } = mountBadge();
  await waitFor(() => expect(problems).toHaveBeenCalledTimes(1));
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  await slot.behavior.setRealtimeConnectionState("connected");
  await waitFor(() => expect(problems).toHaveBeenCalledTimes(2));
});

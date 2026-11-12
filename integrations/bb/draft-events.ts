import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { DraftService } from "./draft-service";

export function registerDraftEvents(bb: BbPluginApi, service: DraftService) {
  const safely = async (task: () => Promise<unknown>) => {
    try { await task(); } catch (e) { bb.log.warn(`Draft recovery failed: ${e instanceof Error ? e.message : String(e)}`); }
  };
  bb.events.on("thread.idle", ({ thread }) => safely(() => service.collect(thread.id)));
  bb.events.on("thread.failed", ({ thread }) => safely(() => service.failed(thread.id)));
  bb.background.service("draft-recover", {
    async start(signal) {
      for (const job of service.store.active()) { if (signal.aborted) return; await safely(() => service.reconcile(job.requestId, signal)); }
      if (signal.aborted) return;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });
  bb.background.schedule("draft-reconcile", "* * * * *", async () => {
    for (const job of service.store.active()) await safely(() => service.reconcile(job.requestId));
  });
}

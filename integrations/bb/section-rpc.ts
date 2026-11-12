import {
  experimental_PluginRpcRefusal,
  type ExperimentalPluginRpcHandlerContext,
  type ExperimentalPluginRpcHandlersWithContext,
} from "@get-bb/plugin-sdk";
import { sectionRpcContract } from "./section-contract";
import type { Sections } from "./sections";
import type { DraftService } from "./draft-service";

export function sectionHandlers(
  service: Sections,
  drafts?: DraftService,
): ExperimentalPluginRpcHandlersWithContext<typeof sectionRpcContract> {
  async function call<T>(operation: () => Promise<T> | T): Promise<T> {
    try {
      return await operation();
    } catch (e) {
      if (e instanceof experimental_PluginRpcRefusal) throw e;
      const message = e instanceof Error ? e.message : String(e);
      throw new experimental_PluginRpcRefusal({
        code: /revision|conflict/i.test(message)
          ? "conflict"
          : /not found/i.test(message)
            ? "not_found"
            : /human|identify/i.test(message)
              ? "forbidden"
              : "invalid",
        message,
      });
    }
  }
  function human(ctx: ExperimentalPluginRpcHandlerContext) {
    if (ctx.experimental_caller.kind !== "client")
      throw new experimental_PluginRpcRefusal({
        code: "forbidden",
        message:
          "Use the Cortex UI for explicit section sharing, capture and approval. Caller kind is provenance, not authentication.",
      });
    service.human();
  }
  return {
    sectionList: (_input, ctx) => call(() => service.sectionList(ctx.experimental_signal)),
    sectionDetail: (input, ctx) => call(() => service.detail(input, ctx.experimental_signal)),
    sectionEligibility: ({ sectionId }, ctx) => call(() => service.eligibility(sectionId, ctx.experimental_signal)),
    sectionConnect: (input, ctx) =>
      call(() => {
        human(ctx);
        return service.connect(input, ctx.experimental_signal);
      }),
    sectionConnectRetry: ({ requestId }, ctx) =>
      call(() => {
        human(ctx);
        return service.connectRetry(requestId, ctx.experimental_signal);
      }),
    sectionTitleMark: (input, ctx) =>
      call(() => {
        human(ctx);
        return service.markTitle(input);
      }),
    sectionCapture: (input, ctx) =>
      call(() => {
        human(ctx);
        return service.capture(input, ctx.experimental_signal);
      }),
    sectionCaptureRetry: ({ requestId }, ctx) =>
      call(() => {
        human(ctx);
        return service.captureRetry(requestId, ctx.experimental_signal);
      }),
    sectionCaptureJobs: (input, ctx) =>
      call(() => {
        human(ctx);
        return service.captureJobs(input, ctx.experimental_signal);
      }),
    sectionCaptureDismiss: (input, ctx) =>
      call(() => {
        human(ctx);
        return service.captureDismiss(input, ctx.experimental_signal);
      }),
    sectionCandidateEdit: (input, ctx) =>
      call(() => {
        human(ctx);
        return service.candidateEdit(input, ctx.experimental_signal);
      }),
    sectionCandidateAccept: (input, ctx) =>
      call(() => {
        human(ctx);
        return service.candidateAccept(input, ctx.experimental_signal);
      }),
    sectionDraftStatus: ({ sectionId }, ctx) =>
      call(async () => {
        await service.eligibility(sectionId, ctx.experimental_signal);
        return {
          available: drafts?.capabilities().available ?? false,
          reason: drafts ? "Background drafting creates sourced, unapproved finding suggestions after an explicit source/model preview." : "The drafting backend is unavailable. Save a verified message or write a takeaway instead.",
        };
      }),
  };
}
export function unavailableSectionHandlers(
  reason: string,
): ExperimentalPluginRpcHandlersWithContext<typeof sectionRpcContract> {
  return Object.fromEntries(
    Object.keys(sectionRpcContract).map(name => [
      name,
      () => {
        throw new Error(reason);
      },
    ]),
  ) as unknown as ExperimentalPluginRpcHandlersWithContext<typeof sectionRpcContract>;
}

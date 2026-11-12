import { useMemo } from "react";
import {
  experimental_THREAD_ACTION_GROUPS,
  type PluginThreadActionRegistration,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { STATUS_LABEL } from "../panel/status";
import type { CortexThreadState } from "../state";
import { VISIBILITY_WORD } from "./copy";
import { type RpcFailure, useThreadStates, useVisibility, useWorkstreamWrites } from "./data";
import { dismissedFor, type Visibility, visibilityOf } from "./model";
import { openTaskTab } from "./panel-tabs";
import { taskIcon } from "./context-widget";
import { useDefaultShown, visibilityDetail } from "./thread-context";
import { openTakeaway } from "./takeaway";

export const saveTakeawayAction: PluginThreadActionRegistration = {
  id: "cortex-save-takeaway", title: "Save takeaway", icon: "BookmarkPlus", group: "cortex",
  item: ({ experimental_panel }) => ({ label: "Save takeaway…", icon: "BookmarkPlus", run: () => { if (!openTakeaway(experimental_panel)) toast.error("bb could not open Save as takeaway here."); } }),
};

type TaskData = { shown: boolean; focus: Map<string, CortexThreadState["links"][number]> };

function useHeaderTasks({ threadIds }: { threadIds: readonly string[] }): TaskData {
  const { values } = useSettings();
  const shown = values?.taskChip !== false;
  const reads = useThreadStates(shown ? threadIds : []);
  const focus = new Map<string, CortexThreadState["links"][number]>();
  for (const read of reads) {
    const state = read.data;
    const link = state?.links.find(row => row.id === state.focusTaskId);
    if (state && link) focus.set(state.threadId, link);
  }
  return { shown, focus };
}

/** The thread header's `#908 · Open` button; opens the Cortex tab following the focus task. Hidden by the taskChip setting. */
export const taskHeaderAction: PluginThreadActionRegistration<TaskData> = {
  id: "cortex-task",
  title: "Cortex task",
  icon: "Brain",
  group: "cortex",
  placement: "header",
  useData: useHeaderTasks,
  item: ({ thread, data, experimental_panel }) => {
    const link = data.shown ? data.focus.get(thread.id) : undefined;
    if (!link) return null;
    return {
      label: `#${link.id} · ${STATUS_LABEL[link.status]}`,
      detail: link.title,
      icon: taskIcon(link.status),
      run: () => {
        if (!openTaskTab(experimental_panel, thread.id, null)) toast.error("bb could not open the Cortex tab here.");
      },
    };
  },
};

type VisibilityData = {
  rows: ReturnType<typeof useVisibility>;
  defaultShown: boolean;
  set: (threadId: string, dismissed: boolean | null) => Promise<unknown>;
};

function useVisibilityData({ threadIds }: { threadIds: readonly string[] }): VisibilityData {
  const rows = useVisibility(threadIds);
  const defaultShown = useDefaultShown();
  const writes = useWorkstreamWrites();
  return useMemo(() => ({ rows, defaultShown, set: writes.setDismissed }), [rows, defaultShown, writes]);
}

/**
 * "Cortex context" in every thread menu: show it above the composer, hide it
 * for this thread, or follow the setting. Always present, so a hidden widget
 * can always come back, whatever the appearance settings say.
 */
export const contextVisibilityAction: PluginThreadActionRegistration<VisibilityData> = {
  id: "cortex-context",
  title: "Cortex context",
  icon: "Layers",
  group: experimental_THREAD_ACTION_GROUPS.settings,
  order: 50,
  useData: useVisibilityData,
  item: ({ thread, data }) => {
    const row = data.rows.get(thread.id);
    const current = row ? visibilityOf(row.dismissedPreference) : null;
    const choices: Array<[Visibility, string]> = [
      ["shown", VISIBILITY_WORD.shown],
      ["hidden", VISIBILITY_WORD.hidden],
      ["follow", VISIBILITY_WORD.follow(data.defaultShown)],
    ];
    return {
      label: "Cortex context",
      ...(row ? { detail: visibilityDetail(row, data.defaultShown) } : {}),
      icon: "Layers",
      choices: {
        heading: "Cortex context above the composer",
        hint: "Hiding changes only what you see. The thread still gets its context.",
        items: choices.map(([id, label]) => ({ id, label, ...(current === null ? {} : { selected: current === id }) })),
      },
      run: async ({ value }) => {
        if (value !== "shown" && value !== "hidden" && value !== "follow") return;
        try {
          await data.set(thread.id, dismissedFor(value));
          toast(value === "hidden" ? "Cortex context hidden for this thread" : value === "shown" ? "Cortex context shown above the composer" : "Cortex context follows the setting");
        } catch (cause) {
          toast.error((cause as RpcFailure).message);
        }
      },
    };
  },
};

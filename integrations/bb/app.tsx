import {
  definePluginApp,
  experimental_THREAD_INFO_SECTION_GROUPS as INFO_SECTION_GROUPS,
} from "@get-bb/plugin-sdk/app";
import { CortexCard } from "./panel/card";
import { MemoryPanel } from "./panel/memory";
import { CortexPanel } from "./panel/panel";
import { ContextCardSection, ContextSegmentDetails, ContextSegmentSummary, useSegmentVisible } from "./ui/context-widget";
import { CortexPage, CortexSidebar, useCortexPageTitle, useNeedsYouBadge } from "./ui/page";
import { MEMORY_TAB_ID, TASK_TAB_ID } from "./ui/panel-tabs";
import { contextVisibilityAction, taskHeaderAction } from "./ui/thread-actions";
import { CORTEX_PAGE_PATH } from "./ui/thread-context";

export default definePluginApp(app => {
  // Tab ids match the retired threadPanelAction ids, so saved tabs and layouts carry over.
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: TASK_TAB_ID,
    title: "Cortex",
    icon: "Brain",
    layout: "flush",
    component: CortexPanel,
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: MEMORY_TAB_ID,
    title: "Memory",
    icon: "Layers",
    layout: "flush",
    component: MemoryPanel,
  });
  app.slots.navPanel({
    id: "cortex",
    title: "Cortex",
    icon: "Brain",
    path: CORTEX_PAGE_PATH,
    component: CortexPage,
    experimental_sidebar: CortexSidebar,
    experimental_useBadge: useNeedsYouBadge,
    experimental_usePageTitle: useCortexPageTitle,
  });
  // One widget in two host places: the context row above the composer, or the context card in wide panes.
  app.slots.experimental_threadContextSegment({
    id: "cortex-context",
    title: "Cortex context",
    group: "3_cortex",
    summary: ContextSegmentSummary,
    details: ContextSegmentDetails,
    useVisible: useSegmentVisible,
  });
  app.slots.experimental_threadContextCardSection({
    id: "cortex-context",
    title: "Cortex",
    group: INFO_SECTION_GROUPS.related,
    order: 40,
    component: ContextCardSection,
  });
  app.slots.experimental_threadAction(taskHeaderAction);
  app.slots.experimental_threadAction(contextVisibilityAction);
  app.slots.messageDirective({ id: "cortex", component: CortexCard });
});

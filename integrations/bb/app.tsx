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
import { TAKEAWAY_TAB_ID, TakeawayPanel, saveMessageAction } from "./ui/takeaway";
import { saveTakeawayAction } from "./ui/thread-actions";
import { DraftingSettings } from "./ui/draft-settings";
import { NEW_THREAD_OPEN, NewThreadContextBanner } from "./ui/new-thread";
import "./ui/section.css";
import "./ui/cortex.css";

export default definePluginApp(app => {
  app.slots.settingsSection({ id: "drafting", title: "Drafting", component: DraftingSettings });
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
  app.slots.experimental_threadAction(saveTakeawayAction);
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action", id: TAKEAWAY_TAB_ID, title: "Save takeaway", icon: "Star", component: TakeawayPanel });
  app.slots.messageAction(saveMessageAction);
  app.slots.messageDirective({ id: "cortex", component: CortexCard });
  // bb renders composer banners on its root New thread composer; this row follows that composer's draft. It is bare
  // because bb's card would stretch the folded chip across the whole composer.
  app.composer.customize({
    id: "cortex-new-thread",
    scopes: ["new-thread"],
    banners: [{ id: "context", chrome: "bare", component: NewThreadContextBanner }],
    plusMenu: [{ id: "context", label: "What this thread starts with", icon: "Brain", run: ({ composer }) => { window.dispatchEvent(new CustomEvent(NEW_THREAD_OPEN, { detail: composer.key })); } }],
  });
});

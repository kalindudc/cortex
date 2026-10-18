import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { CortexCard } from "./panel/card";
import { CortexChip } from "./panel/chip";
import { MEMORY_ACTION_ID, MemoryHeaderAction, MemoryPanel } from "./panel/memory";
import { CortexPanel } from "./panel/panel";
import { PANEL_ACTION_ID } from "./panel/selection";

export default definePluginApp(app => {
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Cortex",
    icon: "Brain",
    layout: "flush",
    component: CortexPanel,
  });
  app.slots.threadPanelAction({
    id: MEMORY_ACTION_ID,
    title: "Memory",
    icon: "Layers",
    layout: "flush",
    component: MemoryPanel,
  });
  app.slots.experimental_threadHeaderAction({ id: "cortex-chip", title: "Cortex task", component: CortexChip });
  // Not a prompt-box action: bb shows only three plugins' actions there and does not mount the rest.
  app.slots.experimental_threadHeaderAction({ id: "cortex-memory", title: "Cortex memory", component: MemoryHeaderAction });
  app.slots.messageDirective({ id: "cortex", component: CortexCard });
});

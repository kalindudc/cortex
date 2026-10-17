import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { CortexCard } from "./panel/card";
import { CortexChip, PANEL_ACTION_ID } from "./panel/chip";
import { CortexPanel } from "./panel/panel";

export default definePluginApp(app => {
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Cortex",
    icon: "Brain",
    layout: "flush",
    component: CortexPanel,
  });
  app.slots.experimental_threadHeaderAction({ id: "cortex-chip", title: "Cortex task", component: CortexChip });
  app.slots.messageDirective({ id: "cortex", component: CortexCard });
});

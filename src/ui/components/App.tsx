// App — root component. Wraps the three panes + overlays in a transparent
// (display:contents) div so the panes are direct children of the <main>
// grid.

import type { VNode } from "preact";

import { sidebarView, paletteOpen, errorMsg } from "../state/signals.ts";
import { TopBar } from "./TopBar.tsx";
import { LanesPane } from "./sidebar/LanesPane.tsx";
import { TagsPane } from "./sidebar/TagsPane.tsx";
import { ActiveTaskPane } from "./active/ActiveTaskPane.tsx";
import { InboxPane } from "./inbox/InboxPane.tsx";
import { CommandPalette } from "./palette/CommandPalette.tsx";
import { ModalRoot } from "./modals/ModalRoot.tsx";
import { Tooltip } from "./Tooltip.tsx";

export default function App(): VNode {
  // CommandPalette is mounted ONLY when paletteOpen.value is true. The
  // ternary here is load-bearing: if we rendered it unconditionally and it
  // self-gated with `return null`, the component would never unmount and its
  // useEffect-based autofocus would only fire on the very first open. See
  // the comment above CommandPalette for the full failure mode.
  return (
    <div class="contents">
      <TopBar />
      {sidebarView.value === "tags" ? <TagsPane /> : <LanesPane />}
      <ActiveTaskPane />
      <InboxPane />
      {paletteOpen.value ? <CommandPalette /> : null}
      <ModalRoot />
      <Tooltip />
      {errorMsg.value ? <div class="toast">{errorMsg.value}</div> : null}
    </div>
  );
}

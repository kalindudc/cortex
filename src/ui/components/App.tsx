// App — root component. Wraps the three panes + overlays in a transparent
// (display:contents) div so the panes are direct children of the <main>
// grid.

import type { VNode } from "preact";

import { paletteOpen, errorMsg, migrationsPending } from "../state/signals.ts";
import { TopBar } from "./TopBar.tsx";
import { SidebarPane } from "./sidebar/SidebarPane.tsx";
import { ActiveTaskPane } from "./active/ActiveTaskPane.tsx";
import { InboxPane } from "./inbox/InboxPane.tsx";
import { StatusBar } from "./StatusBar.tsx";
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
      {migrationsPending.value.length > 0 ? (
        <div class="migration-banner">
          <span class="migration-banner-text">
            Database migrations pending ({migrationsPending.value.join(", ")}) — run <code>cortex init</code> to apply
            them safely.
          </span>
        </div>
      ) : null}
      <TopBar />
      <SidebarPane />
      <ActiveTaskPane />
      <InboxPane />
      <StatusBar />
      {paletteOpen.value ? <CommandPalette /> : null}
      <ModalRoot />
      <Tooltip />
      {errorMsg.value ? <div class="toast">{errorMsg.value}</div> : null}
    </div>
  );
}

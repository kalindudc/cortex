// NavRail — the app's navigation rail, the first grid column.
//
// Tasks, Search, Lanes, Tags, Backup, Agent tools and Settings are
// destinations: each sets the `view` signal (Settings through
// openSettings(), which also focuses its search) and is marked aria-current
// while active, and pressing the active one keeps its view. None of them
// touches the filters. At <= 900px App mounts this same rail inside the
// navigation drawer.

import type { VNode } from "preact";
import { view, type View } from "../state/signals.ts";
import { openSettings } from "../state/workspace.ts";
import { tip } from "../state/tooltip.ts";
import { Icon } from "./Icon.tsx";
import { ThemeToggle } from "./sidebar/ThemeToggle.tsx";

function Destination({
  to,
  label,
  icon,
  go = () => (view.value = to),
}: {
  to: View;
  label: string;
  icon: string;
  go?: () => void;
}): VNode {
  return (
    <button
      type="button"
      class="btn-icon"
      aria-label={label}
      aria-current={view.value === to ? "page" : undefined}
      onClick={go}
      {...tip(label)}
    >
      <Icon name={icon} />
    </button>
  );
}

export function NavRail(): VNode {
  return (
    <nav class="nav-rail" aria-label="Navigation">
      <span class="brand-mark" aria-hidden="true">
        c
      </span>
      <Destination to="tasks" label="Tasks" icon="home" />
      <Destination to="search" label="Search" icon="search" />
      <span class="nav-rail-sep" aria-hidden="true"></span>
      <Destination to="lanes" label="Lanes" icon="layers" />
      <Destination to="tags" label="Tags" icon="hash" />
      <Destination to="backup" label="Backup" icon="archive" />
      <Destination to="agents" label="Agent tools" icon="bot" />
      <span class="grow" aria-hidden="true"></span>
      <ThemeToggle />
      <Destination to="settings" label="Settings" icon="settings" go={openSettings} />
    </nav>
  );
}

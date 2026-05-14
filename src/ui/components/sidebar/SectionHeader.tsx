// SectionHeader — collapsible header for SidebarPane's three sections
// (Views/Lanes/Tags).
//
// Renders a button that flips a section open/closed, with a rotating chevron
// affordance, the section label, an optional count, and an optional trailing
// slot (e.g. a "+" icon button to create a new lane/tag). The button itself
// owns the toggle; the trailing slot stops event propagation so its own
// onClick handlers can fire without flipping the section.
//
// Visual weight mirrors the previous .section-head eyebrow style so the new
// sections feel familiar; CSS in sidebar.css provides .section-toggle.

import type { JSX, VNode } from "preact";
import { Icon } from "../Icon.tsx";

export interface SectionHeaderProps {
  label: string;
  open: boolean;
  count?: number;
  onToggle: () => void;
  trailing?: JSX.Element;
}

export function SectionHeader(props: SectionHeaderProps): VNode {
  const { label, open, count, onToggle, trailing } = props;
  return (
    <div class="section-head">
      <button type="button" class={`section-toggle${open ? "" : " closed"}`} aria-expanded={open} onClick={onToggle}>
        <Icon name="chevronDown" size={12} />
        <span class="section-label">{label}</span>
        {typeof count === "number" ? <span class="count num">{count}</span> : null}
        {trailing ? (
          <span class="section-trailing" onClick={(e: MouseEvent) => e.stopPropagation()}>
            {trailing}
          </span>
        ) : null}
      </button>
    </div>
  );
}

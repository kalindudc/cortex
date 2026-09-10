// FilterChips — selected-TAG tokens inside WorkspaceFilters (W2).
//
// One removable token per entry in filters.value.tag (OR-composed in
// computed.ts; the UNTAGGED sentinel renders as the literal word
// "untagged"). Status and lane have their own visible selectors in
// WorkspaceFilters, so they get no chips here, and the old '+ tag'
// affordance is gone — the single Tags trigger lives beside the selectors.
// Renders nothing when no tags are selected.

import type { VNode } from "preact";
import { filters, toggleTagFilter } from "../../state/signals.ts";
import { UNTAGGED } from "../../state/computed.ts";
import { Icon } from "../Icon.tsx";
import { tip } from "../../state/tooltip.ts";

interface ChipProps {
  label: string;
  onRemove: () => void;
  removeTip: string;
}

function Chip({ label, onRemove, removeTip }: ChipProps): VNode {
  return (
    <span class="filter-chip">
      <span class="filter-chip-label">{label}</span>
      <button type="button" class="x" onClick={onRemove} aria-label={removeTip} {...tip(removeTip)}>
        <Icon name="x" size={12} />
      </button>
    </span>
  );
}

export function FilterChips(): VNode | null {
  const { tag } = filters.value;
  if (tag.length === 0) return null;
  return (
    <div class="filter-chips">
      {tag.map(name => (
        <Chip
          key={name}
          label={name === UNTAGGED ? "untagged" : `#${name}`}
          onRemove={() => toggleTagFilter(name)}
          removeTip={name === UNTAGGED ? "Stop including untagged tasks" : `Remove tag filter: #${name}`}
        />
      ))}
    </div>
  );
}

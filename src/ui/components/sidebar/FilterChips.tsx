// FilterChips — renders the active `filters` slots as removable chips, plus
// a persistent "+ tag" affordance that opens the TagFilterModal.
//
// One chip per non-null slot: status, lane, and one chip per entry in the
// tag array (OR-composed in computed.ts). The strip ALWAYS renders so the
// "+ tag" affordance is one click away regardless of filter state — mouse
// users would otherwise have no discoverable entry to tag filtering.

import type { VNode } from "preact";
import { filters, setFilter, toggleTagFilter, modal } from "../../state/signals.ts";
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

export function FilterChips(): VNode {
  const { status, lane, tag } = filters.value;
  return (
    <div class="filter-chips">
      {status ? (
        <Chip label={`status: ${status}`} onRemove={() => setFilter("status", null)} removeTip="Clear status filter" />
      ) : null}
      {lane ? (
        <Chip label={`lane: ${lane}`} onRemove={() => setFilter("lane", null)} removeTip="Clear lane filter" />
      ) : null}
      {tag.map(name => (
        <Chip
          key={name}
          label={name === UNTAGGED ? "untagged" : `#${name}`}
          onRemove={() => toggleTagFilter(name)}
          removeTip={name === UNTAGGED ? "Stop including untagged tasks" : `Remove tag filter: #${name}`}
        />
      ))}
      <button
        type="button"
        class="filter-chip-add"
        onClick={() => (modal.value = { kind: "filter-tags" })}
        aria-label="Filter by tags"
        {...tip("Open the tag filter")}
      >
        <Icon name="plus" size={11} />
        <span>tag</span>
      </button>
    </div>
  );
}

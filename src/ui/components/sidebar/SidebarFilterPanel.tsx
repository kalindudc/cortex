// The sidebar's three filters, and the task list's sort and group choice,
// share ONE attached, nonmodal surface. It is
// a sibling of sidebar-body (not inside its clipped/scrolling task list).
// Absolute coordinates are local to the sidebar, so drawer entry motion
// cannot turn viewport coordinates into a second, drifting offset.
import type { JSX, VNode } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { filters, lanes, setFilter, type SidebarFilter } from "../../state/signals.ts";
import { SETTINGS } from "../../state/settings.ts";
import { closeSidebarFilter } from "../../state/popovers.ts";
import { STATUS, STATUS_LABEL } from "../../../lib/constants.ts";
import { searchCatalog, catalogSearchHint } from "../../../lib/catalogSearch.ts";
import type { TaskStatus } from "../../api/types.ts";
import { Icon } from "../Icon.tsx";
import { TagFilterPanel } from "./TagFilterPanel.tsx";
import { SettingRow } from "../panels/SettingRow.tsx";

export function SidebarFilterPanel({ kind }: { kind: SidebarFilter }): VNode {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const panel = ref.current;
    const sidebar = panel?.closest<HTMLElement>(".sidebar-pane");
    const search = sidebar?.querySelector<HTMLElement>(".ws-search");
    const trigger = document.getElementById(`sidebar-filter-${kind}-trigger`);
    if (!panel || !sidebar || !search || !trigger) return;
    const body = sidebar.querySelector(".sidebar-body");
    const viewport = window.visualViewport;
    const place = (): void => {
      const bounds = sidebar.getBoundingClientRect();
      const anchor = trigger.getBoundingClientRect();
      const column = search.getBoundingClientRect();
      // A not-yet-visible drawer has no layout. Its ResizeObserver will
      // place the panel as soon as showModal makes the sidebar measurable.
      if (bounds.height === 0 || column.width === 0) return;
      const viewportTop = viewport?.offsetTop ?? 0;
      const top = Math.max(bounds.top, viewportTop) + 8;
      const bottom = Math.min(bounds.bottom, viewportTop + (viewport?.height ?? window.innerHeight)) - 8;
      const visibleBody = body?.getBoundingClientRect();
      if (
        anchor.bottom <= Math.max(top, visibleBody?.top ?? top) ||
        anchor.top >= Math.min(bottom, visibleBody?.bottom ?? bottom)
      ) {
        closeSidebarFilter();
        return;
      }
      const below = Math.max(0, bottom - anchor.bottom - 6);
      const above = Math.max(0, anchor.top - top - 6);
      const preferred = kind === "status" ? 42 + panel.querySelectorAll('[role="option"]').length * 44 : 320;
      const side = below >= Math.min(preferred, 240) || below >= above ? "below" : "above";
      panel.dataset.side = side;
      panel.style.left = `${column.left - bounds.left}px`;
      panel.style.width = `${column.width}px`;
      panel.style.maxHeight = `${Math.min(400, side === "below" ? below : above)}px`;
      panel.style.top = side === "below" ? `${anchor.bottom + 6 - bounds.top}px` : "auto";
      panel.style.bottom = side === "above" ? `${bounds.bottom - anchor.top + 6}px` : "auto";
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(sidebar);
    observer.observe(search);
    const controls = sidebar.querySelector(".workspace-filters");
    if (controls) observer.observe(controls);
    body?.addEventListener("scroll", place);
    window.addEventListener("resize", place);
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    return () => {
      observer.disconnect();
      body?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
    };
  }, [kind]);

  const title =
    kind === "tags"
      ? "Filter by tags"
      : kind === "status"
        ? "Status filter"
        : kind === "lane"
          ? "Lane filter"
          : "Sort and group";
  return (
    <section
      ref={ref}
      id={`sidebar-filter-${kind}-panel`}
      class="sidebar-filter-panel"
      aria-labelledby={`sidebar-filter-${kind}-heading`}
      data-pop
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== "Escape" || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        closeSidebarFilter(true);
      }}
    >
      <div class="sidebar-filter-surface">
        <header class="sidebar-filter-head">
          <h2 id={`sidebar-filter-${kind}-heading`}>{title}</h2>
          <button
            type="button"
            class="btn-icon"
            aria-label={kind === "order" ? "Close sort and group" : "Close filter"}
            onClick={() => closeSidebarFilter(true)}
          >
            <Icon name="x" size={14} />
          </button>
        </header>
        {kind === "tags" ? (
          <TagFilterPanel close={() => closeSidebarFilter(true)} />
        ) : kind === "order" ? (
          <OrderChoices />
        ) : (
          <SingleFilterChoices kind={kind} />
        )}
      </div>
    </section>
  );
}

// The Sort, Direction and Group settings themselves, so the list and the
// settings panel change them the same way. It stays open across a change: the
// choices are independent.
function OrderChoices(): VNode {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLElement>("select")?.focus({ preventScroll: true });
  }, []);
  return (
    <div class="sidebar-order" ref={ref}>
      {SETTINGS.filter(s => s.key === "sort" || s.key === "direction" || s.key === "group").map(s => (
        <SettingRow key={s.key} spec={s} />
      ))}
    </div>
  );
}

// Real focus, not selection-follows-focus: arrows/Home/End only navigate;
// native button Enter/Space commits. Lanes focus their search on each open,
// while the small status list still starts on the selected option.
function SingleFilterChoices({ kind }: { kind: "status" | "lane" }): VNode {
  const search = useSignal("");
  const current = filters.value[kind];
  const catalog = lanes.value.map(lane => ({ value: lane.name, label: lane.name }));
  if (kind === "lane" && current != null && !catalog.some(option => option.value === current)) {
    catalog.push({ value: current, label: `${current} (missing)` });
  }
  const results = searchCatalog(catalog, search.value, option => option.value);
  const options: Array<{ value: string | null; label: string }> =
    kind === "status"
      ? [{ value: null, label: "All statuses" }, ...STATUS.map(value => ({ value, label: STATUS_LABEL[value] }))]
      : [{ value: null, label: "All lanes" }, ...results.items];
  const cursor = useSignal(
    Math.max(
      0,
      options.findIndex(option => option.value === current),
    ),
  );
  const cursorIndex = Math.min(cursor.value, options.length - 1);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusOption = (index: number): void => {
    const option = ref.current?.querySelectorAll<HTMLElement>('[role="option"]')[index];
    option?.focus({ preventScroll: true });
    option?.scrollIntoView({ block: "nearest" });
  };
  const select = (value: string | null): void => {
    if (kind === "status") setFilter("status", value as TaskStatus | null);
    else setFilter("lane", value);
    closeSidebarFilter(true);
  };
  useLayoutEffect(() => {
    if (searchRef.current) searchRef.current.focus({ preventScroll: true });
    else {
      const option = ref.current?.querySelector<HTMLElement>('[aria-selected="true"]');
      option?.focus({ preventScroll: true });
      option?.scrollIntoView({ block: "nearest" });
    }
  }, []);
  return (
    <div class="sidebar-single-filter">
      {kind === "lane" ? (
        <div class="sidebar-filter-search">
          <div class="catalog-search-field">
            <Icon name="search" size={14} />
            <input
              ref={searchRef}
              type="search"
              aria-label="Search lanes"
              aria-describedby="sidebar-lane-search-hint"
              autoFocus
              placeholder="Search lanes…"
              value={search.value}
              onInput={(event: JSX.TargetedInputEvent<HTMLInputElement>) => {
                search.value = event.currentTarget.value;
                cursor.value = 0;
              }}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.isComposing) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const first = search.value.trim() && results.items.length > 0 ? 1 : 0;
                  focusOption(event.key === "ArrowDown" ? first : options.length - 1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  // A no-match Enter must NOT silently clear the lane filter.
                  // All lanes remains available via its explicit button.
                  if (search.value.trim() && results.items[0]) select(results.items[0].value);
                }
              }}
            />
          </div>
          <p class="catalog-search-hint" id="sidebar-lane-search-hint" role="status">
            {catalogSearchHint(results)}
          </p>
        </div>
      ) : null}
      <div
        ref={ref}
        class="sidebar-filter-choices"
        role="listbox"
        aria-label={kind === "status" ? "Status choices" : "Lane choices"}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.isComposing) return;
          let next: number;
          if (event.key === "ArrowDown") next = (cursorIndex + 1) % options.length;
          else if (event.key === "ArrowUp") next = (cursorIndex - 1 + options.length) % options.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = options.length - 1;
          else return;
          event.preventDefault();
          focusOption(next);
        }}
      >
        {options.map((option, index) => (
          <button
            key={option.value == null ? "all-values" : `value-${option.value}`}
            type="button"
            role="option"
            class="sidebar-filter-option"
            aria-selected={current === option.value}
            tabIndex={cursorIndex === index ? 0 : -1}
            autoFocus={kind === "status" && current === option.value}
            onFocus={() => {
              cursor.value = index;
            }}
            onClick={() => select(option.value)}
          >
            <span class="sidebar-filter-check">
              {current === option.value ? <Icon name="check" size={13} /> : null}
            </span>
            <span>{option.label}</span>
          </button>
        ))}
        {kind === "lane" && results.matched === 0 ? <p class="picker-empty meta">no lanes match</p> : null}
      </div>
    </div>
  );
}

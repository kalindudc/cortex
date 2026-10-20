// state/context.ts — The side panel beside the document: whether it shows,
// which tab it shows (Details, Inbox or Outline), and the outline the
// document publishes for it.
//
// On a wide window the panel is a grid column; its open state and tab
// persist under CONTEXT_KEY. On a narrow window the same panel opens as a
// sheet whose open state lives in memory only. Focus reading hides the
// inline panel without changing the stored choice. The panel shows only in
// the views that show the task document (TASK_VIEWS); showing it from any
// other view switches to Tasks.

import { batch, effect, signal, type Signal } from "@preact/signals";
import { focusReading, narrowViewport, TASK_VIEWS, view } from "./signals.ts";

export type ContextTab = "details" | "inbox" | "outline";
export const CONTEXT_KEY = "cortex-context-v1";

const TABS: readonly ContextTab[] = ["details", "inbox", "outline"];
// Anything longer than this is judged corrupt and rejected whole.
const MAX_STORED_LENGTH = 256;

export const contextOpen: Signal<boolean> = signal(true);
export const contextSheetOpen: Signal<boolean> = signal(false);
export const contextTab: Signal<ContextTab> = signal<ContextTab>("details");

export interface OutlineState {
  taskId: number;
  headings: ReadonlyArray<{ id: string; text: string; level: number }>;
  active: string | null;
}
// Written by TaskDocument for the task it shows; OutlineTab trusts it only
// for the active task, so an entry left by a closed task never shows.
export const docOutline: Signal<OutlineState | null> = signal<OutlineState | null>(null);

export function parseStoredContext(raw: string | null): { open: boolean; tab: ContextTab } | null {
  if (raw == null || raw.length > MAX_STORED_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { open, tab } = value as Record<string, unknown>;
    if (typeof open !== "boolean" || !TABS.includes(tab as ContextTab)) return null;
    return { open, tab: tab as ContextTab };
  } catch {
    return null;
  }
}

function readStored(): { open: boolean; tab: ContextTab } | null {
  try {
    return parseStoredContext(localStorage.getItem(CONTEXT_KEY));
  } catch {
    return null; // storage unavailable: the defaults stand
  }
}

// Seed BEFORE registering the effect so its first run never overwrites
// storage with the defaults (the state/settings.ts pattern).
const seed = readStored();
if (seed != null) {
  contextOpen.value = seed.open;
  contextTab.value = seed.tab;
}

effect(() => {
  const value = JSON.stringify({ open: contextOpen.value, tab: contextTab.value });
  try {
    localStorage.setItem(CONTEXT_KEY, value);
  } catch {
    /* private mode: keep the in-memory choice */
  }
});

export function contextShown(): boolean {
  if (!TASK_VIEWS.has(view.value)) return false;
  return narrowViewport.value ? contextSheetOpen.value : contextOpen.value && !focusReading.value;
}

export function showContext(tab: ContextTab): void {
  batch(() => {
    if (!TASK_VIEWS.has(view.peek())) view.value = "tasks";
    contextTab.value = tab;
    if (narrowViewport.peek()) {
      contextSheetOpen.value = true;
    } else {
      contextOpen.value = true;
      focusReading.value = false;
    }
  });
}

export function hideContext(): void {
  if (narrowViewport.peek()) contextSheetOpen.value = false;
  else contextOpen.value = false;
}

export function toggleContext(tab: ContextTab): void {
  if (contextShown() && contextTab.peek() === tab) hideContext();
  else showContext(tab);
}

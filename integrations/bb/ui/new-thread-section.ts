// bb does not expose root-compose placement, so remember only the section Cortex last requested.

const KEY = "cortex:new-thread-section";
export const REMEMBER_MS = 30 * 60 * 1000;
export type RememberedSection = { sectionId: string; at: number };

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function rememberComposeSection(sectionId: string, now = Date.now()): void {
  try {
    storage()?.setItem(KEY, JSON.stringify({ sectionId, at: now }));
  } catch {
    // A full or blocked session store only loses the convenience; the card then asks for the section.
  }
}

export function readComposeSection(now = Date.now()): RememberedSection | null {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<RememberedSection>;
    if (typeof value.sectionId !== "string" || typeof value.at !== "number" || now - value.at > REMEMBER_MS) {
      clearComposeSection();
      return null;
    }
    return { sectionId: value.sectionId, at: value.at };
  } catch {
    return null;
  }
}

export function clearComposeSection(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

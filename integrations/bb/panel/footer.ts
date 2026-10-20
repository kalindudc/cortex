import { useLayoutEffect, useState } from "react";

// bb's own markup, not an SDK contract: when it changes, the icon stays in the thread header.
/** The row under the prompt box that ends with the context circle. */
export const FOOTER_SELECTOR = "[data-follow-up-composer-footer]";
/** One thread pane; a split view has several. */
const PANE_SELECTOR = "[data-split-pane-id]";
const CIRCLE_SELECTOR = ':scope > button[aria-label^="Context window"]';

/** The right-hand group of the pane's composer footer, the one that ends with the context circle. */
function footerGroup(pane: ParentNode): HTMLElement | null {
  const group = pane.querySelector(FOOTER_SELECTOR)?.lastElementChild;
  return group instanceof HTMLElement ? group : null;
}

/**
 * Puts `node` in the right-hand group of the pane's composer footer, before
 * the context circle, and says whether it is there. A node already in that
 * group stays where it is, so another plugin that also keeps a node beside the
 * circle (Thread Spend) never makes the two move each other in a loop.
 */
export function placeInFooter(node: HTMLElement, pane: ParentNode): boolean {
  const group = footerGroup(pane);
  if (group === null) {
    node.remove();
    return false;
  }
  if (node.parentElement !== group) group.insertBefore(node, group.querySelector(CIRCLE_SELECTOR));
  return true;
}

/** Runs `check` now and after the pane changes, unless `settled` says the footer it last saw is still in place. */
function watchPane(pane: Element, settled: () => boolean, check: () => void): () => void {
  let frame = 0;
  const run = (): void => {
    frame = 0;
    check();
  };
  run();
  const observer = new MutationObserver(() => {
    // A streaming timeline changes the pane all the time: a settled footer costs one check,
    // and a search runs at most once a frame.
    if (!settled() && frame === 0) frame = requestAnimationFrame(run);
  });
  observer.observe(pane, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
}

/**
 * A node in the composer footer of the thread pane that holds `anchor`, kept
 * there as bb re-renders the footer; null when that pane shows no footer.
 */
export function useFooterMount(anchor: HTMLElement | null): HTMLElement | null {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const pane = anchor?.closest(PANE_SELECTOR) ?? null;
    if (pane === null) {
      setMount(null);
      return;
    }
    const node = document.createElement("span");
    node.setAttribute("data-cortex-memory-icon", "");
    node.className = "inline-flex shrink-0 items-center";
    const stop = watchPane(
      pane,
      () => node.isConnected && node.parentElement?.parentElement?.matches(FOOTER_SELECTOR) === true,
      () => setMount(placeInFooter(node, pane) ? node : null),
    );
    return () => {
      stop();
      node.remove();
    };
  }, [anchor]);
  return mount;
}

/** Whether the thread pane that holds `anchor` shows the composer footer that `useFooterMount` uses. */
export function useFooterPresent(anchor: HTMLElement | null): boolean {
  const [present, setPresent] = useState(false);
  useLayoutEffect(() => {
    const pane = anchor?.closest(PANE_SELECTOR) ?? null;
    if (pane === null) {
      setPresent(false);
      return;
    }
    let group: HTMLElement | null = null;
    return watchPane(
      pane,
      () => group?.isConnected === true,
      () => {
        group = footerGroup(pane);
        setPresent(group !== null);
      },
    );
  }, [anchor]);
  return present;
}

// APG tablist keyboard: Left/Right/Home/End move FOCUS among the tabs
// (roving tabindex, wrapping); Enter/Space ACTIVATE the focused tab (manual
// activation, so arrowing through never churns panels). The handler lives
// on the tablist so a tab that is not selected can still be focused and
// activated by keyboard. Shared by the document tabs and the side panel.
export function tablistKeyHandler(
  list: () => HTMLElement | null,
  activate: (index: number) => void,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent): void => {
    const host = list();
    if (!host) return;
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>("[role='tab']"));
    const idx = tabs.indexOf(e.target as HTMLButtonElement);
    if (idx === -1) return;
    let next = -1;
    if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault(); // a button would also click on keyup — activate once
      activate(idx);
      return;
    }
    if (next === -1) return;
    e.preventDefault();
    tabs[next].focus();
  };
}

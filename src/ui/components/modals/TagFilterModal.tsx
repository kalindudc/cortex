// Compatibility route for legacy modal.kind = "filter-tags" callers.
// There is no filtering dialog anymore: consume the request and reveal the
// canonical sidebar panel without ever mounting a second modal layer.
import { useLayoutEffect } from "preact/hooks";
import { revealSidebarFilter } from "../../state/workspace.ts";

export function TagFilterModal({ close }: { close: () => void }): null {
  useLayoutEffect(() => {
    close();
    revealSidebarFilter("tags");
  }, []);
  return null;
}

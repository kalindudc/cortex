import type { BbPluginApi } from "@get-bb/plugin-sdk";

export function registerSectionEvents(bb: BbPluginApi, publish: (sectionId: string) => void) {
  let titles = new Map<string, string>();
  const membership = new Map<string, string | null>();
  const rememberSections = (sections: readonly { id: string; name: string }[]) => {
    titles = new Map(sections.map(s => [s.id, s.name]));
  };
  const rememberThreads = (threads: readonly { id: string; sectionId: string | null }[]) => {
    for (const thread of threads) membership.set(thread.id, thread.sectionId);
  };
  const changedThread = ({ thread }: { thread: { id: string; sectionId: string | null } }) => {
    const affected = new Set([membership.get(thread.id), thread.sectionId]);
    membership.set(thread.id, thread.sectionId);
    for (const id of affected) if (id) publish(id);
  };
  for (const event of ["thread.created", "thread.archived", "thread.unarchived", "thread.deleted"] as const)
    bb.events.on(event, changedThread);
  const warn = (e: unknown) =>
    bb.log.warn(`Cortex section refresh failed; retry the section read: ${e instanceof Error ? e.message : String(e)}`);
  try {
    bb.onDispose(
      bb.sdk.subscribe({
        event: "system:changed",
        callback: async event => {
          if (!event.changes.includes("ui-preferences-changed")) return;
          try {
            const sections = await bb.sdk.threadSections.list();
            const next = new Map(sections.map(s => [s.id, s.name]));
            const affected = new Set([...titles.keys(), ...next.keys()]);
            for (const id of affected) if (titles.get(id) !== next.get(id)) publish(id);
            titles = next;
          } catch (e) {
            warn(e);
          }
        },
      }),
    );
    bb.onDispose(
      bb.sdk.subscribe({
        event: "thread:changed",
        callback: async event => {
          if (!event.id || !event.changes.includes("title-changed")) return;
          try {
            changedThread({ thread: await bb.sdk.threads.get({ threadId: event.id }) });
          } catch (e) {
            warn(e);
          }
        },
      }),
    );
  } catch (e) {
    warn(e);
  }
  return { rememberSections, rememberThreads };
}

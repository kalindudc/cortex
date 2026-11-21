import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Thread = { id: string; parentThreadId: string | null; lifecycleOwnerThreadId?: string | null };
const PAGE = 100;

/** Configure is synchronous and its context omits lifecycle ownership. */
export async function cacheMemoryThreadRoles(bb: BbPluginApi) {
  const starters = new Map<string, Set<string>>();
  const children = new Map<string, number>();
  const configured = new Map<string, boolean>();
  const observed = new Set<string>();
  let seeding = true;

  function remember(id: string, owners: Set<string>): void {
    for (const owner of starters.get(id) ?? []) {
      const count = (children.get(owner) ?? 1) - 1;
      if (count === 0) children.delete(owner);
      else children.set(owner, count);
    }
    if (owners.size > 0) starters.set(id, owners);
    else starters.delete(id);
    for (const owner of owners) children.set(owner, (children.get(owner) ?? 0) + 1);
  }

  const observe = ({ thread }: { thread: Thread }) => {
    if (seeding) observed.add(thread.id);
    const owners = new Set<string>();
    if (thread.parentThreadId) owners.add(thread.parentThreadId);
    if (thread.lifecycleOwnerThreadId) owners.add(thread.lifecycleOwnerThreadId);
    remember(thread.id, owners);
  };
  bb.events.on("thread.created", observe);
  bb.events.on("thread.active", observe);
  bb.events.on("thread.unarchived", observe);
  bb.events.on("experimental_thread.parentChanged", observe);
  bb.events.on("thread.archived", ({ thread }) => {
    configured.delete(thread.id);
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    if (seeding) observed.add(thread.id);
    remember(thread.id, new Set());
    configured.delete(thread.id);
  });

  const seed = async (archived: boolean) => {
    for (let offset = 0; ; offset += PAGE) {
      const page = await bb.sdk.threads.list({ archived, includeHidden: true, limit: PAGE, offset });
      for (const thread of page) if (!observed.has(thread.id)) observe({ thread });
      if (page.length < PAGE) return;
    }
  };
  const results = await Promise.allSettled([seed(false), seed(true)]);
  seeding = false;
  observed.clear();
  for (const result of results) {
    if (result.status === "rejected") bb.log.warn(`Cortex could not seed memory thread roles: ${String(result.reason)}`);
  }
  return {
    child(thread: Thread): boolean {
      return thread.parentThreadId !== null || (thread.lifecycleOwnerThreadId === undefined
        ? starters.has(thread.id) : thread.lifecycleOwnerThreadId !== null);
    },
    configure(threadId: string): boolean {
      const lead = children.has(threadId);
      configured.set(threadId, lead);
      return lead;
    },
    childLead(threadId: string): boolean {
      return configured.get(threadId) ?? children.has(threadId);
    },
  };
}

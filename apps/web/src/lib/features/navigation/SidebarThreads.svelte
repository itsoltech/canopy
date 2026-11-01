<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { needsYou, treeActivity } from "#lib/features/threads/activity.ts";
  import { isSide } from "#lib/features/threads/thread-tree.ts";
  import SidebarSideThread from "./SidebarSideThread.svelte";
  import SidebarThread from "./SidebarThread.svelte";

  /**
   * Thread inbox (T3 style): every main thread of every project, those that need you first (a side
   * thread asking its parent agent does not), then by latest activity in the tree. The open thread's
   * side threads unfold under it; others show a count. `query` filters by title and project.
   */
  let { currentThreadId, query = "", class: className }: { currentThreadId?: string | undefined; query?: string; class?: ClassValue } = $props();
  const overview = useOverview();

  const all = $derived([...overview.threads.values()]);
  const byId = $derived(new Map(all.map((t) => [t.id, t])));
  const sidesOf = $derived.by(() => {
    const map = new Map<string, ui.Thread[]>();
    for (const t of all) if (isSide(t) && byId.has(t.parentThreadId)) map.set(t.parentThreadId, [...(map.get(t.parentThreadId) ?? []), t]);
    return map;
  });
  const current = $derived(currentThreadId ? byId.get(currentThreadId) : undefined);
  const openTree = $derived(current ? (isSide(current) ? current.parentThreadId : current.id) : undefined);

  const byCreation = (a: ui.Thread, b: ui.Thread) => Number((a.createdAt?.seconds ?? 0n) - (b.createdAt?.seconds ?? 0n));
  const mains = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const projectName = (t: ui.Thread) => overview.project(t.projectId)?.name ?? "";
    return all
      .filter((t) => !(isSide(t) && byId.has(t.parentThreadId)))
      .filter((t) => !q || [t, ...(sidesOf.get(t.id) ?? [])].some((x) => x.title.toLowerCase().includes(q)) || projectName(t).toLowerCase().includes(q))
      .map((t) => {
        const tree = [t, ...(sidesOf.get(t.id) ?? [])];
        return { thread: t, attention: tree.some(needsYou), activity: treeActivity(tree) };
      })
      .sort((a, b) => Number(b.attention) - Number(a.attention) || Number(b.activity - a.activity))
      .map((entry) => entry.thread);
  });
</script>

<div class={className}>
  {#if mains.length === 0}
    <p class="px-3 py-2 text-sm/6 text-pretty text-zinc-500 dark:text-zinc-400">
      {#if query}No thread matches “{query}”.{:else if overview.connection === "unavailable"}Threads load once the gateway answers.{:else}No threads yet. Start one with the pencil above.{/if}
    </p>
  {:else}
    <ul role="list" class="grid gap-0.5">
      {#each mains as thread (thread.id)}
        {@const sides = sidesOf.get(thread.id) ?? []}
        <li>
          <SidebarThread
            {thread}
            project={overview.project(thread.projectId)}
            worker={overview.worker(thread.workerId)}
            sides={openTree === thread.id ? 0 : sides.length}
            current={thread.id === currentThreadId}
          />
          {#if openTree === thread.id && sides.length > 0}
            <ul role="list" aria-label="Side threads of {thread.title}" class="mt-0.5 mb-1 ml-5 grid gap-0.5 border-l border-zinc-950/10 pl-1.5 dark:border-white/10">
              {#each [...sides].sort(byCreation) as side (side.id)}
                <li><SidebarSideThread thread={side} current={side.id === currentThreadId} /></li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

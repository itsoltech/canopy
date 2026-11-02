<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { groupSideThreads, isSide } from "#lib/features/threads/thread-tree.ts";
  import PreviousAgents from "#lib/features/threads/components/PreviousAgents.svelte";
  import { expand, reorder, rise, stagger } from "#lib/shared/ui/motion.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import SidebarSideThread from "./SidebarSideThread.svelte";
  import SidebarThread from "./SidebarThread.svelte";
  import { sidebarThreads } from "./sidebar-threads.ts";
  import SidebarArchivedThreads from "./SidebarArchivedThreads.svelte";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import { ui as schemas } from "@open-agents/contracts";

  let { currentThreadId, query = "", class: className }: { currentThreadId?: string | undefined; query?: string; class?: ClassValue } = $props();
  const overview = useOverview();
  const settings = useSettings();
  const all = $derived([...overview.threads.values()]);
  let fetchedCurrent = $state.raw<ui.Thread>();
  const current = $derived((currentThreadId ? overview.threads.get(currentThreadId) : undefined) ?? (fetchedCurrent?.id === currentThreadId ? fetchedCurrent : undefined));
  $effect(() => {
    const id = currentThreadId;
    void overview.resyncs;
    let cancelled = false;
    fetchedCurrent = undefined;
    // An archived main is intentionally absent from the active overview, including on a direct URL.
    if (id) void requestJson("GET", `/api/threads/${encodeURIComponent(id)}`).then((response) => {
      if (!cancelled) fetchedCurrent = decode(schemas.GetThreadResponseSchema, response).thread;
    }).catch(() => undefined);
    return () => { cancelled = true; };
  });
  const openTree = $derived(current ? (isSide(current) ? current.parentThreadId : current.id) : undefined);
  const filtered = $derived(sidebarThreads(all, settings.sidebar, query, (id) => overview.project(id)?.name ?? ""));
  const rootIds = $derived(new Set(filtered.roots.map((t) => t.id)));
  type Entry = { key: string; thread?: ui.Thread; heading?: string };
  const entries = $derived.by(() => {
    const entries: Entry[] = [];
    let pinned = false;
    for (const thread of filtered.roots) {
      const pin = filtered.pins.has(thread.id);
      if (!entries.length && pin) entries.push({ key: "heading:pinned", heading: "Pinned" });
      if (pinned && !pin) entries.push({ key: "heading:threads", heading: "Threads" });
      entries.push({ key: thread.id, thread });
      pinned = pin;
    }
    return entries;
  });
</script>

<div class={["flex min-h-full flex-col", className]}>
  {#if filtered.roots.length === 0}
    <div class="grid justify-items-start gap-2 px-3 py-2">
      <p class="text-sm/6 text-pretty text-zinc-500 dark:text-zinc-400">
        {#if settings.sidebar.projectIds.length}No threads in the selected projects{:else if query}No thread matches “{query}”.{:else if overview.connection === "unavailable"}Threads load once the gateway answers.{:else}No threads yet. Start one with the pencil above.{/if}
      </p>
      {#if settings.sidebar.projectIds.length}<Button size="sm" variant="ghost" onclick={() => void settings.updateSidebar({ projectIds: [] })}>Clear filters</Button>{/if}
    </div>
  {:else}
    <ul role="list" class="grid gap-0.5" aria-label="Thread inbox">
      {#each entries as entry, index (entry.key)}
        <li animate:reorder in:rise={{ delay: stagger(index) }} out:expand>
          {#if entry.thread}
            {@const thread = entry.thread}
            {@const sides = groupSideThreads((filtered.sides.get(thread.id) ?? []).filter((t) => !rootIds.has(t.id)))}
            <div class="relative">
              <SidebarThread {thread} project={overview.project(thread.projectId)} worker={overview.worker(thread.workerId)} sides={openTree === thread.id ? 0 : sides.active.length} current={thread.id === currentThreadId} />
            </div>
            {#if openTree === thread.id && (sides.active.length || sides.previous.length)}
              <div class="mt-0.5 mb-1 ml-5 border-l border-zinc-950/10 pl-1.5 dark:border-white/10" transition:expand>
                <ul role="list" aria-label="Side threads of {thread.title}" class="grid gap-0.5">
                  {#each sides.active as side (side.id)}<li><SidebarSideThread thread={side} current={side.id === currentThreadId} /></li>{/each}
                </ul>
                <PreviousAgents threads={sides.previous}>
                  {#snippet row(side)}<SidebarSideThread thread={side} current={side.id === currentThreadId} previous />{/snippet}
                </PreviousAgents>
              </div>
            {/if}
          {:else}<h2 class="px-3 pt-3 pb-1 text-sm font-medium text-zinc-500 sm:text-xs dark:text-zinc-400">{entry.heading}</h2>{/if}
        </li>
      {/each}
    </ul>
  {/if}
  <SidebarArchivedThreads {current} {query} class="mt-auto" />
</div>

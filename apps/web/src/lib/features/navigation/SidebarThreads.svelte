<script lang="ts">
  import { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { groupSideThreads, isSide } from "#lib/features/threads/thread-tree.ts";
  import { expand, reorder, rise, stagger } from "#lib/shared/ui/motion.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import SidebarThreadChildren from "./SidebarThreadChildren.svelte";
  import SidebarThread from "./SidebarThread.svelte";
  import { sidebarThreads } from "./sidebar-threads.ts";
  import SidebarArchivedThreads from "./SidebarArchivedThreads.svelte";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import { whenIdle } from "#lib/shared/idle.ts";

  let {
    currentThreadId,
    query = "",
    class: className,
  }: { currentThreadId?: string | undefined; query?: string; class?: ClassValue } = $props();

  const overview = useOverview();
  const settings = useSettings();
  const all = $derived([...overview.threads.values()]);
  let fetchedCurrent = $state.raw<ui.Thread>();

  const current = $derived(
    (currentThreadId ? overview.threads.get(currentThreadId) : undefined) ??
      (fetchedCurrent?.id === currentThreadId ? fetchedCurrent : undefined),
  );

  $effect(() => {
    const id = currentThreadId;
    void overview.resyncs;
    let cancelled = false;
    fetchedCurrent = undefined;

    // An archived main is intentionally absent from the active overview, including on a direct URL.
    if (id)
      void requestJson("GET", `/api/threads/${encodeURIComponent(id)}`)
        .then((response) => {
          if (!cancelled) fetchedCurrent = decode(ui.GetThreadResponseSchema, response).thread;
        })
        .catch(() => undefined);

    return () => {
      cancelled = true;
    };
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

  // The each below animates reorders, so every update of its list measures all rows and forces a style and
  // layout pass. It iterates the order only, kept while unchanged; rows read their entry from the map, so a
  // thread update that keeps the order (or a settings write) leaves the list alone.
  let order: string[] = [];

  const keys = $derived.by(() => {
    const next = entries.map((entry) => entry.key);

    if (next.length !== order.length || next.some((key, at) => key !== order[at])) order = next;

    return order;
  });

  const byKey = $derived(new Map(entries.map((entry) => [entry.key, entry])));

  // About a screenful of rows renders with the list, the rest a few at a time when the browser is idle: the
  // frame that shows the sidebar does not also build every row's menu and preview card, and no chunk holds
  // input back for long. Rows the fill adds appear as they are.
  const FIRST_ROWS = 16;
  const ROWS_PER_IDLE = 4;
  let limit = $state(FIRST_ROWS);
  let filled = $state(false);

  $effect(() => {
    if (filled || keys.length === 0) return;

    if (keys.length <= limit) {
      filled = true;

      return;
    }

    return whenIdle(() => (limit += ROWS_PER_IDLE), 500);
  });

  const shown = $derived(filled ? keys : keys.slice(0, limit));
</script>

<div class={["flex min-h-full flex-col", className]}>
  {#if filtered.roots.length === 0}
    <div class="grid justify-items-start gap-2 px-3 py-2">
      <p class="text-sm/6 text-pretty text-zinc-500 dark:text-zinc-400">
        {#if settings.sidebar.projectIds.length}No threads in the selected projects.{:else if query}No thread matches “{query}”.{:else if overview.connection === "unavailable"}Threads
          appear when the gateway connects.{:else}No threads yet. Select New thread above to start one.{/if}
      </p>
      {#if settings.sidebar.projectIds.length}<Button
          size="sm"
          variant="ghost"
          onclick={() => void settings.updateSidebar({ projectIds: [] })}>Clear filters</Button
        >{/if}
    </div>
  {:else}
    <ul role="list" class="grid gap-0.5" aria-label="Thread inbox">
      {#each shown as key, index (key)}
        {@const entry = byKey.get(key)}
        <li animate:reorder in:rise={{ delay: stagger(index), instant: !filled }} out:expand>
          {#if entry?.thread}
            {@const thread = entry.thread}
            {@const sides = groupSideThreads((filtered.sides.get(thread.id) ?? []).filter((t) => !rootIds.has(t.id)))}
            <div class="relative">
              <SidebarThread
                {thread}
                project={overview.project(thread.projectId)}
                worker={overview.worker(thread.workerId)}
                sides={openTree === thread.id ? 0 : sides.active.length}
                current={thread.id === currentThreadId}
              />
            </div>
            {#if openTree === thread.id && (sides.active.length || sides.previous.length)}
              <SidebarThreadChildren {sides} title={thread.title} {currentThreadId} class="mt-0.5 mb-1 ml-5" />
            {/if}
          {:else if entry}<h2 class="px-3 pt-3 pb-1 text-sm font-medium text-zinc-500 sm:text-xs dark:text-zinc-400">
              {entry.heading}
            </h2>{/if}
        </li>
      {/each}
    </ul>
  {/if}
  <SidebarArchivedThreads {current} {query} class="mt-auto" />
</div>

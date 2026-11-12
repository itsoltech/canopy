<script lang="ts">
  import { ui } from "@canopy/contracts";
  import { expandProjectIds } from "@canopy/domain/projects";
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { isSide } from "@canopy/domain/thread-tree";
  import { expand, reorder, rise, stagger } from "#lib/shared/ui/motion.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import SidebarThreadChildren from "./SidebarThreadChildren.svelte";
  import SidebarThread from "./SidebarThread.svelte";
  import { sidebarThreads } from "@canopy/domain/sidebar-threads";
  import { sameSidebarRow, sidebarRows, type SidebarRow } from "@canopy/domain/sidebar-rows";
  import { Keyed } from "#lib/shared/keyed.svelte.ts";
  import SidebarArchivedThreads from "./SidebarArchivedThreads.svelte";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import { whenIdle } from "#lib/shared/idle.ts";
  import { sidebarEntries } from "@canopy/domain/sidebar-entries";

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

  const filterSettings = $derived({
    ...settings.sidebar,
    projectIds: expandProjectIds(settings.sidebar.projectIds, overview.projectChoices),
  });

  const filtered = $derived(
    sidebarThreads(all, filterSettings, query, (id) => {
      const choice = overview.projectChoice(id);

      return choice ? [choice.name, ...choice.aliases].join(" ") : "";
    }),
  );

  let workingOpen = $state(false);
  const entries = $derived(sidebarEntries(filtered, settings.sidebar, overview.projectChoices, workingOpen));

  // The each below animates reorders, so every update of its list measures all rows and forces a style and
  // layout pass. It iterates the order only, kept while unchanged; rows read their entry from the map, so a
  // thread update that keeps the order (or a settings write) leaves the list alone.
  let order: string[] = [];

  const keys = $derived.by(() => {
    const next = entries.map((entry) => entry.key);

    if (next.length !== order.length || next.some((key, at) => key !== order[at])) order = next;

    return order;
  });

  // Every event replaces the thread index, so a row reading the whole list would rerun with every event (hundreds of
  // rows). Each row reads only its own slot, written when something the row shows changed.
  const rows = new Keyed<SidebarRow>(sameSidebarRow);

  $effect.pre(() => {
    rows.sync(
      sidebarRows(entries, filtered, openTree, {
        project: (id) => overview.project(id),
        worker: (id) => overview.worker(id),
      }).map((row) => [row.key, row]),
    );
  });

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
    <div class="sidebar-row-padding grid justify-items-start gap-2 py-2">
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
        {@const entry = rows.get(key)}
        <li
          class={entry?.thread && "sidebar-entry"}
          animate:reorder
          in:rise={{ delay: stagger(index), instant: !filled }}
          out:expand
        >
          {#if entry?.thread}
            {@const { thread, sides } = entry}
            <div class="relative">
              <SidebarThread
                {thread}
                subagentsNeedingInput={entry.subagentsNeedingInput}
                project={entry.project}
                worker={entry.worker}
                sides={entry.open ? 0 : sides.active.length}
                current={thread.id === currentThreadId}
              />
            </div>
            {#if entry.open && (sides.active.length || sides.previous.length)}
              <SidebarThreadChildren {sides} title={thread.title} {currentThreadId} class="mt-0.5 mb-1 ml-5" />
            {/if}
          {:else if entry?.working}<Button
              size="sm"
              variant="ghost"
              aria-expanded={workingOpen}
              onclick={() => (workingOpen = !workingOpen)}
              icon={workingOpen ? "chevron-down" : "chevron-right"}>{entry.heading}</Button
            >
          {:else if entry}<h2
              class="sidebar-row-padding pt-3 pb-1 text-sm font-medium text-zinc-500 sm:text-xs dark:text-zinc-400"
            >
              {entry.heading}
            </h2>{/if}
        </li>
      {/each}
    </ul>
  {/if}
  <SidebarArchivedThreads {current} {query} class="mt-auto" />
</div>

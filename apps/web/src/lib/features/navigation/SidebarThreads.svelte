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
  import SidebarSnoozedThreads from "./SidebarSnoozedThreads.svelte";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import { whenIdle } from "#lib/shared/idle.ts";
  import { sidebarEntries } from "@canopy/domain/sidebar-entries";
  import { visibleSidebarEntries } from "@canopy/domain/sidebar-groups";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
  import { SidebarOrder, provideSidebarOrder } from "./sidebar-order.svelte.ts";
  import { sidebarDrag } from "./sidebar-drag.ts";
  import SidebarOrderFeedback from "./SidebarOrderFeedback.svelte";
  import SidebarGroupHeading from "./SidebarGroupHeading.svelte";
  import SidebarThreadDisclosure from "./SidebarThreadDisclosure.svelte";

  let {
    currentThreadId,
    query = "",
    workerIds,
    class: className,
  }: {
    currentThreadId?: string | undefined;
    query?: string;
    workerIds: readonly string[];
    class?: ClassValue;
  } = $props();

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

    // An archived main is intentionally absent from the active overview, including on a direct URL. The copy
    // fetched before stays until this one answers (`current` ignores another thread's): a refetch after a
    // resync would otherwise drop the archived card for a moment and bring it back.
    if (id)
      void requestJson("GET", `/api/threads/${encodeURIComponent(id)}`)
        .then((response) => {
          if (!cancelled) fetchedCurrent = decode(ui.GetThreadResponseSchema, response).thread;
        })
        .catch(() => {
          if (!cancelled) fetchedCurrent = undefined;
        });

    return () => {
      cancelled = true;
    };
  });

  const openTree = $derived(current ? (isSide(current) ? current.parentThreadId : current.id) : undefined);

  const filterSettings = $derived({
    ...settings.sidebar,
    projectIds: expandProjectIds(settings.sidebar.projectIds, overview.projectChoices),
    workerIds,
  });

  const hasFilters = $derived(settings.sidebar.projectIds.length > 0 || filterSettings.workerIds.length > 0);

  const clearFilters = () => devicePreferences.setView({ projectIds: [], ...(workerIds.length && { workerIds: [] }) });

  const filtered = $derived(
    sidebarThreads(
      all,
      filterSettings,
      query,
      (id) => {
        const choice = overview.projectChoice(id);

        return choice ? [choice.name, ...choice.aliases].join(" ") : "";
      },
      devicePreferences.view.threadSortMode,
    ),
  );

  let workingOpen = $state(false);

  const grouping = $derived({ groupByWorktree: devicePreferences.view.groupByWorktree });

  // Keep the Working rows available for the entire section outro.
  const entries = $derived(sidebarEntries(filtered, settings.sidebar, overview.projectChoices, true, grouping));
  const working = $derived(entries.find((entry) => entry.working));

  const visible = $derived(
    visibleSidebarEntries(entries, devicePreferences.view.collapsedSidebarGroups, Boolean(query.trim())),
  );

  const ordering = provideSidebarOrder(
    new SidebarOrder(
      overview,
      settings,
      () => entries,
      (id) =>
        sidebarEntries(
          { ...filtered, pins: new Set([...filtered.pins].filter((pin) => pin !== id)) },
          settings.sidebar,
          overview.projectChoices,
          workingOpen,
          grouping,
        ),
    ),
  );

  const drag = sidebarDrag(ordering);

  // The each below animates reorders, so every update of its list measures all rows and forces a style and
  // layout pass. It iterates the order only, kept while unchanged; rows read their entry from the map, so a
  // thread update that keeps the order (or a settings write) leaves the list alone.
  let order: string[] = [];

  const keys = $derived.by(() => {
    const next = visible.map((entry) => entry.key);

    if (next.length !== order.length || next.some((key, at) => key !== order[at])) order = next;

    return order;
  });

  const inboxLength = $derived(working ? keys.indexOf(working.key) : keys.length);
  const workingKeys = $derived(keys.slice(inboxLength + 1));

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

    if (inboxLength <= limit) {
      filled = true;

      return;
    }

    return whenIdle(() => (limit += ROWS_PER_IDLE), 500);
  });

  const shown = $derived(keys.slice(0, filled ? inboxLength : Math.min(inboxLength, limit)));
</script>

{#snippet renderRows(rowKeys: readonly string[], inbox: boolean)}
  {#each rowKeys as key, index (key)}
    {@const entry = rows.get(key)}
    <li
      class={["min-w-0", inbox && entry?.thread && "sidebar-entry"]}
      data-depth={entry?.depth}
      data-thread-id={entry?.thread?.id}
      data-grouped-project={entry?.groupedProject || undefined}
      animate:reorder
      in:rise={{ delay: inbox ? stagger(index) : 0, instant: !filled }}
      out:expand
      onoutrostart={(event) => (event.currentTarget.inert = true)}
      onintrostart={(event) => (event.currentTarget.inert = false)}
    >
      {#if entry?.thread}
        {@const { thread, sides } = entry}
        <div class="relative">
          <SidebarThread
            {thread}
            subagentsNeedingInput={entry.subagentsNeedingInput}
            project={entry.project}
            worker={entry.worker}
            groupedProject={entry.groupedProject}
            groupedWorktree={entry.depth === 2}
            sides={entry.open ? 0 : sides.active.length}
            current={thread.id === currentThreadId}
          />
        </div>
        {#if entry.open && (sides.active.length || sides.previous.length)}
          <SidebarThreadChildren {sides} title={thread.title} {currentThreadId} class="mt-0.5 mb-1 ml-5" />
        {/if}
      {:else if entry?.groupKind}<SidebarGroupHeading {entry} searching={Boolean(query.trim())} />
      {:else if entry}<h2
          class="sidebar-row-padding pt-3 pb-1 text-sm font-medium text-zinc-500 sm:text-xs dark:text-zinc-400"
        >
          {entry.heading}
        </h2>{/if}
    </li>
  {/each}
{/snippet}

<div class={["flex min-h-full min-w-0 flex-col", className]}>
  <SidebarOrderFeedback {ordering} />
  {#if filtered.roots.length === 0 && filtered.snoozed.length === 0}
    <div class="sidebar-row-padding grid justify-items-start gap-2 py-2">
      <p class="text-sm/6 text-pretty text-zinc-500 dark:text-zinc-400">
        {#if filterSettings.workerIds.length}No active or snoozed threads match these filters.{:else if settings.sidebar.projectIds.length}No
          threads in the selected projects.{:else if query}No thread matches “{query}”.{:else if overview.connection === "unavailable"}Threads
          appear when the gateway connects.{:else}No threads yet.{/if}
      </p>
      {#if hasFilters}<Button size="sm" variant="ghost" onclick={clearFilters}>Clear filters</Button>{/if}
    </div>
  {:else if filtered.roots.length}
    <ul role="list" class="grid min-w-0 grid-cols-1 gap-0.5" aria-label="Thread inbox" {@attach drag}>
      {@render renderRows(shown, true)}
      {#if working?.heading && shown.length === inboxLength}
        <li class="min-w-0">
          <SidebarThreadDisclosure
            label={working.heading}
            expanded={workingOpen}
            ontoggle={() => (workingOpen = !workingOpen)}
          >
            <ul role="list" aria-label="Working threads" class="grid min-w-0 grid-cols-1 gap-0.5">
              {@render renderRows(workingKeys, false)}
            </ul>
          </SidebarThreadDisclosure>
        </li>
      {/if}
    </ul>
  {/if}
  <SidebarSnoozedThreads
    threads={filtered.snoozed}
    sides={filtered.snoozedSides}
    {currentThreadId}
    {openTree}
    searching={Boolean(query.trim())}
  />
  <SidebarArchivedThreads {current} {query} {workerIds} class="mt-auto" />
</div>

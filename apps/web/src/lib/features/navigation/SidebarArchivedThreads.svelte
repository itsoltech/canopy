<script lang="ts">
  import { untrack } from "svelte";
  import { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import { expand, reorder, rise } from "#lib/shared/ui/motion.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import SidebarArchivedThread from "./SidebarArchivedThread.svelte";
  import { ArchivedThreadsPager, type ArchivedPageState } from "./archived-threads.ts";
  import { groupSideThreads } from "#lib/features/threads/thread-tree.ts";
  import SidebarThreadChildren from "./SidebarThreadChildren.svelte";
  import { collapsedArchivedThread } from "./sidebar-threads.ts";

  let { current, query, class: className }: { current?: ui.Thread | undefined; query: string; class?: ClassValue } = $props();
  const overview = useOverview();
  const settings = useSettings();
  const id = $props.id();
  const expanded = $derived(settings.sidebar.archivedExpanded);
  const sticky = $derived(collapsedArchivedThread(current, expanded, overview.threads, settings.sidebar.projectIds, query, (id) => overview.project(id)?.name ?? ""));
  const pager = new ArchivedThreadsPager(async (request) => {
    const params = new URLSearchParams({ q: request.query, pageToken: request.pageToken, countOnly: String(request.countOnly) });
    for (const id of request.projectIds) params.append("projectId", id);
    const before = overview.threads;
    const page = decode(ui.ListArchivedThreadsResponseSchema, await requestJson("GET", `/api/threads/archived?${params}`));
    overview.remember([...page.threads, ...page.sideThreads], before);
    return page;
  }, (next) => (pageState = next));
  let pageState: ArchivedPageState = $state.raw(pager.state);
  const roots = $derived(pageState.threads.map((thread) => overview.liveThread(thread)).filter((thread): thread is ui.Thread => !!thread && !thread.deletedAt && thread.status === "archived"));
  let revision = $state(0);

  // Refresh the same number of loaded pages after lifecycle/title/project changes. Reconnects also
  // invalidate cursors; generations in the pager discard responses for an old filter or disclosure.
  $effect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = overview.subscribe((update) => {
      if (update.change.case !== "thread" && update.change.case !== "project") return;
      clearTimeout(timer);
      timer = setTimeout(() => revision++, 100);
    });
    return () => { unsubscribe(); clearTimeout(timer); pager.dispose(); };
  });
  $effect(() => {
    const filter = { projectIds: [...settings.sidebar.projectIds], query };
    const open = expanded;
    void overview.resyncs;
    void revision;
    untrack(() => void pager.refresh(filter, open));
  });
  const retry = () => void pager.refresh({ projectIds: [...settings.sidebar.projectIds], query }, expanded);
  function outgoing(event: Event) {
    const node = event.currentTarget as HTMLElement;
    node.inert = true;
    node.ariaHidden = "true";
  }
  function incoming(event: Event) {
    const node = event.currentTarget as HTMLElement;
    node.inert = false;
    node.removeAttribute("aria-hidden");
  }
</script>

<section aria-label="Archived" data-archived-section data-sticky={sticky ? "true" : undefined}
  class={["pt-2", sticky && "sticky bottom-0 z-10 bg-zinc-50 pb-1 max-lg:bg-white dark:bg-zinc-950", className]}>
  <h2>
    <button type="button" aria-expanded={expanded} aria-controls={id} title={pageState.error || undefined} onclick={() => void settings.updateSidebar({ archivedExpanded: !expanded })}
      class="flex h-10 w-full items-center gap-1 rounded-lg px-3 text-sm font-medium text-zinc-500 hover:bg-zinc-950/4 focus-ring sm:h-9 sm:text-xs dark:text-zinc-400 dark:hover:bg-white/4">
      <span>Archived ·</span>
      <span class="min-w-6 text-left tabular-nums" aria-live="polite" aria-atomic="true" aria-label={pageState.totalCount === undefined ? "Loading archived count" : `${pageState.totalCount} archived threads`}>{pageState.totalCount ?? "–"}</span>
      <Icon name="chevron-right" class={["t-acc-chevron ml-auto fill-zinc-400 dark:fill-zinc-500", expanded && "rotate-90"]} />
    </button>
  </h2>
  <!-- Overlap the outgoing sticky card and the entering list so their heights never add together. -->
  <div {id} class="grid grid-cols-1">
    {#if expanded}
      <div class="col-start-1 row-start-1 min-w-0" transition:expand onoutrostart={outgoing} onintrostart={incoming}>
        <ul role="list" aria-label="Archived threads" aria-busy={pageState.loading} class="grid grid-cols-1 gap-0.5">
          {#each roots as thread (thread.id)}
            {@const sides = groupSideThreads(pageState.sideThreads.filter((side) => side.parentThreadId === thread.id))}
            <li class="min-w-0" animate:reorder in:rise out:expand>
              <SidebarArchivedThread {thread} current={current?.id === thread.id} />
              {#if sides.active.length || sides.previous.length}
                <SidebarThreadChildren {sides} title={thread.title} currentThreadId={current?.id} class="ml-5" />
              {/if}
            </li>
          {:else}
            {#if pageState.loading}
              {#each Array(Math.min(pageState.totalCount ?? 20, 20)) as _}<li aria-hidden="true" class="flex h-10 items-center px-3 sm:h-9"><Skeleton class="h-4 w-full" /></li>{/each}
            {:else if !pageState.error}<li class="px-3 py-2 text-sm/6 text-zinc-500 dark:text-zinc-400">No archived threads{query ? ` matching “${query}”` : ""}.</li>{/if}
          {/each}
        </ul>
        {#if pageState.nextPageToken}
          <div class="flex h-10 items-center px-1 sm:h-9"><Button variant="ghost" size="sm" disabled={pageState.loading} onclick={() => void pager.more()} class="w-full">{pageState.loading ? "Loading…" : "Load more"}</Button></div>
        {/if}
      </div>
    {:else if sticky}
      <div data-archived-current class="col-start-1 row-start-1 min-w-0" transition:rise onoutrostart={outgoing} onintrostart={incoming}><SidebarArchivedThread thread={sticky} current /></div>
    {/if}
  </div>
  {#if pageState.error && expanded}
    <div class="px-3 py-2 text-sm/6 text-zinc-500 dark:text-zinc-400"><p role="status">Could not load archived threads.</p><Button variant="ghost" size="sm" onclick={retry}>Retry</Button></div>
  {/if}
</section>

<script lang="ts">
  import { page } from "$app/state";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Composer from "#lib/features/threads/components/Composer.svelte";
  import InteractionCard from "#lib/features/threads/components/interactions/InteractionCard.svelte";
  import SideThreadDialog from "#lib/features/threads/components/SideThreadDialog.svelte";
  import ThreadPanel from "#lib/features/threads/components/ThreadPanel.svelte";
  import Timeline from "#lib/features/threads/components/Timeline.svelte";
  import { provideThreadDirectory } from "#lib/features/threads/thread-directory.ts";
  import { ThreadState } from "#lib/features/threads/thread-state.svelte.ts";
  import { isSide, treeOf } from "#lib/features/threads/thread-tree.ts";
  import { buildTimeline } from "#lib/features/threads/timeline.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import ProjectAvatar from "#lib/shared/ui/ProjectAvatar.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import { statusLook } from "#lib/shared/ui/status.ts";

  const threadId = $derived(page.params.threadId ?? "");
  const overview = useOverview();

  // A new ThreadState per thread id: navigating between threads of a tree starts clean.
  const view = $derived.by(() => {
    void threadId;
    return new ThreadState();
  });
  $effect(() => view.connect(threadId));

  const thread = $derived(view.thread);
  const worker = $derived(overview.worker(thread?.workerId ?? ""));
  const project = $derived(overview.project(thread?.projectId ?? ""));

  // The tree comes from the live thread index (side threads spawned by agents appear as they start);
  // this thread's own stream is fresher for itself.
  const threads = $derived.by(() => {
    const all = [...overview.threads.values()].filter((t) => t.projectId === thread?.projectId);
    if (!thread) return all;
    return all.some((t) => t.id === thread.id) ? all.map((t) => (t.id === thread.id ? thread : t)) : [...all, thread];
  });
  const tree = $derived(thread ? treeOf(threads, thread) : undefined);
  provideThreadDirectory({
    thread: (id) => threads.find((t) => t.id === id) ?? overview.threads.get(id),
    awaiting: (itemId) => view.pending.some((i) => i.itemId === itemId),
  });

  const rows = $derived(buildTimeline(view.entries, view.turns, view.notices, view.turnResults));
  const itemsById = $derived(new Map(view.entries.map((e) => [e.id, e.item])));
  const closed = $derived(!thread || thread.status === "failed" || thread.status === "archived");
  const working = $derived(view.running && thread?.status !== "waiting_input");

  const composerNote = $derived.by(() => {
    if (!thread) return undefined;
    if (thread.status === "failed") return "This thread failed to start and cannot take messages.";
    if (thread.status === "archived") return "This thread is archived.";
    if (worker && !worker.online) return `${worker.name} is offline. Messages wait and are delivered when it reconnects.`;
    if (thread.status === "creating") return "The thread is starting on the worker. Messages run once it is ready.";
    return undefined;
  });

  // Follow new content while the reader is at the end; otherwise offer a jump back.
  let scroller = $state<HTMLElement>();
  let content = $state<HTMLElement>();
  let atEnd = $state(true);
  const onscroll = () => {
    if (scroller) atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
  };
  const toEnd = (behavior: ScrollBehavior = "instant") => scroller?.scrollTo({ top: scroller.scrollHeight, behavior });
  $effect(() => {
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (atEnd) toEnd();
    });
    observer.observe(content);
    return () => observer.disconnect();
  });
  $effect(() => {
    void threadId;
    atEnd = true;
  });

  // Context panel: beside the chat on wide screens (remembered), a sheet on narrow ones.
  let panelOpen = $state(typeof localStorage === "undefined" || localStorage.getItem("oa-thread-panel") !== "closed");
  let panelSheet = $state(false);
  function togglePanel() {
    if (matchMedia("(min-width: 80rem)").matches) {
      panelOpen = !panelOpen;
      localStorage.setItem("oa-thread-panel", panelOpen ? "open" : "closed");
    } else panelSheet = true;
  }

  let sideOpen = $state(false);
  const canBranch = $derived(Boolean(tree && thread && thread.status !== "archived"));
  const openSide = () => {
    panelSheet = false;
    sideOpen = true;
  };
  const announcement = $derived(thread ? `Thread ${statusLook(thread.status).label.toLowerCase()}${view.pending.length > 0 ? `, ${view.pending.length} waiting for you` : ""}` : "");
</script>

<svelte:head><title>{thread?.title ?? "Thread"} · Open Agents</title></svelte:head>

<div class="flex h-full">
  <div class="flex min-w-0 flex-1 flex-col">
    <TopBar>
      {#if thread}
        <Crumb href={project ? `/settings/projects/${project.id}` : undefined}><ProjectAvatar name={project?.name ?? "?"} /><span class="truncate">{project?.name ?? "Project"}</span></Crumb>
        {#if tree && isSide(thread) && tree.main.id !== thread.id}
          <Crumb href="/threads/{tree.main.id}"><span class="truncate max-sm:hidden">{tree.main.title}</span><span class="sm:hidden">…</span></Crumb>
        {/if}
        <Crumb><span class="truncate">{thread.title}</span></Crumb>
      {:else}
        <Crumb><Skeleton class="h-4 w-48" /></Crumb>
      {/if}
      {#snippet actions()}
        <IconButton icon="view-columns" label="Thread details" aria-pressed={panelOpen} onclick={togglePanel} />
      {/snippet}
    </TopBar>

    {#if thread?.status === "failed" && thread.statusDetail}
      <Alert tone="error" banner title="The thread failed">{thread.statusDetail}</Alert>
    {/if}
    {#if view.connection === "reconnecting" && overview.connection !== "unavailable"}
      <Alert tone="info" banner>{view.failure ?? "Reconnecting to live updates…"}</Alert>
    {/if}

    <div class="relative min-h-0 flex-1">
      <div bind:this={scroller} {onscroll} class="h-full overflow-y-auto overscroll-contain" role="region" aria-label="Timeline" aria-busy={working}>
        <div bind:this={content} class="mx-auto max-w-3xl px-4 pt-2 pb-6 sm:px-6">
          {#if !view.loaded}
            <div class="grid gap-4" aria-label="Loading the timeline">
              <Skeleton class="ml-auto h-10 w-2/3" />
              <Skeleton class="h-4 w-full" />
              <Skeleton class="h-4 w-5/6" />
              <Skeleton class="h-8 w-1/2" />
              {#if view.connection === "connecting"}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Connecting…</p>{/if}
            </div>
          {:else if rows.length === 0 && view.queued.length === 0}
            <EmptyState
              icon={thread?.status === "creating" ? "arrow-path" : "sparkles"}
              title={thread?.status === "creating" ? "Starting the thread" : "No messages yet"}
              description={thread?.status === "creating" ? `Setting up the agent on ${worker?.name ?? "the worker"}.` : "Send the first message below to start a turn."}
              class="mt-8"
            />
          {:else}
            <Timeline {rows} queued={view.queued} {working} />
          {/if}
        </div>
      </div>
      {#if !atEnd}
        <div class="absolute bottom-3 left-1/2 -translate-x-1/2">
          <Button size="sm" icon="arrow-down" class="shadow-md" onclick={() => toEnd("smooth")}>Jump to latest</Button>
        </div>
      {/if}
    </div>

    <div class="mx-auto grid w-full max-w-3xl gap-3 px-4 pt-2 pb-[max(--spacing(3),env(safe-area-inset-bottom))] sm:px-6">
      {#if view.pending.length > 0}
        <div class="grid max-h-[45dvh] gap-3 overflow-y-auto p-px" role="region" aria-label="Waiting for you">
          {#each view.pending as interaction (interaction.requestId)}
            <InteractionCard {interaction} related={itemsById.get(interaction.itemId)} />
          {/each}
        </div>
      {/if}
      {#if thread}
        <Composer {thread} {worker} running={view.running} disabled={closed || !view.loaded} note={composerNote} />
      {:else}
        <Skeleton class="h-28 rounded-2xl" />
      {/if}
    </div>
  </div>

  {#if panelOpen}
    <aside class="w-80 shrink-0 overflow-y-auto py-3 pr-3 max-xl:hidden" aria-label="Thread details">
      {#if thread && tree}
        <ThreadPanel {thread} {tree} {worker} usage={view.usage} onnewside={canBranch ? openSide : undefined} />
      {:else}
        <Skeleton class="h-72 rounded-2xl" />
      {/if}
    </aside>
  {/if}
</div>

{#if thread && tree}
  <Dialog bind:open={panelSheet} title={thread.title}>
    <ThreadPanel {thread} {tree} {worker} usage={view.usage} onnewside={canBranch ? openSide : undefined} class="-mx-1.5 shadow-none ring-0 dark:ring-0" />
  </Dialog>
  <SideThreadDialog bind:open={sideOpen} main={tree.main} {worker} />
{/if}

<p class="sr-only" role="status">{announcement}</p>

<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { page } from "$app/state";
  import { useActiveProject } from "#lib/features/navigation/active-project.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { listProjectThreads } from "#lib/features/threads/api.ts";
  import Composer from "#lib/features/threads/components/Composer.svelte";
  import InteractionCard from "#lib/features/threads/components/interactions/InteractionCard.svelte";
  import SideThreadDialog from "#lib/features/threads/components/SideThreadDialog.svelte";
  import ThreadHeader from "#lib/features/threads/components/ThreadHeader.svelte";
  import ThreadTabs from "#lib/features/threads/components/ThreadTabs.svelte";
  import ThreadTree from "#lib/features/threads/components/ThreadTree.svelte";
  import Timeline from "#lib/features/threads/components/Timeline.svelte";
  import { provideThreadDirectory } from "#lib/features/threads/thread-directory.ts";
  import { ThreadState } from "#lib/features/threads/thread-state.svelte.ts";
  import { treeOf } from "#lib/features/threads/thread-tree.ts";
  import { buildTimeline } from "#lib/features/threads/timeline.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import { statusLook } from "#lib/shared/ui/status.ts";

  const threadId = $derived(page.params.threadId ?? "");
  const overview = useOverview();
  const active = useActiveProject();

  // A new ThreadState per thread id: navigating between threads of a tree starts clean.
  const view = $derived.by(() => {
    void threadId;
    return new ThreadState();
  });
  $effect(() => view.connect(threadId));

  const thread = $derived(view.thread);
  const worker = $derived(overview.worker(thread?.workerId ?? ""));
  const project = $derived(overview.project(thread?.projectId ?? ""));
  $effect(() => {
    active.fromThread = thread?.projectId;
    return () => (active.fromThread = undefined);
  });

  // Threads of the project for the tree: loaded once per project, then kept live by the overview
  // stream (status changes, side threads spawned by agents) and by this thread's own stream.
  let loaded = $state.raw<ui.Thread[]>([]);
  let treeError = $state<string | undefined>(undefined);
  const projectId = $derived(thread?.projectId ?? "");
  $effect(() => {
    if (!projectId) return;
    let cancelled = false;
    listProjectThreads(projectId).then(
      (threads) => {
        if (!cancelled) [loaded, treeError] = [threads, undefined];
      },
      (e: unknown) => {
        if (!cancelled) treeError = e instanceof Error ? e.message : String(e);
      },
    );
    return () => (cancelled = true);
  });
  const threads = $derived.by(() => {
    const live = overview.liveThreads(projectId, loaded);
    if (!thread) return live;
    return live.some((t) => t.id === thread.id) ? live.map((t) => (t.id === thread.id ? thread : t)) : [...live, thread];
  });
  const tree = $derived(thread ? treeOf(threads, thread) : undefined);
  provideThreadDirectory({
    thread: (id) => threads.find((t) => t.id === id),
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

  let sideOpen = $state(false);
  const canBranch = $derived(Boolean(tree && thread && thread.status !== "archived"));
  const announcement = $derived(thread ? `Thread ${statusLook(thread.status).label.toLowerCase()}${view.pending.length > 0 ? `, ${view.pending.length} waiting for you` : ""}` : "");
</script>

<svelte:head><title>{thread?.title ?? "Thread"} · Open Agents</title></svelte:head>

<div class="flex h-full">
  <div class="flex min-w-0 flex-1 flex-col">
    {#if thread}
      <ThreadHeader {thread} {project} main={tree?.main} {worker}>
        {#snippet actions()}
          {#if canBranch}
            <Button size="sm" icon="arrows-right-left" class="max-sm:hidden" onclick={() => (sideOpen = true)} aria-haspopup="dialog">New side thread</Button>
            <IconButton icon="arrows-right-left" label="New side thread" variant="secondary" size="sm" class="sm:hidden" onclick={() => (sideOpen = true)} aria-haspopup="dialog" />
          {/if}
        {/snippet}
      </ThreadHeader>
      {#if tree && tree.sides.length > 0}
        <ThreadTabs {tree} currentId={thread.id} class="border-t border-zinc-950/5 xl:hidden dark:border-white/5" />
      {/if}
    {:else}
      <div class="grid gap-2 px-4 pt-5 pb-4 sm:px-6" aria-hidden="true">
        <Skeleton class="h-4 w-24" />
        <Skeleton class="h-7 w-64" />
        <Skeleton class="h-4 w-80 max-w-full" />
      </div>
    {/if}

    <div class="border-t border-zinc-950/5 dark:border-white/5">
      {#if thread?.status === "failed" && thread.statusDetail}
        <Alert tone="error" banner title="The thread failed">{thread.statusDetail}</Alert>
      {/if}
      {#if view.connection === "reconnecting" && overview.connection !== "unavailable"}
        <Alert tone="info" banner>{view.failure ?? "Reconnecting to live updates…"}</Alert>
      {/if}
    </div>

    <div class="relative min-h-0 flex-1">
      <div bind:this={scroller} {onscroll} class="h-full overflow-y-auto overscroll-contain" role="region" aria-label="Timeline" aria-busy={working}>
        <div bind:this={content} class="mx-auto max-w-3xl px-4 py-6 sm:px-6">
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

    <div class="border-t border-zinc-950/5 bg-white/80 backdrop-blur-sm dark:border-white/5 dark:bg-zinc-950/80">
      <div class="mx-auto grid max-w-3xl gap-3 px-4 pt-3 pb-[max(--spacing(3),env(safe-area-inset-bottom))] sm:px-6">
        {#if view.pending.length > 0}
          <div class="grid max-h-[45dvh] gap-3 overflow-y-auto p-px" role="region" aria-label="Waiting for you">
            {#each view.pending as interaction (interaction.requestId)}
              <InteractionCard {interaction} related={itemsById.get(interaction.itemId)} />
            {/each}
          </div>
        {/if}
        <Composer {threadId} running={view.running} disabled={closed || !view.loaded} note={composerNote} prominent={view.pending.length === 0} />
      </div>
    </div>
  </div>

  <aside class="w-72 shrink-0 overflow-y-auto border-l border-zinc-950/5 max-xl:hidden dark:border-white/5" aria-label="Thread tree">
    <div class="p-4">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Threads</h2>
      </div>
      {#if tree && thread}
        <ThreadTree {tree} currentId={thread.id} class="mt-2" />
        {#if tree.sides.length === 0}
          <p class="mt-3 text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">
            Side threads run next to the main thread in the same directory: a review, an experiment, a parallel task. Agents can start them too.
          </p>
        {/if}
        {#if canBranch}
          <Button size="sm" icon="plus" class="mt-3" onclick={() => (sideOpen = true)} aria-haspopup="dialog">New side thread</Button>
        {/if}
        {#if treeError}<Alert tone="warning" class="mt-3">{treeError}</Alert>{/if}
      {:else}
        <div class="mt-2 grid gap-2" aria-hidden="true">
          <Skeleton class="h-6 w-full" />
          <Skeleton class="ml-4 h-6 w-5/6" />
        </div>
      {/if}
    </div>
  </aside>
</div>

{#if tree}
  <SideThreadDialog bind:open={sideOpen} main={tree.main} {worker} />
{/if}

<p class="sr-only" role="status">{announcement}</p>

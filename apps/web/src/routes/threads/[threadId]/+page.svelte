<script lang="ts">
  import { ui } from "@open-agents/contracts";
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import GoalBar from "#lib/features/goals/GoalBar.svelte";
  import GoalDialog from "#lib/features/goals/GoalDialog.svelte";
  import SetGoalPill from "#lib/features/goals/SetGoalPill.svelte";
  import { isFinishedGoal, showsGoal, takesGoals } from "#lib/features/goals/goals.ts";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import ScheduleDialog from "#lib/features/schedules/ScheduleDialog.svelte";
  import BackgroundTasksChip from "#lib/features/threads/components/BackgroundTasksChip.svelte";
  import Composer from "#lib/features/threads/components/Composer.svelte";
  import FeedRowView from "#lib/features/threads/components/FeedRowView.svelte";
  import InteractionCard from "#lib/features/threads/components/interactions/InteractionCard.svelte";
  import SideThreadDialog from "#lib/features/threads/components/SideThreadDialog.svelte";
  import ThreadModelDialog from "#lib/features/threads/components/ThreadModelDialog.svelte";
  import ThreadPermissionsDialog from "#lib/features/threads/components/ThreadPermissionsDialog.svelte";
  import ThreadPanel from "#lib/features/threads/components/ThreadPanel.svelte";
  import TimelineSkeleton from "#lib/features/threads/components/TimelineSkeleton.svelte";
  import { provideThreadDirectory } from "#lib/features/threads/thread-directory.ts";
  import { ThreadState, type TimelineEntry } from "#lib/features/threads/thread-state.svelte.ts";
  import { isSide, treeOf } from "#lib/features/threads/thread-tree.ts";
  import { topLevelEntry } from "#lib/features/threads/timeline.ts";
  import { FeedBuilder, feedEstimate, feedGroup, type FeedRow } from "#lib/features/threads/feed.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import MenuSub from "#lib/shared/ui/MenuSub.svelte";
  import ProjectAvatar from "#lib/shared/ui/ProjectAvatar.svelte";
  import GrowIn from "#lib/shared/ui/GrowIn.svelte";
  import { rise } from "#lib/shared/ui/motion.ts";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import VirtualFeed from "#lib/shared/ui/virtual/VirtualFeed.svelte";
  import { statusLook } from "#lib/shared/ui/status.ts";
  import { decode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
  const threadId = $derived(page.params.threadId ?? "");
  const overview = useOverview();
  const settings = useSettings();

  // A new ThreadState per thread id: navigating between threads of a tree starts clean, seeded with the
  // thread from GetThread so the header and composer render before the stream's snapshot (and, on a full
  // page load, with the end of the timeline, so the server renders the latest messages).
  // Only the thread id recreates it: a later `data` refresh (form actions invalidate) must not reconnect.
  const view = $derived.by(() => {
    const seed = untrack(() => (data.thread ? decode(ui.ThreadSchema, data.thread) : undefined));
    const tail = untrack(() => (data.tail ? decode(ui.ThreadSnapshotSchema, data.tail) : undefined));
    return seed?.id === threadId ? new ThreadState(seed, tail?.thread?.id === threadId ? tail : undefined) : new ThreadState();
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
    get currentId() {
      return threadId;
    },
    thread: (id) => threads.find((t) => t.id === id) ?? overview.threads.get(id),
    awaiting: (itemId) => view.pending.some((i) => i.itemId === itemId),
    goal: (id) => (view.goal?.id === id ? view.goal : undefined),
  });

  const parent = $derived(thread?.parentThreadId ? threads.find((t) => t.id === thread.parentThreadId) : undefined);
  const itemsById = $derived(new Map(view.ownEntries.map((e) => [e.id, e.item])));
  const closed = $derived(!thread || thread.status === "failed" || thread.status === "archived");
  const working = $derived(view.running && thread?.status !== "waiting_input");

  // The feed: inherited history (folded), the thread's own timeline, the working indicator, queued
  // inputs. One builder per thread keeps unchanged rows identical, so a delta re-renders one row.
  let historyOpen = $state(false);
  const builder = $derived((void threadId, new FeedBuilder()));
  const rows = $derived(
    builder.build({
      entries: view.ownEntries,
      turns: view.ownTurns,
      notices: view.notices,
      results: view.turnResults,
      queued: view.queued,
      steering: view.steering,
      steers: view.steers,
      working,
      forkSourceId: thread?.forkSourceThreadId,
      inheritedEntries: view.inheritedEntries,
      inheritedTurns: view.inheritedTurns,
      historyOpen,
    }),
  );
  $effect(() => {
    void threadId;
    historyOpen = false;
  });

  const composerNote = $derived.by(() => {
    if (!thread) return undefined;
    if (thread.status === "failed") return "This thread failed to start and cannot take messages.";
    if (thread.status === "archived") return "This thread is archived.";
    if (worker && !worker.online) return `${worker.name} is offline. Messages wait and are delivered when it reconnects.`;
    if (thread.status === "creating") return "The thread is starting on the worker. Messages run once it is ready.";
    return undefined;
  });

  // Context panel: beside the chat on wide screens (open or collapsed, saved in your settings), a sheet
  // on narrow ones.
  const panelOpen = $derived(!settings.appearance.threadPanelCollapsed);
  let panelSheet = $state(false);
  function togglePanel() {
    if (matchMedia("(min-width: 80rem)").matches) void settings.updateAppearance({ threadPanelCollapsed: panelOpen });
    else panelSheet = true;
  }

  let sideOpen = $state(false);
  const canBranch = $derived(Boolean(tree && thread && thread.status !== "archived"));
  const openSide = () => {
    panelSheet = false;
    sideOpen = true;
  };
  let scheduling = $state(false);
  const canSchedule = $derived(Boolean(thread && thread.status !== "archived" && thread.status !== "failed"));
  const openSchedule = () => {
    panelSheet = false;
    scheduling = true;
  };
  let modelOpen = $state(false);
  let permissionsOpen = $state(false);

  // Goal: the bar above the composer (an open goal, or an achieved one until dismissed in this tab), set
  // or replaced from the thread's actions or the composer.
  let goalDialog = $state(false);
  let dismissedGoals = $state(new Set<string>());
  // A gateway thread has no harness goals: no goal controls at all.
  const goalsHere = $derived(Boolean(thread && takesGoals(thread)));
  const canGoal = $derived(Boolean(thread && goalsHere && !closed && thread.status !== "creating"));
  const openGoal = $derived(view.goal && !isFinishedGoal(view.goal.status) ? view.goal : undefined);
  const shownGoal = $derived(showsGoal(view.goal, dismissedGoals) ? view.goal : undefined);
  const setGoalLater = () => {
    panelSheet = false;
    goalDialog = true;
  };

  // "N running in background" jumps to the task's row (a nested task: the row of the item it is under).
  let feed = $state<{ reveal: (key: string) => Promise<boolean> }>();
  const jumpTo = (task: TimelineEntry) => void feed?.reveal(`item:${topLevelEntry(view.ownEntries, task).id}`);
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast("Copied");
    } catch {
      toast("Copying is not allowed here", { tone: "error" });
    }
  }
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
        {#if thread}
          <DropdownMenu label="Thread actions" placement="bottom-end">
            {#snippet trigger(props)}<IconButton icon="ellipsis-horizontal" label="Thread actions" {...props} />{/snippet}
            <MenuItem icon="arrows-right-left" disabled={!canBranch} onselect={openSide}>New side thread</MenuItem>
            <MenuItem icon="clock" disabled={!canSchedule} onselect={openSchedule}>Schedule a task</MenuItem>
            <MenuItem icon="cpu-chip" disabled={closed} onselect={() => (modelOpen = true)}>Model and effort…</MenuItem>
            <MenuItem icon="shield-check" disabled={closed} onselect={() => (permissionsOpen = true)}>Permissions…</MenuItem>
            {#if goalsHere}
              <MenuItem icon="flag" disabled={!canGoal} onselect={setGoalLater}>{openGoal ? "Replace the goal…" : "Set a goal…"}</MenuItem>
            {/if}
            <MenuSeparator />
            <MenuSub label="Copy" icon="document-duplicate">
              <MenuItem onselect={() => copy(page.url.href)}>Link</MenuItem>
              <MenuItem onselect={() => copy(thread.cwd)}>Working directory</MenuItem>
              <MenuItem onselect={() => copy(thread.id)}>Thread ID</MenuItem>
            </MenuSub>
          </DropdownMenu>
        {/if}
        <IconButton icon="view-columns" label="Thread details" aria-pressed={panelOpen} onclick={togglePanel} />
      {/snippet}
    </TopBar>

    {#if thread?.status === "failed" && thread.statusDetail}
      <Alert tone="error" banner title="The thread failed">{thread.statusDetail}</Alert>
    {/if}
    {#if view.connection === "reconnecting" && overview.connection !== "unavailable"}
      <Alert tone="info" banner>{view.failure ?? "Reconnecting to live updates…"}</Alert>
    {/if}

    <div class="min-h-0 flex-1">
      {#key threadId}
        <VirtualFeed bind:this={feed} {rows} key={(row: FeedRow) => row.key} group={feedGroup} estimate={feedEstimate} label="Timeline" busy={working}>
          {#snippet placeholder()}
            {#if !view.loaded}<TimelineSkeleton connecting={view.connection === "connecting"} />{/if}
          {/snippet}
          {#snippet top()}
            {#if view.loaded && rows.length === 0}
              <EmptyState
                icon={thread?.status === "creating" ? "arrow-path" : "sparkles"}
                title={thread?.status === "creating" ? "Starting the thread" : "No messages yet"}
                description={thread?.status === "creating" ? `Setting up the agent on ${worker?.name ?? "the worker"}.` : "Send the first message below to start a turn."}
                class="mt-8"
              />
            {/if}
          {/snippet}
          {#snippet row(row: FeedRow)}
            <FeedRowView {row} ontoggle={() => (historyOpen = !historyOpen)} />
          {/snippet}
          {#snippet footer()}
            <!-- What comes and goes above the composer grows in and out (each carries its own gap below). -->
            <div class="grid grid-cols-1 pt-2">
              {#if view.pending.length > 0}
                <GrowIn class="pb-3">
                  <div class="grid max-h-[40dvh] gap-3 overflow-y-auto p-px" role="region" aria-label="Waiting for you">
                    {#each view.pending as interaction (interaction.requestId)}
                      <div in:rise><InteractionCard {interaction} related={itemsById.get(interaction.itemId)} {parent} /></div>
                    {/each}
                  </div>
                </GrowIn>
              {/if}
              {#if thread && shownGoal}
                <GrowIn class="pb-3">
                  <GoalBar
                    goal={shownGoal}
                    provider={thread.provider}
                    threadId={thread.id}
                    disabled={closed}
                    onchange={(goal) => view.upsertGoal(goal)}
                    ondismiss={() => (dismissedGoals = new Set(dismissedGoals).add(shownGoal.id))}
                  />
                </GrowIn>
              {/if}
              {#if view.backgroundTasks.length > 0}
                <GrowIn class="justify-self-start pb-3">
                  <BackgroundTasksChip tasks={view.backgroundTasks} onjump={jumpTo} />
                </GrowIn>
              {/if}
              {#if thread}
                <Composer
                  {thread}
                  {worker}
                  running={view.running}
                  disabled={closed || !view.loaded}
                  note={composerNote}
                  onsent={(response) => {
                    if (response.steer) view.upsertSteer(response.steer);
                  }}
                >
                  {#snippet leading()}
                    {#if canGoal && !openGoal}
                      <SetGoalPill onclick={() => (goalDialog = true)} />
                    {/if}
                  {/snippet}
                </Composer>
              {:else}
                <Skeleton class="h-28 rounded-2xl" />
              {/if}
            </div>
          {/snippet}
        </VirtualFeed>
      {/key}
    </div>
  </div>

  {#if panelOpen}
    <aside class="w-80 shrink-0 overflow-y-auto py-3 pr-3 max-xl:hidden" aria-label="Thread details">
      {#if thread && tree}
        <ThreadPanel
          {thread}
          {tree}
          {worker}
          usage={view.usage}
          totals={view.totals}
          schedules={view.upcomingSchedules}
          onschedule={canSchedule ? openSchedule : undefined}
          onschedulechange={(schedule) => view.upsertSchedule(schedule)}
          onnewside={canBranch ? openSide : undefined}
        />
      {:else}
        <Skeleton class="h-72 rounded-2xl" />
      {/if}
    </aside>
  {/if}
</div>

{#if thread && tree}
  <Dialog bind:open={panelSheet} title={thread.title}>
    <ThreadPanel
      {thread}
      {tree}
      {worker}
      usage={view.usage}
      totals={view.totals}
      schedules={view.upcomingSchedules}
      onschedule={canSchedule ? openSchedule : undefined}
      onschedulechange={(schedule) => view.upsertSchedule(schedule)}
      onnewside={canBranch ? openSide : undefined}
      class="-mx-1.5 shadow-none ring-0 dark:ring-0"
    />
  </Dialog>
  <SideThreadDialog bind:open={sideOpen} main={tree.main} {worker} />
  <ThreadModelDialog bind:open={modelOpen} {thread} {worker} />
  <ThreadPermissionsDialog bind:open={permissionsOpen} {thread} />
  <GoalDialog bind:open={goalDialog} threadId={thread.id} provider={thread.provider} current={view.goal} onset={(goal) => view.upsertGoal(goal)} />
  <ScheduleDialog bind:open={scheduling} threadId={thread.id} oncreated={(schedule) => view.upsertSchedule(schedule)} />
{/if}

<p class="sr-only" role="status">{announcement}</p>

<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { InteractionKind, ItemStatus, Provider, ui } from "@canopy/contracts";
  import { tick, untrack } from "svelte";
  import { page } from "$app/state";
  import LiveText from "#lib/shared/ui/LiveText.svelte";
  import { goto } from "$app/navigation";
  import { contributeCommands } from "#lib/features/commands/commands.svelte.ts";
  import { requestThreadInterrupt, threadCommands } from "#lib/features/threads/thread-commands.ts";
  import { composerAvailability } from "#lib/features/threads/thread-availability.ts";
  import GoalBar from "#lib/features/goals/GoalBar.svelte";
  import GoalDialog from "#lib/features/goals/GoalDialog.svelte";
  import CiteLayer from "#lib/features/quotes/CiteLayer.svelte";
  import { isFinishedGoal, showsGoal, takesGoals } from "#lib/features/goals/goals.ts";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import WorktreeManagement from "#lib/features/worktrees/WorktreeManagement.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import ScheduleDialog from "#lib/features/schedules/ScheduleDialog.svelte";
  import ScheduleOrigin from "#lib/features/schedules/ScheduleOrigin.svelte";
  import BackgroundTasksChip from "#lib/features/threads/components/BackgroundTasksChip.svelte";
  import BackgroundTaskDialog from "#lib/features/threads/components/BackgroundTaskDialog.svelte";
  import { backgroundTasks, backgroundName } from "#lib/features/threads/background-tasks.ts";
  import { provideBackgroundOutput } from "#lib/features/threads/background-output.ts";
  import Composer from "#lib/features/threads/components/Composer.svelte";
  import { ComposerCompaction, type ComposerActivity } from "#lib/features/threads/components/composer-compaction.ts";
  import type { ReaderScroll } from "#lib/shared/ui/virtual/scroll.ts";
  import FeedRowView from "#lib/features/threads/components/FeedRowView.svelte";
  import PendingDecisions from "#lib/features/threads/components/interactions/PendingDecisions.svelte";
  import ThreadSecretsPanel from "#lib/features/threads/components/secrets/ThreadSecretsPanel.svelte";
  import ThreadModelDialog from "#lib/features/threads/components/ThreadModelDialog.svelte";
  import ThreadPermissionsDialog from "#lib/features/threads/components/ThreadPermissionsDialog.svelte";
  import ThreadPanel from "#lib/features/threads/components/ThreadPanel.svelte";
  import PullRequestPanel from "#lib/features/github/PullRequestPanel.svelte";
  import QueuePanel from "#lib/features/threads/queue/QueuePanel.svelte";
  import { QueueState } from "#lib/features/threads/queue/queue-state.svelte.ts";
  import SubagentsPanel from "#lib/features/threads/subagents/SubagentsPanel.svelte";
  import { retainSubagents, subagentsOf } from "#lib/features/threads/subagents/subagents.ts";
  import { subagentPresence } from "#lib/features/threads/subagents/subagent-motion.ts";
  import SubagentOrigin from "#lib/features/threads/components/SubagentOrigin.svelte";
  import TimelineSkeleton from "#lib/features/threads/components/TimelineSkeleton.svelte";
  import { forkFrom, lastForkPoint } from "#lib/features/threads/fork.svelte.ts";
  import { providePageDirectory } from "#lib/features/threads/page-directory.ts";
  import { ThreadRewind, provideThreadRewind } from "#lib/features/threads/rewind-state.svelte.ts";
  import { openThreadMemory, threadViews } from "#lib/features/threads/thread-views.ts";
  import { retainTree, treeOf } from "#lib/features/threads/thread-tree.ts";
  import { topLevelEntry } from "#lib/features/threads/timeline.ts";
  import type { FoldReader } from "#lib/features/threads/work-folds.svelte.ts";
  import { syncWorkFolds, workHistoryPrefetch } from "#lib/features/threads/thread-feed-effects.svelte.ts";
  import { threadScrollMemory } from "#lib/features/threads/thread-scroll-memory.svelte.ts";
  import { feedEstimate, feedGroup, feedInserted, type FeedRow } from "#lib/features/threads/feed.ts";
  import TurnRail from "#lib/features/threads/rail/TurnRail.svelte";
  import { railTurns } from "#lib/features/threads/rail/turn-rail.ts";
  import type { FeedViewport } from "#lib/shared/ui/virtual/viewport.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import MenuSub from "#lib/shared/ui/MenuSub.svelte";
  import ProjectMark from "#lib/shared/ui/ProjectMark.svelte";
  import { FileIntake, provideFileIntake } from "#lib/features/attachments/file-intake.svelte.ts";
  import FileDropOverlay from "#lib/features/attachments/FileDropOverlay.svelte";
  import GrowIn from "#lib/shared/ui/GrowIn.svelte";
  import { duration } from "#lib/shared/ui/motion.ts";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import VirtualFeed from "#lib/shared/ui/virtual/VirtualFeed.svelte";
  import { trackSeen } from "#lib/features/threads/seen.svelte.ts";
  import { statusLook } from "#lib/shared/ui/status.ts";
  import { decode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";
  import ThreadComposerSlot from "#lib/features/threads/components/ThreadComposerSlot.svelte";
  import ThreadSyncStatus from "#lib/features/threads/components/ThreadSyncStatus.svelte";
  import ThreadSyncProgress from "#lib/features/threads/components/ThreadSyncProgress.svelte";
  import ThreadWatchNotice from "#lib/features/threads/components/ThreadWatchNotice.svelte";
  import ThreadMenuItems from "#lib/features/threads/components/ThreadMenuItems.svelte";
  import ThreadSearch from "#lib/features/threads/components/ThreadSearch.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import ComputerAwayBar from "#lib/features/computers/ComputerAwayBar.svelte";
  import { awayReason } from "#lib/features/computers/computers.ts";
  import { ThreadWorkspace } from "#lib/features/workspace/thread-workspace.svelte.ts";
  import WorkspaceTabs from "#lib/features/workspace/WorkspaceTabs.svelte";
  import WorkspaceFilesToggle from "#lib/features/workspace/WorkspaceFilesToggle.svelte";
  import WorkspaceContent from "#lib/features/workspace/WorkspaceContent.svelte";
  import WorkspaceFilesPanel from "#lib/features/workspace/WorkspaceFilesPanel.svelte";
  import ThreadSummary from "#lib/features/threads/summary/ThreadSummary.svelte";
  import { SummaryLayout } from "#lib/features/threads/summary/summary-layout.svelte.ts";
  import WorkspaceFrame from "#lib/features/workspace/WorkspaceFrame.svelte";
  import type { WorkspaceModuleTarget } from "@canopy/domain/workspace-modules";
  import { devicePreferences as device } from "#lib/features/settings/device-preferences.svelte.ts";

  let { data }: PageProps = $props();
  const threadId = $derived(page.params.threadId ?? "");
  const overview = useOverview();
  const settings = useSettings();
  const workspaceState = new ThreadWorkspace(() => threadId);
  const fileTab = $derived(workspaceState.current);

  // Recently opened threads keep their client state (items, older pages, folds, row heights): a return shows it
  // as it was left and syncs only what changed. A first open is seeded with the thread from GetThread so the header
  // and composer render before the stream. Only the thread id selects it: a later `data` refresh (form actions
  // invalidate) must not reconnect.
  const memory = $derived(
    openThreadMemory(
      threadId,
      untrack(() => (data.thread ? decode(ui.ThreadSchema, data.thread) : undefined)),
    ),
  );

  const view = $derived(memory.view);

  $effect(() => {
    const id = threadId;
    const current = memory.view;
    const hide = threadViews.show(id);
    const disconnect = current.connect(id);

    return () => {
      disconnect();
      hide();
    };
  });

  const thread = $derived(view.thread);

  $effect(() => {
    if (thread?.deletedAt) void goto("/");
  });

  // An old link of a thread that moved to another computer: the gateway follows the move; open its new id (stage 8).
  $effect(() => {
    if (!thread || thread.id === threadId || thread.id.split("~")[0] !== threadId.split("~")[0]) return;
    // toast reads and changes its reactive queue; it must not become a dependency of this redirect.
    untrack(() => {
      toast(`Moved to ${overview.machine(thread.nodeId) ?? "this computer"}`);
      void goto(`/threads/${thread.id}`, { replaceState: true });
    });
  });

  // A linked computer's project and worker leave the overview while it is away; the open thread keeps their names.
  interface Known {
    project?: ui.Project;
    worker?: ui.Worker;
  }

  let known: Known = {};

  const worker = $derived(
    overview.worker(thread?.workerId ?? "") ?? (known.worker?.id === thread?.workerId ? known.worker : undefined),
  );

  const project = $derived(
    overview.project(thread?.projectId ?? "") ?? (known.project?.id === thread?.projectId ? known.project : undefined),
  );

  $effect(() => {
    known = { ...(project && { project }), ...(worker && { worker }) };
  });

  // A thread whose home is a linked computer: read and driven there, unusable while that computer is away.
  const away = $derived(thread?.nodeId ? awayReason(overview.computer(thread.nodeId)) : undefined);

  // The tree comes from the live thread index (side threads spawned by agents appear as they start);
  // this thread's own stream is fresher for itself.
  const threads = $derived.by(() => {
    const all = [...overview.threads.values()].filter((t) => t.projectId === thread?.projectId);

    if (!thread) return all;

    return all.some((t) => t.id === thread.id) ? all.map((t) => (t.id === thread.id ? thread : t)) : [...all, thread];
  });

  // The tree and the subagents keep their value while an event elsewhere leaves them unchanged.
  const [keepTree, keepSubagents] = [retainTree(), retainSubagents()];
  const tree = $derived(keepTree(thread ? treeOf(threads, thread) : undefined));

  const rewind = $derived((void threadId, new ThreadRewind()));

  provideThreadRewind(() => rewind);

  $effect(() => {
    const current = rewind;

    return () => current.dispose();
  });

  providePageDirectory(
    () => ({ id: threadId, view, readOnly: Boolean(away), canFork }),
    (id) => (id === thread?.id ? thread : overview.threads.get(id)),
    (quote) => revealQuote(quote.sourceItemId),
  );

  // Its latest result counts as seen once it has been on screen (the sidebar's "Completed" goes out everywhere).
  let atEnd = $state(true);

  const compaction = $derived.by(() => {
    void threadId;

    return new ComposerCompaction();
  });

  let compact = $state(false);

  function expandComposer(activity?: ComposerActivity) {
    if (activity) compaction.interact(activity);
    else compaction.expand();
    compact = false;
  }

  function readerScroll(scroll: ReaderScroll) {
    compaction.scroll(scroll);
    compact = compaction.compact;

    if (scroll.up && feedViewport.start < 4) void view.history.load();
  }

  $effect(() => {
    compaction.question(
      view.pending.some((q) => q.kind === InteractionKind.QUESTION && q.status === "pending" && !q.asynchronous),
    );

    if (atEnd) compaction.expand();
    compact = compaction.compact;
  });

  trackSeen(() => {
    const live = overview.threads.get(threadId) ?? thread;

    return {
      threadId,
      unseen: !away && Boolean(live?.unseenResult || live?.markedUnread),
      markedUnread: live?.markedUnread ?? false,
      lastSeq: live?.lastSeq ?? 0n,
      atEnd,
    };
  });

  // The subagents its agent started (spawn_thread), live from the thread index: the panel above the composer.
  const subagents = $derived(keepSubagents(thread ? subagentsOf(threads, thread.id) : []));
  const parent = $derived(thread?.parentThreadId ? threads.find((t) => t.id === thread.parentThreadId) : undefined);
  const itemsById = $derived(new Map(view.ownEntries.map((e) => [e.id, e.item])));
  const closed = $derived(!thread || thread.status === "failed" || thread.status === "archived" || Boolean(away));
  const working = $derived(!away && view.running && thread?.status !== "waiting_input");

  // The feed: inherited history (folded), the thread's own timeline, the working indicator, steers on
  // their way (queued inputs are in the queue panel above the composer). One builder per thread keeps unchanged rows identical, so a delta re-renders one row.
  let historyOpen = $state(false);
  let searchOpen = $state(false);

  // Ended turns fold their work into "Worked for …"; which folds are open, per thread.
  const folds = $derived(memory.folds);
  const builder = $derived(memory.builder);

  const scrollMemory = $derived(threadScrollMemory(threadId, compaction, (value) => (compact = value)));

  // The composer starts as the thread was left (compact where the reader had scrolled up) in its first frame,
  // not as the previous thread had it.
  $effect.pre(() => {
    const opening = scrollMemory;

    untrack(() => {
      const anchored = opening.initial?.mode === "anchor";
      atEnd = !anchored;

      if (anchored) opening.restored(false);
      compact = compaction.compact;
    });
  });

  const rows = $derived(
    builder.build({
      entries: view.ownEntries,
      turns: view.ownTurns,
      notices: view.notices,
      results: view.turnResults,
      steering: view.steering,
      working,
      forkSourceId: thread?.forkSourceThreadId,
      inheritedEntries: view.inheritedEntries,
      inheritedTurns: view.inheritedTurns,
      historyOpen,
      openWork: folds.open,
      openGroups: folds.groups,
      historyItemsHasMore: view.historyItemsHasMore,
      openRewinds: rewind.open,
    }),
  );

  $effect.pre(() => {
    void threadId;
    historyOpen = false;
  });

  const turnsOnRail = $derived(railTurns(rows));
  let feedViewport = $state<FeedViewport>({ start: 0, end: 0, height: 0 });
  const prefetchHistory = workHistoryPrefetch(() => ({ rows, history: view.history }));

  // Queued messages above the composer (reorder, edit, delete, steer now); confirmed changes go into the
  // thread's state before the stream repeats them.
  const queue = $derived.by(() => {
    const state = view;

    return new QueueState(() => ({ threadId, turns: state.queued, steers: state.steers, running: state.running }), {
      turn: (turn) => state.upsertTurn(turn),
      steer: (steer) => state.upsertSteer(steer),
    });
  });

  const composerNote = $derived(composerAvailability(thread, worker, Boolean(away)));

  // A ?pr= link opens that pull request in a tab beside the thread.
  const selectedPr = $derived(page.url.searchParams.get("pr") ?? "");

  let panelSheet = $state(false);

  // The chat column centres on the window between the sidebar and the docked summary (summary-layout.svelte.ts).
  const summary = new SummaryLayout(() => workspaceState.rem);

  $effect(() => {
    if (!selectedPr) return;
    untrack(() => workspaceState.view.openModule({ module: "pull-requests", resource: selectedPr }));
  });

  let worktreeDialog = $state(false);

  function manageWorktree() {
    panelSheet = false;
    worktreeDialog = true;
  }

  const toggleFiles = () => workspaceState.toggleFiles(() => (panelSheet = true));

  const canBranch = $derived(!away && Boolean(tree && thread && thread.status !== "archived"));

  const openSide = () => {
    if (!tree) return;
    panelSheet = false;
    void goto(`/threads/${encodeURIComponent(tree.main.id)}/new-side-thread`);
  };

  // "Fork thread" forks after the latest ended turn; "Fork from here" (TurnDetails) after the one it is under.
  const canFork = $derived(
    !away && thread?.runtime === "worker" && thread.provider !== Provider.GROK && thread.status !== "creating",
  );

  const forkPoint = $derived(canFork ? lastForkPoint(view.ownTurns, view.inheritedTurns) : undefined);
  const forkThread = () => forkPoint && forkFrom(threadId, forkPoint.id);
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

  const allBackgroundTasks = $derived(backgroundTasks(view.ownEntries));

  const runningBackgroundTasks = $derived(
    allBackgroundTasks.filter((entry) => entry.item.status === ItemStatus.IN_PROGRESS),
  );

  const openOutput = (id: string) => {
    panelSheet = false;
    const task = allBackgroundTasks.find((entry) => entry.id === id);
    workspaceState.view.openModule({
      module: "tasks",
      resource: id,
      label: task ? backgroundName(task.item.content.value) : "Task output",
    });
  };

  provideBackgroundOutput(openOutput);

  let feed = $state<
    FoldReader & {
      reveal: (key: string) => Promise<boolean>;
      keep: (key: string) => void;
      scrollToRow: (index: number, options: { align: "start"; smooth?: boolean }) => Promise<boolean>;
    }
  >();

  /**
   * A manual toggle always keeps its header on screen, including the latest turn while following the end.
   */
  function keepToggled(rowKey: string) {
    feed?.keep(rowKey);
  }

  // A quote in a message shows where it came from: its item (in folded work or the inherited history: opened
  // first) scrolls into view and flashes (motion.css `data-flash`).
  let feedRegion = $state<HTMLElement>();

  // The sticky part at the feed's bottom (waiting cards, goal, composer): the Cite button keeps clear of it.
  let feedFooter = $state<HTMLElement>();

  async function revealQuote(itemId: string): Promise<boolean> {
    if (!view.entries.some((entry) => entry.id === itemId)) await view.history.load(itemId);
    const own = view.ownEntries.find((e) => e.id === itemId);
    const inherited = own ? undefined : view.inheritedEntries.find((e) => e.id === itemId);
    const entry = own ?? inherited;

    if (!entry) return false;
    const top = topLevelEntry(own ? view.ownEntries : view.inheritedEntries, entry);

    if (inherited && !historyOpen) historyOpen = true;
    const rewound = own && view.ownTurns.find((turn) => turn.id === own.turnId)?.rewindId;

    if (rewound) rewind.show(rewound);

    const fold = folds.foldOf(top.id);

    if (fold && !folds.open.has(fold)) folds.toggle(fold, true);
    await tick();
    const group = rows.find((row) => row.kind === "work-group" && row.items.includes(`item:${top.id}`));

    if (group) folds.toggleGroup(group.key.replace(/^history:[^:]+:/, ""), true);
    await tick();

    const target = rows.find(
      (row) =>
        (row.kind === "timeline" || row.kind === "answer") &&
        row.row?.kind === "item" &&
        row.row.node.entry.id === top.id,
    );

    if (!target || !(await feed?.reveal(target.key))) return false;
    await tick();
    const element = feedRegion?.querySelector<HTMLElement>(`[data-quote-item="${CSS.escape(entry.id)}"]`);

    if (!element) return true;
    element.scrollIntoView({ block: "nearest" });
    element.removeAttribute("data-flash");
    void element.offsetWidth; // replay when it is still flashing
    element.setAttribute("data-flash", "");
    setTimeout(() => element.removeAttribute("data-flash"), duration("very-slow") * 3);

    return true;
  }

  syncWorkFolds(() => ({ folds, view, reader: feed, preferences: device.values }));

  $effect.pre(() => {
    const current = rows;
    const expanded = device.values.workToolCalls === "expanded";
    const loaded = view.loaded && device.viewLoaded;

    if (loaded) untrack(() => (historyOpen = scrollMemory.prepare(current, folds, historyOpen, expanded)));
  });

  // The thread's actions in the command palette (the same as its menu, plus Interrupt while it works).
  contributeCommands(() =>
    thread
      ? threadCommands(thread, {
          get working() {
            return working;
          },
          get canBranch() {
            return canBranch;
          },
          get canFork() {
            return Boolean(forkPoint);
          },
          get canSchedule() {
            return canSchedule;
          },
          get closed() {
            return closed;
          },
          get goalsHere() {
            return goalsHere;
          },
          get canGoal() {
            return canGoal;
          },
          get goalOpen() {
            return Boolean(openGoal);
          },
          stop,
          openSide,
          fork: forkThread,
          openSchedule,
          openModel: () => (modelOpen = true),
          openPermissions: () => (permissionsOpen = true),
          setGoal: setGoalLater,
          togglePanel: () => workspaceState.toggleSummary(),
          toggleFiles,
          link: () => page.url.href,
        })
      : [],
  );

  const stop = () => requestThreadInterrupt(thread?.id);

  const blockingQuestions = $derived(view.pending.filter((interaction) => !interaction.asynchronous).length);

  const announcement = $derived(
    thread
      ? `Thread ${statusLook(thread.status).label.toLowerCase()}${blockingQuestions > 0 ? `, ${blockingQuestions} waiting for you` : ""}`
      : "",
  );

  // Files pasted anywhere in the thread (outside a text field) or dropped on it attach to its composer.
  const intake = provideFileIntake(new FileIntake());
</script>

<svelte:head><title>{thread?.title ?? "Thread"} · {applicationName}</title></svelte:head>

<WorkspaceFrame state={workspaceState}>
  <div class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface" {@attach intake.zone}>
    <TopBar description={away ? `Read-only. ${away}` : undefined}>
      {#if thread}
        <Crumb
          markOnly
          href={project
            ? project.kind === "scratch"
              ? "/settings/threads"
              : `/settings/projects/${project.id}`
            : undefined}
          >{#snippet mark()}{#key thread.id}<ThreadSyncStatus
                syncing={!away && !view.failure && view.connection !== "live"}
              >
                <ProjectMark name={project?.name ?? "?"} kind={project?.kind} />
              </ThreadSyncStatus>{/key}{/snippet}<span class="sr-only">{project?.name ?? "Project"}</span></Crumb
        >
        <Crumb><LiveText text={thread.title} active={thread.titleGenerating} /></Crumb>
      {:else}
        <Crumb><Skeleton class="h-4 w-48" /></Crumb>
      {/if}
      {#snippet workspace()}<WorkspaceTabs state={workspaceState} {working} pending={blockingQuestions} />{/snippet}
      {#snippet actions()}
        <div class="max-sm:hidden"><ThreadSyncProgress status={view.syncStatus} /></div>
        {#if thread}<div class="max-sm:hidden">
            <DropdownMenu label="Thread actions" placement="bottom-end">
              {#snippet trigger(props)}<IconButton
                  icon="ellipsis-horizontal"
                  label="Thread actions"
                  {...props}
                />{/snippet}
              {@render threadActions()}
            </DropdownMenu>
          </div>{/if}
        <WorkspaceFilesToggle
          pressed={workspaceState.wide ? workspaceState.filesOpen : undefined}
          onclick={toggleFiles}
        />
      {/snippet}
    </TopBar>
    <ThreadSearch
      bind:open={searchOpen}
      {view}
      reveal={async (turnId, itemId) => {
        if (itemId) {
          await revealQuote(itemId);
          return;
        }
        historyOpen = true;
        await tick();
        const row = rows.find(
          (row) => row.kind === "timeline" && row.row.kind === "turn-start" && row.row.turn.id === turnId,
        );
        if (row) await feed?.reveal(row.key);
      }}
    />

    {#if thread?.status === "failed" && thread.statusDetail}
      <Alert tone="error" banner title="The thread failed">{thread.statusDetail}</Alert>
    {/if}
    <ThreadWatchNotice {view} />

    <div class="relative flex min-h-0 flex-1 flex-col">
      <div
        id={fileTab ? undefined : "workspace-content"}
        role="tabpanel"
        aria-label="Thread"
        class="absolute inset-0 min-h-0 md:pl-9"
        class:invisible={Boolean(fileTab)}
        inert={Boolean(fileTab)}
        bind:this={feedRegion}
        bind:clientWidth={summary.width}
        style:--chat-offset={summary.inner ? `${summary.offset}px` : undefined}
        style:--chat-column={summary.inner ? `${summary.column}px` : undefined}
        data-chat-settling={summary.settling || undefined}
      >
        <span
          aria-hidden="true"
          class="pointer-events-none invisible absolute w-(--chat-width)"
          bind:clientWidth={summary.chat}
        ></span>
        <span
          aria-hidden="true"
          class="pointer-events-none invisible absolute inset-x-0 md:left-9"
          {@attach summary.measure}
        ></span>
        {#if thread}<ThreadSummary {thread} {tree} floating={summary.floating} docked={summary.docked}
            >{@render threadPanel()}</ThreadSummary
          >{/if}
        {#key threadId}
          {#if turnsOnRail.length >= 3}
            <div class="absolute inset-y-6 left-1 z-20 w-8 max-md:hidden">
              <TurnRail
                turns={turnsOnRail}
                viewport={feedViewport}
                onjump={(row) => {
                  void feed?.scrollToRow(row, { align: "start", smooth: true });
                }}
              />
            </div>
          {/if}
          {#if device.viewLoaded}<VirtualFeed
              bind:this={feed}
              bind:atEnd
              {rows}
              {scrollMemory}
              sizes={memory.sizes}
              ready={view.loaded && scrollMemory.prepared && !prefetchHistory.waiting}
              key={(row: FeedRow) => row.key}
              group={feedGroup}
              estimate={feedEstimate}
              inserted={feedInserted}
              label="Timeline"
              busy={working}
              onreaderscroll={readerScroll}
              onlatest={expandComposer}
              onviewport={(viewport) => {
                feedViewport = viewport;
              }}
              onwindow={prefetchHistory.update}
            >
              {#snippet placeholder()}
                {#if !view.loaded}<TimelineSkeleton />{/if}
              {/snippet}
              {#snippet top()}
                {#if view.hasMore}
                  <div class="flex justify-center py-3">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={view.history.loading}
                      onclick={() => void view.history.load()}
                      >{view.history.loading ? "Loading earlier messages…" : "Show earlier messages"}</Button
                    >
                    {#if view.history.error}<p role="status" class="text-sm text-red-600 dark:text-red-400">
                        {view.history.error}
                      </p>{/if}
                  </div>
                {/if}
                {#if thread?.scheduleId}<ScheduleOrigin {thread} class="pt-4" />{/if}
                {#if thread?.spawnedByAgent && thread.parentThreadId}
                  <SubagentOrigin parentThreadId={thread.parentThreadId} parentTitle={parent?.title} class="mt-4" />
                {/if}
                {#if view.loaded && rows.length === 0}
                  <EmptyState
                    icon={thread?.status === "creating" ? "arrow-path" : "sparkles"}
                    title={thread?.status === "creating" ? "Starting the thread" : "No messages yet"}
                    description={thread?.status === "creating"
                      ? `Setting up the agent on ${worker?.name ?? "the worker"}.`
                      : closed
                        ? "This thread closed before anyone said a word."
                        : "Send a message below to start."}
                    class="mt-8"
                  />
                {/if}
              {/snippet}
              {#snippet row(row: FeedRow)}
                <FeedRowView
                  {row}
                  onhistory={() => void view.history.load()}
                  historyLoading={view.history.loading}
                  historyError={view.history.error}
                  ontoggle={() => (historyOpen = !historyOpen)}
                  onwork={(fold, rowKey) => {
                    keepToggled(rowKey);
                    folds.toggle(fold);
                  }}
                  ongroup={(key, rowKey) => {
                    keepToggled(rowKey);
                    folds.toggleGroup(key);
                  }}
                />
              {/snippet}
              {#snippet footer()}
                <!-- What comes and goes above the composer grows in and out (each carries its own gap below). -->
                <div class="grid grid-cols-1 pt-2" bind:this={feedFooter}>
                  {#if view.secrets.some((s) => s.status === "pending")}
                    <GrowIn overlay class="pb-3"
                      ><ThreadSecretsPanel
                        secrets={view.secrets.filter((s) => s.status === "pending")}
                        onchange={(secret) => view.upsertSecret(secret)}
                      /></GrowIn
                    >
                  {/if}
                  {#if view.pending.some((i) => i.kind !== InteractionKind.QUESTION)}
                    <GrowIn overlay class="pb-3">
                      <div
                        class={["grid gap-3 p-px", away && "opacity-60"]}
                        role="region"
                        aria-label="Waiting for you"
                        inert={Boolean(away)}
                      >
                        <PendingDecisions
                          interactions={view.pending.filter((i) => i.kind !== InteractionKind.QUESTION)}
                          items={itemsById}
                          {parent}
                        />
                      </div>
                    </GrowIn>
                  {/if}
                  {#if view.backgroundTasks.length > 0}
                    <GrowIn overlay class="justify-self-start pb-3">
                      <BackgroundTasksChip tasks={runningBackgroundTasks} onjump={(task) => openOutput(task.id)} />
                    </GrowIn>
                  {/if}
                  {#snippet composerPanels()}
                    {#if thread && shownGoal}
                      <div class="t-rise">
                        <GoalBar
                          goal={shownGoal}
                          provider={thread.provider}
                          threadId={thread.id}
                          disabled={closed}
                          embedded
                          {compact}
                          onchange={(goal) => view.upsertGoal(goal)}
                          ondismiss={() => (dismissedGoals = new Set(dismissedGoals).add(shownGoal.id))}
                        />
                      </div>
                    {/if}
                    {#if subagents.length > 0}
                      <div class="t-rise" out:subagentPresence|global>
                        <SubagentsPanel {subagents} {compact} embedded />
                      </div>
                    {/if}
                    <div inert={Boolean(away)} class={away ? "opacity-60" : undefined}>
                      <QueuePanel
                        {queue}
                        {compact}
                        embedded
                        delivery={settings.runningDelivery}
                        ondelivery={(delivery) => void settings.updateRunningDelivery(delivery)}
                      />
                    </div>
                  {/snippet}
                  {#if thread}
                    {#snippet computerStatus()}
                      {#if away}<ComputerAwayBar computer={overview.computer(thread.nodeId)} reason={away} />{/if}
                    {/snippet}
                    <ThreadComposerSlot {thread} {parent} {compact}>
                      <Composer
                        status={away ? computerStatus : undefined}
                        {compact}
                        panelsLabel={queue.rows.length > 0 || subagents.length > 0
                          ? `${subagents.length} agents · ${queue.rows.length} queued`
                          : shownGoal
                            ? "Goal"
                            : undefined}
                        onexpand={expandComposer}
                        onfocuschange={(focused) => {
                          compaction.focus(focused);
                          compact = compaction.compact;
                        }}
                        class="relative"
                        top={queue.rows.length > 0 || subagents.length > 0 || shownGoal ? composerPanels : undefined}
                        questions={view.pending}
                        {thread}
                        {worker}
                        running={view.running}
                        runningTurnId={view.ownTurns.find((turn) => turn.status === "running")?.id}
                        connection={view.composerConnection}
                        disabled={closed ||
                          !view.loaded ||
                          Boolean(away) ||
                          view.connection === "error" ||
                          thread.rewindPending ||
                          rewind.busy}
                        note={composerNote}
                        onsent={(response) => {
                          if (response.steer) view.upsertSteer(response.steer);
                        }}
                        ongoal={canGoal && !openGoal ? () => (goalDialog = true) : undefined}
                      />
                    </ThreadComposerSlot>
                  {:else}
                    <Skeleton class="h-28 rounded-2xl" />
                  {/if}
                </div>
              {/snippet}
            </VirtualFeed>{/if}
        {/key}
      </div>
      <WorkspaceContent state={workspaceState} module={renderModule} />
    </div>
    <FileDropOverlay {intake} />
  </div>

  {#snippet panel(width: number)}
    <WorkspaceFilesPanel
      view={workspaceState.view}
      root={(thread?.worktree?.path || thread?.cwd || "").split(/[\\/]/).filter(Boolean).at(-1) ?? ""}
      {width}
      wide={workspaceState.wide}
      bind:sheet={panelSheet}
    />
  {/snippet}
</WorkspaceFrame>

{#snippet threadActions()}
  {#if thread}<ThreadMenuItems {thread} omit={["open"]} />{/if}
  <MenuItem icon="magnifying-glass" onselect={() => (searchOpen = true)}>Search thread</MenuItem>
{/snippet}

{#snippet threadPanel()}
  {#if thread && tree}
    <ThreadPanel
      onworktree={manageWorktree}
      {thread}
      {tree}
      {worker}
      schedules={view.upcomingSchedules}
      syncStatus={view.syncStatus}
      backgroundTasks={allBackgroundTasks}
      items={itemsById}
      onbackground={openOutput}
      onschedule={canSchedule ? openSchedule : undefined}
      onschedulechange={(schedule) => view.upsertSchedule(schedule)}
      secrets={view.secrets}
      onsecretchange={(secret) => view.upsertSecret(secret)}
      onnewside={canBranch ? openSide : undefined}
    />
  {:else}<Skeleton class="h-72 rounded-2xl" />{/if}
{/snippet}

{#snippet renderModule(target: WorkspaceModuleTarget)}
  {#if target.module === "pull-requests" && target.resource}
    <PullRequestPanel id={target.resource} {threadId} onclose={() => workspaceState.view.select("thread")} />
  {:else if target.module === "tasks" && target.resource}
    {@const task = allBackgroundTasks.find((entry) => entry.id === target.resource)}
    {#if task && thread}<BackgroundTaskDialog
        embedded
        entry={task}
        threadId={thread.id}
        cwd={thread.cwd}
        source={itemsById.get(task.item.content.value.sourceItemId)}
        onclose={() => workspaceState.view.select("thread")}
      />
    {:else}<EmptyState
        title="Task output is outside the loaded history"
        description="Choose another task in Thread details."
      />{/if}
  {:else}<EmptyState title="This tab is no longer available" description="Close it to continue." />{/if}
{/snippet}

{#if thread?.worktree}
  <Dialog bind:open={worktreeDialog} title="Worktree" size="lg">
    {#if worktreeDialog}<WorktreeManagement worktreeId={thread.worktree.id} />{/if}
  </Dialog>
{/if}

{#if thread && tree}
  <ThreadModelDialog bind:open={modelOpen} {thread} {worker} />
  <ThreadPermissionsDialog bind:open={permissionsOpen} {thread} />
  <GoalDialog
    bind:open={goalDialog}
    threadId={thread.id}
    provider={thread.provider}
    current={view.goal}
    onset={(goal) => view.upsertGoal(goal)}
  />
  <ScheduleDialog bind:open={scheduling} threadId={thread.id} oncreated={(schedule) => view.upsertSchedule(schedule)} />
{/if}

<p class="sr-only" role="status">{announcement}</p>
<CiteLayer {threadId} root={feedRegion} avoid={feedFooter} />

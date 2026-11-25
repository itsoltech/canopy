<script lang="ts">
  import { threadDraftPresence } from "#lib/features/drafts/presence.svelte.ts";
  import DraftMarker from "#lib/features/drafts/DraftMarker.svelte";
  import type { ui } from "@canopy/contracts";
  import { threadRowPlace } from "@canopy/domain/git-heads";
  import { threadRowMarks } from "@canopy/ui/thread-row";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ProjectMark from "#lib/shared/ui/ProjectMark.svelte";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import { providerLabel } from "#lib/features/threads/labels.ts";
  import { providerKeyOf } from "#lib/features/threads/providers.ts";
  import ThreadActivityMark from "#lib/features/threads/ThreadActivityMark.svelte";
  import ThreadGoalMark from "#lib/features/threads/ThreadGoalMark.svelte";
  import SidebarThreadStatus from "./SidebarThreadStatus.svelte";
  import SidebarThreadLink from "./SidebarThreadLink.svelte";
  import SidebarThreadBranch from "./SidebarThreadBranch.svelte";
  import SidebarThreadPullRequests from "./SidebarThreadPullRequests.svelte";
  import SwapText from "#lib/shared/ui/SwapText.svelte";
  import ScheduleOrigin from "#lib/features/schedules/ScheduleOrigin.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { awayReason } from "#lib/features/computers/computers.ts";
  import { needsYou, workState } from "#lib/features/threads/activity.ts";
  import { formatCount } from "#lib/shared/format.ts";

  /**
   * One thread in the inbox: project and status, title, then where it runs (computer, place, branch),
   * its marks (goal, side threads, started by an agent, linked pull requests) and provider.
   * Project headings supply project identity. Worktree headings also supply the directory and branch;
   * local-only worktree cards keep the title, status, marks and provider on one line.
   * `sides` = number of side threads under it.
   * What it does leads the row (ThreadActivityMark in the avatar's place, background tasks with their count);
   * working rows keep their text contrast, finished unseen ones and those that need you stand out. Hover,
   * focus or tap-and-hold shows its summary (ThreadHoverCard).
   */
  let {
    thread,
    project,
    worker,
    sides = 0,
    snoozed = false,
    current = false,
    groupedProject = false,
    groupedWorktree = false,
    subagentsNeedingInput = [],
  }: {
    thread: ui.Thread;
    project: ui.Project | undefined;
    worker: ui.Worker | undefined;
    sides?: number;
    snoozed?: boolean;
    current?: boolean;
    groupedProject?: boolean;
    groupedWorktree?: boolean;
    subagentsNeedingInput?: readonly ui.Thread[];
  } = $props();

  const provider = $derived(providerKeyOf(thread.provider));
  const activity = $derived(subagentsNeedingInput[0] ?? thread);
  const activityState = $derived(workState(activity));

  const showActivity = $derived(
    !groupedProject || activityState === "needs" || activityState === "asks" || activityState === "background",
  );

  const overview = useOverview();
  const computer = $derived(overview.computer(thread.nodeId));
  const away = $derived(thread.nodeId ? awayReason(computer) : undefined);
  const row = $derived(threadRowPlace(thread, project));

  const place = $derived(
    groupedWorktree || (groupedProject && row.place.toLowerCase() === project?.name.toLowerCase()) ? "" : row.place,
  );

  const branch = $derived(groupedWorktree ? "" : row.branch);

  const showWorker = $derived(
    !(
      worker?.desktopBundled &&
      !worker.revokedAt &&
      !worker.nodeId &&
      !thread.nodeId &&
      overview.computers.size === 0 &&
      overview.workers.filter((candidate) => !candidate.revokedAt).length === 1
    ),
  );

  const inlineProvider = $derived(groupedWorktree && !showWorker);
  const draft = threadDraftPresence(() => thread.id);

  const hasMarks = $derived(
    draft.current ||
      Boolean(
        thread.goalStatus ||
        thread.scheduleId ||
        thread.spawnedByAgent ||
        thread.pullRequestCount ||
        thread.newestPullRequest ||
        sides,
      ),
  );

  const providerName = $derived(providerLabel(thread.provider));
</script>

{#snippet providerMark()}
  <span class="flex size-3.5 shrink-0 items-center justify-center">
    {#if provider}<span
        class="sidebar-swap-resting flex"
        title={thread.providerProfileId ? `${providerName} · ${thread.providerProfileId}` : providerName}
        ><ProviderIcon {provider} label={providerName} size="sm" opacity={threadRowMarks.providerOpacity} /></span
      >{/if}
  </span>
{/snippet}

{#snippet marks()}
  {#if groupedProject && (!inlineProvider || draft.current)}<DraftMarker threadId={thread.id} />{/if}
  <ThreadGoalMark {thread} />
  <ScheduleOrigin {thread} compact />
  {#if sides > 0}<span class="flex items-center gap-0.5" title="{sides} side {sides === 1 ? 'thread' : 'threads'}"
      ><Icon name="arrows-right-left" class="size-3.5" />{sides}</span
    >{/if}
  {#if thread.spawnedByAgent}<Icon
      name="sparkles"
      class="size-3.5 text-violet-500 dark:text-violet-400"
      label="Started by an agent"
    />{/if}
  <SidebarThreadPullRequests {thread} />
{/snippet}

{#snippet title()}
  <SwapText
    text={thread.title}
    live={thread.titleGenerating}
    class={[
      "sidebar-row-title h-5.5 min-w-0 flex-1 overflow-hidden text-base/5.5 sm:h-5 sm:text-sm/5",
      thread.titleGenerating
        ? "text-zinc-500 dark:text-zinc-400"
        : "text-zinc-800 group-aria-[current=page]:text-zinc-950 group-data-result:text-zinc-950 dark:text-zinc-200 dark:group-aria-[current=page]:text-white dark:group-data-result:text-white",
    ]}
  />
{/snippet}

<SidebarThreadLink
  {thread}
  {current}
  {snoozed}
  quickArchive
  {groupedWorktree}
  {inlineProvider}
  dense={groupedProject}
  needsAttention={needsYou(thread) || subagentsNeedingInput.length > 0}
  class={[
    "sidebar-row-padding grid gap-0.5",
    groupedProject ? "sidebar-group-thread rounded-lg py-1.5 sm:py-1" : "rounded-xl py-2",
  ]}
>
  <span class={["relative flex min-w-0 items-center", groupedProject ? "gap-2" : "gap-1"]}>
    <span class={groupedProject ? "sidebar-group-activity" : "flex shrink-0"}>
      {#if away}
        <span class="grid size-5 shrink-0 place-items-center">
          <Icon name="link" class="fill-zinc-400 dark:fill-zinc-500" />
        </span>
      {:else if snoozed}
        <span class="grid size-5 shrink-0 place-items-center">
          <ProjectMark
            name={project?.name ?? "?"}
            kind={project?.kind}
            color={project?.color}
            imageBase64={project?.imageBase64}
          />
        </span>
      {:else if showActivity}
        <ThreadActivityMark thread={activity} class="sidebar-row-activity">
          {#snippet idle()}
            {#if !groupedProject}<ProjectMark
                name={project?.name ?? "?"}
                kind={project?.kind}
                color={project?.color}
                imageBase64={project?.imageBase64}
              />{/if}
          {/snippet}
        </ThreadActivityMark>
      {/if}
    </span>
    {#if groupedProject}
      {@render title()}
    {:else}<span class="min-w-0 flex-1 truncate text-sm/5 text-zinc-500 sm:text-xs/4.5 dark:text-zinc-400"
        >{project?.name ?? "Unknown project"}</span
      >{/if}
    <SidebarThreadStatus
      {thread}
      {snoozed}
      compact={inlineProvider}
      label={!needsYou(thread) && subagentsNeedingInput.length
        ? subagentsNeedingInput.length === 1
          ? "Subagent needs input"
          : `${formatCount(subagentsNeedingInput.length)} subagents need input`
        : undefined}
    />
    {#if inlineProvider && hasMarks}<span
        class="flex shrink-0 items-center gap-1.5 text-sm text-zinc-500 sm:text-xs dark:text-zinc-400"
        >{@render marks()}</span
      >{/if}
    {#if inlineProvider}{@render providerMark()}{/if}
  </span>
  {#if !groupedProject}<div
      class="flex min-w-0 items-center gap-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400"
    >
      {@render title()}
      <DraftMarker threadId={thread.id} />
    </div>{/if}
  {#if !inlineProvider}
    <span class="flex min-w-0 items-center gap-2 text-sm/5 text-zinc-500 sm:text-xs/4.5 dark:text-zinc-400">
      {#if showWorker}<Icon
          name="computer-desktop"
          class="size-3.5 {worker?.online ? 'fill-zinc-400 dark:fill-zinc-500' : 'fill-zinc-300 dark:fill-zinc-700'}"
        />{/if}
      {#if showWorker || place}<span class={["min-w-0 truncate", branch ? "max-w-2/5" : "flex-1"]}
          >{#if showWorker}{worker?.name ?? "Unknown worker"}{#if place}<span class="text-zinc-400 dark:text-zinc-600"
                >{" · "}</span
              >{/if}{/if}{place}</span
        >{/if}
      {#if branch}<SidebarThreadBranch {branch} label={row.branchLabel} class="flex-1" />{/if}
      <span class="ml-auto flex shrink-0 items-center gap-2">
        {@render marks()}
        {@render providerMark()}
      </span>
    </span>
  {/if}
</SidebarThreadLink>

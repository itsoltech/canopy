<script lang="ts">
  import type { ui, Usage } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import { osLabel } from "#lib/features/overview/workers.ts";
  import ScheduleActions from "#lib/features/schedules/ScheduleActions.svelte";
  import { describeWhen } from "#lib/features/schedules/schedules.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatCount, formatDateTime, formatRelative, isoDateTime } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import StatusBadge from "#lib/shared/ui/StatusBadge.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { permissionLabel, permissionLook, providerLabel } from "../labels.ts";
  import type { UsageTotals } from "../thread-state.svelte.ts";
  import { providerKeyOf } from "../providers.ts";
  import { isSide, type ThreadTree } from "../thread-tree.ts";
  import ThreadStatusText from "../ThreadStatusText.svelte";
  import PanelRow from "./PanelRow.svelte";
  import BackgroundTasksSection from "./BackgroundTasksSection.svelte";
  import type { BackgroundEntry } from "../background-tasks.ts";
  import type { Item } from "@open-agents/contracts";
  import { useThreadDirectory } from "../thread-directory.ts";
  import ThreadTitleActions from "./ThreadTitleActions.svelte";

  /**
   * Context of a thread (T3's right panel): where it runs, which agent, who answers its approvals,
   * usage, its scheduled tasks (pause, resume, cancel, schedule another), and its lineage — the main
   * thread with its side threads, agent-started and forked ones marked — plus "New side thread".
   */
  let {
    thread,
    tree,
    worker,
    usage,
    totals,
    schedules,
    backgroundTasks = [],
    items = new Map(),
    onbackground,
    onschedule,
    onschedulechange,
    onnewside,
    class: className,
  }: {
    thread: ui.Thread;
    tree: ThreadTree;
    worker: ui.Worker | undefined;
    /** Latest live usage (context window). */
    usage: Usage | undefined;
    /** Usage of the thread's own turns. */
    totals: UsageTotals;
    /** Active and paused schedules of the thread. */
    schedules: readonly ui.Schedule[];
    backgroundTasks?: readonly BackgroundEntry[];
    items?: ReadonlyMap<string, Item>;
    onbackground?: ((id: string) => void) | undefined;
    onschedule?: (() => void) | undefined;
    onschedulechange?: ((schedule: ui.Schedule) => void) | undefined;
    onnewside?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();
  const providerKey = $derived(providerKeyOf(thread.provider));

  const lookup = (id: string) => (tree.main.id === id ? tree.main : tree.sides.find((s) => s.id === id));
  const directory = useThreadDirectory();
  // A forked main thread ("Fork from here") is in its own tree: its source is found among the project's threads.
  const source = $derived(thread.forkSourceThreadId ? (lookup(thread.forkSourceThreadId) ?? directory.thread(thread.forkSourceThreadId)) : undefined);
  const parent = $derived(thread.parentThreadId ? lookup(thread.parentThreadId) : undefined);
  const hasUsage = $derived(totals.inputTokens > 0n || totals.outputTokens > 0n);
</script>

<div class={["grid grid-cols-1 divide-y divide-zinc-950/5 rounded-2xl bg-white py-1.5 shadow-sm ring-1 ring-zinc-950/10 dark:divide-white/8 dark:bg-zinc-950 dark:shadow-none dark:ring-white/10", className]}>
  <ThreadTitleActions {thread} />
  <section aria-label="Placement" class="grid grid-cols-1 px-1.5 pb-1.5">
    <PanelRow icon="computer-desktop">
      {worker?.name ?? "Unknown worker"}
      {#snippet aside()}
        <span class="flex shrink-0 items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/5">
          <StatusDot tone={worker?.online ? "emerald" : "neutral"} />{worker?.online ? osLabel(worker.os) : "Offline"}
        </span>
      {/snippet}
    </PanelRow>
    <PanelRow icon="folder"><code class="font-mono text-[0.8125rem]" title={thread.cwd}>{thread.cwd}</code></PanelRow>
  </section>

  <section aria-label="Agent" class="grid grid-cols-1 p-1.5">
    <PanelRow icon="cpu-chip">
      {#snippet lead()}{#if providerKey}<ProviderIcon provider={providerKey} />{:else}<Icon name="cpu-chip" class="fill-zinc-400 dark:fill-zinc-500" />{/if}{/snippet}
      {providerLabel(thread.provider)}{thread.model ? ` ${thread.model}` : ""}
      {#snippet aside()}{#if thread.providerProfileId}<span class="shrink-0 text-sm/5 text-zinc-500 sm:text-xs/5">{thread.providerProfileId}</span>{/if}{/snippet}
    </PanelRow>
    <PanelRow icon={permissionLook(thread.permissionMode).icon} iconClass={permissionLook(thread.permissionMode).iconClass}>{permissionLabel(thread.permissionMode)}</PanelRow>
    {#if isSide(thread)}
      <PanelRow icon="hand-raised" iconClass={thread.interactionRoute === "parent" ? "fill-violet-500 dark:fill-violet-400" : undefined}>
        {#if thread.interactionRoute === "parent"}
          <span title="Approvals and questions of this thread go to the agent of “{parent?.title ?? 'the parent thread'}”. You can answer them here instead.">Main agent answers approvals</span>
        {:else}
          You answer approvals
        {/if}
        {#snippet aside()}{#if thread.interactionRoute === "parent"}<span class="shrink-0 text-sm/5 text-zinc-500 sm:text-xs/5">You can step in</span>{/if}{/snippet}
      </PanelRow>
    {/if}
    <PanelRow icon="signal">
      Status
      {#snippet aside()}<StatusBadge status={thread.status} />{/snippet}
    </PanelRow>
    {#if hasUsage}
      <PanelRow icon="bolt">
        <span class="tabular-nums" title="Tokens of this thread's turns">{formatCount(totals.inputTokens)} in · {formatCount(totals.outputTokens)} out</span>
        {#snippet aside()}
          <span class="shrink-0 text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5">
            {#if totals.costUsd > 0}${totals.costUsd.toFixed(3)}{:else if usage && usage.contextWindowTokens > 0n}{formatCount(usage.contextWindowTokens)} ctx{/if}
          </span>
        {/snippet}
      </PanelRow>
    {/if}
  </section>

  {#if onbackground}<BackgroundTasksSection tasks={backgroundTasks} threadId={thread.id} {items} onopen={onbackground} />{/if}

  {#if schedules.length > 0 || onschedule}
    <section aria-labelledby="schedules-title" class="grid grid-cols-1 p-1.5">
      <h2 id="schedules-title" class="px-3 pt-1 pb-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Scheduled tasks</h2>
      {#if schedules.length > 0}
        <ul role="list" class="grid grid-cols-1 gap-0.5">
          {#each schedules as schedule (schedule.id)}
            <li class="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg py-1.5 pr-1.5 pl-3">
              <div class="flex h-lh items-center text-base/6 sm:text-sm/6">
                <Icon
                  name={schedule.createdBy === "agent" ? "sparkles" : schedule.kind === "once" ? "clock" : "arrow-path"}
                  class={schedule.createdBy === "agent" ? "fill-violet-500 dark:fill-violet-400" : "fill-zinc-400 dark:fill-zinc-500"}
                />
              </div>
              <div class="min-w-36 flex-1">
                <p class="truncate text-base/6 text-zinc-700 sm:text-sm/6 dark:text-zinc-300" title={schedule.prompt}>{schedule.prompt}</p>
                <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
                  {describeWhen(schedule)}
                  {#if schedule.status === "paused"}
                    · <span class="text-amber-700 dark:text-amber-400">Paused</span>
                  {:else if schedule.nextRunAt}
                    · <time datetime={isoDateTime(schedule.nextRunAt)} title={formatDateTime(schedule.nextRunAt)}>next {formatRelative(schedule.nextRunAt, clock.now)}</time>
                  {/if}
                  {#if schedule.createdBy === "agent"}<span class="sr-only"> (set by an agent)</span>{/if}
                </p>
              </div>
              <ScheduleActions {schedule} compact onchange={onschedulechange} class="ml-auto" />
            </li>
          {/each}
        </ul>
      {/if}
      {#if onschedule}
        <PanelRow icon="plus" onclick={onschedule} class="text-zinc-500 dark:text-zinc-400">Schedule a task</PanelRow>
      {/if}
    </section>
  {/if}

  {#if thread.forkSourceThreadId}
    <section aria-label="Fork" class="grid grid-cols-1 p-1.5">
      <PanelRow icon="square-2-stack" href="/threads/{thread.forkSourceThreadId}">
        Forked from {source?.title ?? "another thread"}
        {#snippet aside()}
          <!-- The fork point stays readable when a long title truncates. -->
          {#if thread.forkAfterTurnOrdinal}<span class="shrink-0 text-zinc-500 tabular-nums dark:text-zinc-400">Turn {thread.forkAfterTurnOrdinal}</span>{/if}
          <Icon name="arrow-top-right-on-square" class="size-3.5 fill-zinc-400 dark:fill-zinc-500" />
        {/snippet}
      </PanelRow>
    </section>
  {/if}

  <section aria-labelledby="lineage-title" class="grid grid-cols-1 px-1.5 pt-1.5">
    <h2 id="lineage-title" class="px-3 pt-1 pb-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Lineage</h2>
    <ul role="list" class="grid grid-cols-1 gap-0.5">
      <li>
        <PanelRow icon="chat-bubble-left-right" href="/threads/{tree.main.id}" current={tree.main.id === thread.id}>
          {tree.main.title}
          {#snippet aside()}<ThreadStatusText thread={tree.main} />{/snippet}
        </PanelRow>
      </li>
      {#each tree.sides as side (side.id)}
        <li>
          <PanelRow
            icon={side.spawnedByAgent ? "sparkles" : side.forkSourceThreadId ? "square-2-stack" : "arrow-turn-down-right"}
            iconClass={side.spawnedByAgent ? "fill-violet-500 dark:fill-violet-400" : undefined}
            href="/threads/{side.id}"
            current={side.id === thread.id}
            class="pl-6"
          >
            {side.title}{#if side.spawnedByAgent}<span class="sr-only"> (started by an agent)</span>{/if}{#if side.forkSourceThreadId}<span class="sr-only"> (fork)</span>{/if}
            {#snippet aside()}<ThreadStatusText thread={side} />{/snippet}
          </PanelRow>
        </li>
      {/each}
    </ul>
    {#if onnewside}
      <PanelRow icon="plus" onclick={onnewside} class="text-zinc-500 dark:text-zinc-400">New side thread</PanelRow>
    {/if}
  </section>
</div>

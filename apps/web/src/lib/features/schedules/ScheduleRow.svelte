<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatDateTime, formatRelative, isoDateTime } from "#lib/shared/format.ts";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ScheduleActions from "./ScheduleActions.svelte";
  import ScheduleRuns from "./ScheduleRuns.svelte";
  import ScheduleStatus from "./ScheduleStatus.svelte";
  import { modelDisplayName } from "#lib/features/models/catalog.ts";
  import { describeWhen, isFinished, placementLabels, runsLabel } from "./schedules.ts";

  /** One scheduled task: its message, when it runs, the next run, runs so far, its thread and who set it. */
  let { schedule, onchange, class: className }: { schedule: ui.Schedule; onchange?: ((schedule: ui.Schedule) => void) | undefined; class?: ClassValue } = $props();

  const overview = useOverview();
  const thread = $derived(overview.threads.get(schedule.threadId));
  const creator = $derived(schedule.createdByThreadId ? overview.threads.get(schedule.createdByThreadId) : undefined);
  const linkClass = "font-medium text-zinc-700 underline decoration-zinc-950/15 underline-offset-2 hover:text-zinc-950 hover:decoration-zinc-950/40 focus-ring dark:text-zinc-300 dark:decoration-white/20 dark:hover:text-white dark:hover:decoration-white/40";
</script>

<div class={["flex items-start gap-3 px-4 py-3.5", className]}>
  <div class="grid min-w-0 flex-1 gap-1.5">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <p class="line-clamp-2 min-w-0 text-base/6 font-medium break-words text-zinc-950 sm:text-sm/6 dark:text-white" title={schedule.prompt}>{schedule.name || schedule.prompt}</p>
      <ScheduleStatus status={schedule.status} />
    </div>
    {#if schedule.name && schedule.name !== schedule.prompt}<p class="line-clamp-2 text-base/6 break-words text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{schedule.prompt}</p>{/if}
    <dl class="flex flex-wrap gap-x-4 gap-y-1 text-sm/5 text-zinc-500 dark:text-zinc-400">
      <div class="flex min-w-0 items-center gap-1.5">
        <dt><Icon name={schedule.kind === "once" ? "clock" : "arrow-path"} class="size-3.5 fill-zinc-400 dark:fill-zinc-500" /><span class="sr-only">When</span></dt>
        <dd class="truncate">{describeWhen(schedule)}</dd>
      </div>
      {#if !isFinished(schedule) && schedule.nextRunAt}
        <div class="flex items-center gap-1">
          <dt>{schedule.status === "paused" ? "Was due" : "Next"}</dt>
          <dd><time datetime={isoDateTime(schedule.nextRunAt)} title={formatDateTime(schedule.nextRunAt)}>{formatRelative(schedule.nextRunAt, clock.now)}</time></dd>
        </div>
      {/if}
      <div class="flex items-center gap-1 tabular-nums"><dt class="sr-only">Runs</dt><dd>{runsLabel(schedule)}</dd></div>
      {#if schedule.target === "new_thread" && schedule.newThread}
        <div class="flex min-w-0 items-center gap-1">
          <dt class="sr-only">Target</dt>
          <dd class="break-words">New thread in {overview.project(schedule.projectId)?.name ?? "project"} · {placementLabels[schedule.newThread.placement]} · {modelDisplayName(schedule.newThread.model)}</dd>
        </div>
      {:else}
      <div class="flex min-w-0 items-center gap-1">
        <dt>Thread</dt>
        <dd class="truncate"><a href="/threads/{schedule.threadId}" class={linkClass}>{thread?.title ?? "Thread"}</a></dd>
      </div>
      {/if}
      <div class="flex min-w-0 items-center gap-1">
        <dt class="sr-only">Set by</dt>
        {#if schedule.createdBy === "agent"}
          <dd class="flex min-w-0 items-center gap-1">
            <Icon name="sparkles" class="size-3.5 shrink-0 fill-violet-500 dark:fill-violet-400" />
            <span class="shrink-0">Agent</span>
            {#if schedule.createdByThreadId && schedule.createdByThreadId !== schedule.threadId}
              <span class="shrink-0">in</span>
              <a href="/threads/{schedule.createdByThreadId}" class={["truncate", linkClass]}>{creator?.title ?? "another thread"}</a>
            {/if}
          </dd>
        {:else}
          <dd class="flex items-center gap-1"><Icon name="user" class="size-3.5 fill-zinc-400 dark:fill-zinc-500" />You</dd>
        {/if}
      </div>
    </dl>
    {#if schedule.lastEditedAt}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Edited by you · <time datetime={isoDateTime(schedule.lastEditedAt)} title={formatDateTime(schedule.lastEditedAt)}>{formatRelative(schedule.lastEditedAt, clock.now)}</time></p>{/if}
    {#if schedule.recentRuns.length}<ScheduleRuns runs={schedule.recentRuns} class="pt-2" />{/if}
  </div>
  <ScheduleActions {schedule} {onchange} />
</div>

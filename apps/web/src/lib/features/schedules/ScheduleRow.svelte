<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatDateTime, formatRelative, isoDateTime } from "#lib/shared/format.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ScheduleActions from "./ScheduleActions.svelte";
  import { describeWhen, isFinished, runsLabel, scheduleStatusLook } from "./schedules.ts";

  /** One scheduled task: its message, when it runs, the next run, runs so far, its thread and who set it. */
  let { schedule, onchange }: { schedule: ui.Schedule; onchange?: ((schedule: ui.Schedule) => void) | undefined } = $props();

  const overview = useOverview();
  const look = $derived(scheduleStatusLook(schedule.status));
  const thread = $derived(overview.threads.get(schedule.threadId));
  const creator = $derived(schedule.createdByThreadId ? overview.threads.get(schedule.createdByThreadId) : undefined);
  const linkClass = "font-medium text-zinc-700 underline decoration-zinc-950/15 underline-offset-2 hover:text-zinc-950 hover:decoration-zinc-950/40 focus-ring dark:text-zinc-300 dark:decoration-white/20 dark:hover:text-white dark:hover:decoration-white/40";
</script>

<div class="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start">
  <div class="grid min-w-0 flex-1 gap-1.5">
    <div class="flex items-start gap-3">
      <p class="line-clamp-2 min-w-0 flex-1 text-base/6 font-medium break-words text-zinc-950 sm:text-sm/6 dark:text-white" title={schedule.prompt}>{schedule.prompt}</p>
      <Badge tone={look.tone}>{look.label}</Badge>
    </div>
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
      <div class="flex min-w-0 items-center gap-1">
        <dt>Thread</dt>
        <dd class="truncate"><a href="/threads/{schedule.threadId}" class={linkClass}>{thread?.title ?? "Thread"}</a></dd>
      </div>
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
  </div>
  <ScheduleActions {schedule} {onchange} />
</div>

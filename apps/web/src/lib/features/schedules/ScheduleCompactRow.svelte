<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatDateTime, formatRelative, isoDateTime } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ScheduleActions from "./ScheduleActions.svelte";
  import ScheduleStatus from "./ScheduleStatus.svelte";
  import { describeWhen } from "./schedules.ts";

  /** A narrow row for the thread panel; state and actions match the Settings list. */
  let { schedule, onchange, class: className }: {
    schedule: ui.Schedule; onchange?: ((schedule: ui.Schedule) => void) | undefined; class?: ClassValue;
  } = $props();
</script>

<div class={["flex items-start gap-3 rounded-lg py-1.5 pr-1.5 pl-3", className]}>
  <div class="flex h-lh shrink-0 items-center text-base/6 sm:text-sm/6">
    <Icon name={schedule.createdBy === "agent" ? "sparkles" : schedule.kind === "once" ? "clock" : "arrow-path"}
      class={schedule.createdBy === "agent" ? "fill-violet-500 dark:fill-violet-400" : "fill-zinc-400 dark:fill-zinc-500"} />
  </div>
  <div class="grid min-w-0 flex-1 gap-0.5">
    <p class="truncate text-base/6 text-zinc-700 sm:text-sm/6 dark:text-zinc-300" title={schedule.prompt}>{schedule.name || schedule.prompt}</p>
    <ScheduleStatus status={schedule.status} />
    <p class="text-base/6 text-zinc-500 sm:text-sm/5 dark:text-zinc-400">
      {describeWhen(schedule)}
      {#if schedule.nextRunAt}
        · <time datetime={isoDateTime(schedule.nextRunAt)} title={formatDateTime(schedule.nextRunAt)}>next {formatRelative(schedule.nextRunAt, clock.now)}</time>
      {/if}
      {#if schedule.createdBy === "agent"}<span class="sr-only"> (set by an agent)</span>{/if}
    </p>
  </div>
  <ScheduleActions {schedule} compact {onchange} />
</div>

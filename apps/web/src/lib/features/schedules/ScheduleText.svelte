<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { scheduleHeading } from "@canopy/domain/schedule-display";
  import ScheduleStatus from "./ScheduleStatus.svelte";

  let { schedule }: { schedule: ui.Schedule } = $props();
  const heading = $derived(scheduleHeading(schedule));
</script>

<div class="flex min-w-0 items-center gap-2">
  <p class="min-w-0 flex-1 truncate text-base/5 font-medium text-zinc-950 sm:text-sm/5 dark:text-white" title={heading}>
    {heading}
  </p>
  <ScheduleStatus status={schedule.status} />
</div>
{#if heading !== schedule.prompt}
  <p class="truncate text-sm/5 text-zinc-500 dark:text-zinc-400" title={schedule.prompt}>{schedule.prompt}</p>
{/if}

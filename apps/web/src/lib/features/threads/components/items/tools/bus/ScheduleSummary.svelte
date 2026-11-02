<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";
  import LongText from "#lib/shared/ui/LongText.svelte";
  import { scheduleStatusLook } from "#lib/features/schedules/schedules.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import type { ScheduleView } from "../agent-bus.ts";

  /** A schedule in words: when it runs, the next run, its limits and the prompt it will deliver. */
  let { schedule }: { schedule: ScheduleView } = $props();
  const status = $derived(schedule.status ? scheduleStatusLook(schedule.status) : undefined);
</script>

<div class="grid min-w-0 gap-1">
  <p class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-base/6 sm:text-sm/6">
    <Icon name="clock" class="shrink-0 fill-zinc-400 dark:fill-zinc-500" />
    <span class="font-medium text-zinc-950 dark:text-white">{schedule.when}</span>
    {#if status}<Badge tone={status.tone}>{status.label}</Badge>{/if}
  </p>
  {#if schedule.next || schedule.limits}
    <p class="pl-6 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{[schedule.next && `Next run ${schedule.next}`, schedule.limits].filter(Boolean).join(" · ")}</p>
  {/if}
  {#if schedule.prompt}<LongText text={schedule.prompt} markdown lines={3} class="pl-6" />{/if}
</div>

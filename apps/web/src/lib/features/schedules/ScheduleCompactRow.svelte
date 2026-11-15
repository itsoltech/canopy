<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatDateTime, formatRelative, isoDateTime } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ScheduleActions from "./ScheduleActions.svelte";
  import ScheduleStatus from "./ScheduleStatus.svelte";
  import { describeWhen } from "./schedules.ts";

  /**
   * A two-line row for the thread panel: name, then timing. Active is the default state, so only other states
   * get a badge; the full date stays in the tooltip. State and actions match the Settings list.
   */
  let {
    schedule,
    onchange,
    disabled = false,
    class: className,
  }: {
    schedule: ui.Schedule;
    onchange?: ((schedule: ui.Schedule) => void) | undefined;
    disabled?: boolean;
    class?: ClassValue;
  } = $props();

  const next = $derived(schedule.nextRunAt ? formatRelative(schedule.nextRunAt, clock.now) : "");
  const once = $derived(schedule.kind === "once");
  const timing = $derived(once && next ? `Once, ${next}` : describeWhen(schedule));
</script>

<div class={["flex min-w-0 items-start gap-2 rounded-lg py-1 pr-0.5 pl-2", className]}>
  <div class="flex h-5 shrink-0 items-center">
    <Icon
      name={schedule.createdBy === "agent" ? "sparkles" : once ? "clock" : "arrow-path"}
      class={schedule.createdBy === "agent"
        ? "text-violet-500 dark:text-violet-400"
        : "fill-zinc-400 dark:fill-zinc-500"}
    />
  </div>
  <div class="min-w-0 flex-1">
    <p class="truncate text-base/5 text-zinc-700 sm:text-sm/5 dark:text-zinc-300" title={schedule.prompt}>
      {schedule.name || schedule.prompt}
    </p>
    <p
      class="flex min-w-0 items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400"
      title={schedule.nextRunAt ? `Next run ${formatDateTime(schedule.nextRunAt)}` : undefined}
    >
      {#if schedule.status !== "active"}<ScheduleStatus status={schedule.status} />{/if}
      <span class="min-w-0 truncate">
        {timing}
        {#if next && !once}
          · <time datetime={isoDateTime(schedule.nextRunAt)}>next {next}</time>
        {/if}
      </span>
      {#if schedule.createdBy === "agent"}<span class="sr-only"> (set by an agent)</span>{/if}
    </p>
  </div>
  <ScheduleActions {schedule} compact {onchange} {disabled} class="self-center" />
</div>

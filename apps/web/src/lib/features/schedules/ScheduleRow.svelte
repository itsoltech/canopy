<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { splitId } from "@canopy/domain/computers";
  import { awayReason, computerName, formatPresenceTime } from "@canopy/domain/computer-presence";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatDateTime, formatRelative, isoDateTime } from "#lib/shared/format.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import { expandGrid } from "#lib/shared/ui/motion.ts";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import ScheduleActions from "./ScheduleActions.svelte";
  import ScheduleRuns from "./ScheduleRuns.svelte";
  import ScheduleText from "./ScheduleText.svelte";
  import { describeWhen, isFinished, placementLabels, runsLabel } from "./schedules.ts";
  import { modelDisplayName } from "#lib/features/models/catalog.ts";

  let {
    schedule,
    onchange,
    class: className,
  }: { schedule: ui.Schedule; onchange?: ((schedule: ui.Schedule) => void) | undefined; class?: ClassValue } = $props();

  const overview = useOverview();
  let open = $state(false);
  const detailsId = $props.id();
  const home = $derived(splitId(schedule.id).node);
  const computer = $derived(home ? [...overview.computers.values()].find((c) => c.nodeId.startsWith(home)) : undefined);
  const reason = $derived(home ? awayReason(computer, formatPresenceTime) : undefined);
  const thread = $derived(overview.threads.get(schedule.threadId));
  const creator = $derived(overview.threads.get(schedule.createdByThreadId));

  const worker = $derived(overview.worker(thread?.workerId || schedule.recentRuns[0]?.workerId || ""));

  const machine = $derived(worker?.name || (computer ? computerName(computer) : ""));

  const author = $derived(
    schedule.createdBy === "agent" ? `Created by agent${creator ? ` in ${creator.title}` : ""}` : "Created by you",
  );
</script>

<div class={["flex items-start gap-1 px-3 py-2", reason && "opacity-50", className]}>
  <div class="@container grid min-w-0 flex-1 gap-0.5">
    <ScheduleText {schedule} />
    <div
      class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 text-sm/5 text-zinc-500 @xl:grid-cols-[minmax(0,auto)_auto_minmax(0,1fr)_minmax(0,auto)_auto] dark:text-zinc-400"
    >
      <span class="col-start-1 row-start-1 truncate" title={describeWhen(schedule)}>{describeWhen(schedule)}</span>
      <div class="col-start-2 row-start-1 shrink-0">
        <Button
          variant="text"
          size="sm"
          icon={open ? "chevron-down" : "chevron-right"}
          aria-expanded={open}
          aria-controls={detailsId}
          title="Show task details and recent runs"
          onclick={() => (open = !open)}>{schedule.runs} {schedule.runs === 1 ? "run" : "runs"}</Button
        >
      </div>
      {#if schedule.target === "new_thread"}
        <span
          class="col-span-2 col-start-1 row-start-2 min-w-0 truncate @xl:col-span-1 @xl:col-start-3 @xl:row-start-1"
          title={`New thread in ${overview.project(schedule.projectId)?.name ?? "project"} · ${placementLabels.get(schedule.newThread?.placement ?? "any")}`}
          >New thread</span
        >
      {:else}
        <a
          href="/threads/{schedule.threadId}"
          class="col-span-2 col-start-1 row-start-2 min-w-0 truncate rounded focus-ring hover:text-zinc-950 @xl:col-span-1 @xl:col-start-3 @xl:row-start-1 dark:hover:text-white"
          title={thread?.title ?? "Open thread"}>{thread?.title ?? "Open thread"}</a
        >
      {/if}
      {#if machine}<span
          class="col-start-3 row-start-2 max-w-24 truncate @xl:col-start-4 @xl:row-start-1"
          title={machine}>{machine}</span
        >{/if}
      <div class="col-start-3 row-start-1 justify-self-end @xl:col-start-5">
        <IconButton
          icon={schedule.createdBy === "agent" ? "sparkles" : "user"}
          label={author}
          size="sm"
          onclick={() => (open = !open)}
        />
      </div>
    </div>
    {#if reason}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">{reason} Read-only</p>{/if}
    {#if open}
      <div id={detailsId} class="-mt-0.5 grid grid-rows-[1fr]" transition:expandGrid>
        <div class="grid min-h-0 min-w-0 gap-2 overflow-hidden pt-2.5 text-sm/5 text-zinc-500 dark:text-zinc-400">
          <p class="wrap-anywhere">{describeWhen(schedule)}</p>
          {#if schedule.maxRuns}<p>{runsLabel(schedule)}</p>{/if}
          <p class="wrap-anywhere whitespace-pre-wrap text-zinc-700 select-text dark:text-zinc-300">
            {schedule.prompt}
          </p>
          {#if schedule.target === "new_thread" && schedule.newThread}
            <p class="wrap-anywhere">
              New thread in {overview.project(schedule.projectId)?.name ?? "project"} · {placementLabels.get(
                schedule.newThread.placement,
              )} · {modelDisplayName(schedule.newThread.model)}
            </p>
          {/if}
          <p class="wrap-anywhere">
            {author}{#if creator && creator.id !== schedule.threadId}
              · <a class="rounded focus-ring hover:text-zinc-950 dark:hover:text-white" href="/threads/{creator.id}"
                >Open creator thread</a
              >{/if}
          </p>
          {#if !isFinished(schedule) && schedule.nextRunAt}
            <p>
              {schedule.status === "paused" ? "Was due" : "Next run"}
              <time datetime={isoDateTime(schedule.nextRunAt)} title={formatDateTime(schedule.nextRunAt)}
                >{formatRelative(schedule.nextRunAt, clock.now)}</time
              >
            </p>
          {/if}
          {#if schedule.lastEditedAt}<p>Edited by you · {formatRelative(schedule.lastEditedAt, clock.now)}</p>{/if}
          {#if schedule.recentRuns.length}<ScheduleRuns runs={schedule.recentRuns} threadId={schedule.threadId} />{/if}
        </div>
      </div>
    {/if}
  </div>
  {#if !isFinished(schedule)}<div class="w-8 shrink-0"><ScheduleActions {schedule} compact {onchange} /></div>{/if}
</div>

<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { ui } from "@canopy/contracts";
  import { untrack } from "svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { listSchedules } from "#lib/features/schedules/api.ts";
  import ScheduleDialog from "#lib/features/schedules/ScheduleDialog.svelte";
  import ScheduleRow from "#lib/features/schedules/ScheduleRow.svelte";
  import { isFinished, sortSchedules, upsertSchedule } from "#lib/features/schedules/schedules.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import { decode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";

  /**
   * Scheduled tasks across projects: yours and the ones agents set,
   * upcoming or finished, with pause, resume and cancel. New ones, runs and status changes arrive live.
   */
  let { data }: PageProps = $props();
  const overview = useOverview();

  let schedules = $state.raw(untrack(() => decode(ui.ListSchedulesResponseSchema, data.schedules).schedules));
  const upsert = (schedule: ui.Schedule) => (schedules = upsertSchedule(schedules, schedule));

  $effect(() =>
    overview.subscribe((update) => {
      if (update.change.case === "schedule") upsert(update.change.value);

      if (
        update.change.case === "computer" ||
        update.change.case === "computerRemoved" ||
        (update.change.case === "linkedReadCompleted" && update.change.value === "ListSchedules")
      )
        void listSchedules({ includeFinished: true }).then(
          (list) => (schedules = list),
          () => undefined,
        );
    }),
  );

  $effect(() => {
    // After a gap in the stream: what changed meanwhile.
    if (overview.resyncs > 0)
      void listSchedules({ includeFinished: true }).then(
        (list) => (schedules = list),
        () => undefined,
      );
  });

  let view = $state("upcoming");
  const upcoming = $derived(sortSchedules(schedules.filter((s) => !isFinished(s))));
  const finished = $derived(sortSchedules(schedules.filter(isFinished)));
  const shown = $derived(view === "upcoming" ? upcoming : finished);

  let creating = $state(false);
  const threads = $derived([...overview.threads.values()].sort((a, b) => a.title.localeCompare(b.title)));
</script>

<svelte:head><title>Scheduled tasks · Settings · {applicationName}</title></svelte:head>

<div class="grid grid-cols-1 gap-4">
  <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-1">
    <h2 class="text-base/7 font-semibold text-zinc-950 dark:text-white">Scheduled tasks</h2>
    <Button variant="primary" size="sm" icon="plus" onclick={() => (creating = true)}>New task</Button>
    <p class="col-span-2 text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      Messages sent once or on repeat.
    </p>
  </div>

  <SegmentedChoice
    label="Show scheduled tasks"
    bind:value={view}
    options={[
      { value: "upcoming", label: `Upcoming ${upcoming.length}` },
      { value: "finished", label: `Finished ${finished.length}` },
    ]}
  />

  {#if shown.length > 0}
    <SettingsGroup>
      <ul role="list" class="divide-y divide-zinc-950/5 dark:divide-white/8">
        {#each shown as schedule (schedule.id)}
          <li><ScheduleRow {schedule} onchange={upsert} /></li>
        {/each}
      </ul>
    </SettingsGroup>
  {:else}
    <EmptyState
      icon="clock"
      title={view === "upcoming" ? "Nothing scheduled" : "No finished tasks"}
      description={view === "upcoming"
        ? "Create a task to send a message later."
        : "Completed and cancelled tasks appear here."}
    />
  {/if}
</div>

<ScheduleDialog bind:open={creating} {threads} oncreated={upsert} />

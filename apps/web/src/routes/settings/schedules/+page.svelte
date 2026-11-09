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

  let view = $state<"upcoming" | "finished">("upcoming");
  const upcoming = $derived(sortSchedules(schedules.filter((s) => !isFinished(s))));
  const finished = $derived(sortSchedules(schedules.filter(isFinished)));
  const shown = $derived(view === "upcoming" ? upcoming : finished);

  let creating = $state(false);
  const threads = $derived([...overview.threads.values()].sort((a, b) => a.title.localeCompare(b.title)));

  const tab =
    "flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-base/6 font-medium text-zinc-600 has-checked:bg-white has-checked:text-zinc-950 has-checked:shadow-xs has-checked:ring-1 has-checked:ring-zinc-950/10 has-focus-visible:outline-2 has-focus-visible:outline-brand-500 pointer-coarse:min-h-12 sm:py-1 sm:text-sm/6 dark:text-zinc-400 dark:has-checked:bg-white/10 dark:has-checked:text-white dark:has-checked:shadow-none dark:has-checked:ring-white/10";
</script>

<svelte:head><title>Scheduled tasks · Settings · {applicationName}</title></svelte:head>

<div class="grid grid-cols-1 gap-4">
  <div class="flex flex-wrap items-end justify-between gap-4 px-1">
    <div class="min-w-0">
      <h2 class="text-base/7 font-semibold text-zinc-950 dark:text-white">Scheduled tasks</h2>
      <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Messages that start a turn on their own at a set time. You and your agents create them.
      </p>
    </div>
    <Button variant="primary" size="sm" icon="plus" onclick={() => (creating = true)}>New task</Button>
  </div>

  <div role="radiogroup" aria-label="Show" class="flex w-fit gap-0.5 rounded-lg bg-zinc-950/5 p-0.5 dark:bg-white/5">
    <label class={tab}>
      <input type="radio" name="view" value="upcoming" class="sr-only" bind:group={view} />Upcoming<span
        class="text-zinc-500 tabular-nums dark:text-zinc-400">{upcoming.length}</span
      >
    </label>
    <label class={tab}>
      <input type="radio" name="view" value="finished" class="sr-only" bind:group={view} />Finished<span
        class="text-zinc-500 tabular-nums dark:text-zinc-400">{finished.length}</span
      >
    </label>
  </div>

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
        ? "Send a message to a thread later, once or on repeat. Agents can schedule their own wake-ups too."
        : "Tasks that ran once or were cancelled appear here."}
    />
  {/if}
</div>

<ScheduleDialog bind:open={creating} {threads} oncreated={upsert} />

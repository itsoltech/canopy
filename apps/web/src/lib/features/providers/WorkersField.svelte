<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import Fieldset from "#lib/shared/ui/Fieldset.svelte";

  /**
   * Where an instance runs: every worker (also ones registered later) or the chosen ones. `onchange` gets the new
   * choice (the caller saves it).
   */
  let {
    workers,
    allWorkers,
    workerIds,
    error,
    disabled = false,
    onchange,
    class: className,
  }: {
    workers: readonly ui.Worker[];
    allWorkers: boolean;
    workerIds: readonly string[];
    error?: string | undefined;
    disabled?: boolean;
    onchange: (next: { allWorkers: boolean; workerIds: string[] }) => void;
    class?: ClassValue;
  } = $props();
</script>

<Fieldset
  legend="Workers"
  description="Only these workers get the instance; elsewhere it is absent."
  {error}
  {disabled}
  class={className}
>
  <SettingsRow title="All workers" description="Including workers registered later.">
    {#snippet control()}<Switch
        name="all-workers"
        label="All workers"
        bind:checked={
          () => allWorkers, (all) => onchange({ allWorkers: all, workerIds: all ? [] : workers.map((w) => w.id) })
        }
      />{/snippet}
  </SettingsRow>
  {#if !allWorkers}
    <div class="divide-y divide-zinc-950/5 dark:divide-white/8">
      {#each workers as worker (worker.id)}
        <SettingsRow title={worker.name} description={worker.hostname || worker.id.slice(-8)}>
          {#snippet control()}<Switch
              name="worker-{worker.id}"
              label={worker.name}
              bind:checked={
                () => workerIds.includes(worker.id),
                (on) =>
                  onchange({
                    allWorkers: false,
                    workerIds: on ? [...workerIds, worker.id] : workerIds.filter((id) => id !== worker.id),
                  })
              }
            />{/snippet}
        </SettingsRow>
      {/each}
    </div>
  {/if}
</Fieldset>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
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
  <Checkbox
    name="all-workers"
    label="All workers"
    description="Including workers registered later."
    bind:checked={
      () => allWorkers, (all) => onchange({ allWorkers: all, workerIds: all ? [] : workers.map((w) => w.id) })
    }
  />
  {#if !allWorkers}
    <div class="grid gap-2 pl-8 sm:pl-7">
      {#each workers as worker (worker.id)}
        <Checkbox
          name="worker-{worker.id}"
          label={worker.name}
          description={worker.hostname || worker.id.slice(-8)}
          bind:checked={
            () => workerIds.includes(worker.id),
            (on) =>
              onchange({
                allWorkers: false,
                workerIds: on ? [...workerIds, worker.id] : workerIds.filter((id) => id !== worker.id),
              })
          }
        />
      {/each}
    </div>
  {/if}
</Fieldset>

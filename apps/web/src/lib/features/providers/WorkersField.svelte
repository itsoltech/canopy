<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import AccessPicker from "#lib/features/access/AccessPicker.svelte";
  import { workerAccessOptions } from "#lib/features/access/access-options.ts";
  import type { WorkerRecords } from "#lib/features/workers/worker-records.svelte.ts";

  /**
   * Where an instance runs: every worker (also ones registered later) or the chosen ones. `onchange` gets the new
   * choice when the picker closes (the caller saves it).
   */
  let {
    workers,
    records,
    allWorkers,
    workerIds,
    error,
    saving = false,
    disabled = false,
    onchange,
    class: className,
  }: {
    workers: readonly ui.Worker[];
    records?: WorkerRecords;
    allWorkers: boolean;
    workerIds: readonly string[];
    error?: string | undefined;
    saving?: boolean;
    disabled?: boolean;
    onchange: (next: { allWorkers: boolean; workerIds: string[] }) => void;
    class?: ClassValue;
  } = $props();

  const options = $derived(
    records
      ? workerAccessOptions(records, workers)
      : workers.map((w) => ({ id: w.id, name: w.name, online: w.online })),
  );
</script>

<AccessPicker
  label="Workers"
  description="The instance runs only on the chosen workers."
  icon="computer-desktop"
  {options}
  all={allWorkers}
  ids={workerIds}
  {saving}
  {disabled}
  {error}
  onchange={(next) => onchange({ allWorkers: next.all, workerIds: next.all ? [] : [...next.ids] })}
  class={className}
/>

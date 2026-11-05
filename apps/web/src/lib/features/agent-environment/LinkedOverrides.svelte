<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { workerRecords } from "#lib/features/workers/worker-records.svelte.ts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import RemoteEnvironment from "./RemoteEnvironment.svelte";

  let { class: className }: { class?: ClassValue } = $props();

  const overview = useOverview();
  const records = workerRecords(overview);
  let workerId = $state("");
</script>

{#if records.records.length}
  <div class={["grid min-w-0 gap-4 border-t border-zinc-950/10 pt-4 dark:border-white/10", className]}>
    <Field
      class="min-w-0"
      label="Overrides on linked computers"
      description="Edit the worker's saved library independently of this draft."
    >
      <Select
        class="min-w-0"
        name="linked-machine-override"
        bind:value={workerId}
        options={records.options(records.workers.filter((w) => !!w.nodeId))}
      />
    </Field>
    {#if workerId}{#key workerId}<RemoteEnvironment
          {workerId}
          readOnly={records.readOnly(workerId)}
          preview={false}
        />{/key}{/if}
  </div>
{/if}

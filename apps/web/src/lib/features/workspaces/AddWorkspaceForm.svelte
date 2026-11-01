<script lang="ts">
  import { enhance } from "$app/forms";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import DirectoryPicker from "./DirectoryPicker.svelte";

  /** Adds a directory on an online worker as a workspace of the project. */
  let { error, onadded }: { error?: string | undefined; onadded?: () => void } = $props();
  const overview = useOverview();
  const onlineWorkers = $derived(overview.workers.filter((w) => w.online));

  let workerId = $state("");
  let rootPath = $state("");
  let busy = $state(false);
  const worker = $derived(overview.worker(workerId));
</script>

<form
  method="POST"
  action="?/createWorkspace"
  class="grid gap-4"
  use:enhance={() => {
    busy = true;
    return async ({ result, update }) => {
      await update();
      busy = false;
      if (result.type === "success") onadded?.();
    };
  }}
>
  <Field label="Worker" description={onlineWorkers.length === 0 ? "No worker is online. Start one to browse its directories." : undefined}>
    <Select name="workerId" bind:value={workerId} required disabled={onlineWorkers.length === 0}>
      <option value="" disabled>Choose an online worker…</option>
      {#each onlineWorkers as w (w.id)}<option value={w.id}>{w.name}</option>{/each}
    </Select>
  </Field>
  {#if workerId}
    <div class="grid gap-1.5">
      <p class="text-base/6 font-medium sm:text-sm/6">Directory</p>
      <DirectoryPicker {workerId} os={worker?.os ?? ""} bind:value={rootPath} />
    </div>
    <input type="hidden" name="rootPath" value={rootPath} />
    <input type="hidden" name="label" value={worker?.name ?? ""} />
  {/if}
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <div>
    <Button type="submit" icon="plus" loading={busy} disabled={!rootPath}>Add workspace</Button>
  </div>
</form>

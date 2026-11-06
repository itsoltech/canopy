<script lang="ts">
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import WorkerDetails from "#lib/features/workers/WorkerDetails.svelte";
  import WorkerStatusBadges from "#lib/features/workers/WorkerStatusBadges.svelte";
  import { workerMeta } from "#lib/features/workers/worker-summary.ts";
  import { workerEnvironment } from "#lib/features/workers/worker-environment.svelte.ts";
  import { workerRecords } from "#lib/features/workers/worker-records.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import { useSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import SettingsCard from "#lib/shared/ui/SettingsCard.svelte";

  /** One worker: the same header facts and sections as an expanded worker in Settings → Workers. */
  const route = useSettingsRoute();
  const overview = useOverview();
  const environment = workerEnvironment(overview);
  const records = workerRecords(overview);
  const id = $derived(route.params.workerId ?? "");
  const record = $derived(records.record(id));
  const linked = $derived(record && records.linked(record));
  const worker = $derived(overview.worker(id) ?? linked?.worker);
  const where = $derived(record ? `“${record.computerName}”` : records.records.length ? "this computer" : "");
</script>

<svelte:head><title>{worker?.name ?? "Worker"} · Settings · Canopy</title></svelte:head>

<SettingsHeading
  title={worker?.name ?? "Worker"}
  description={worker ? [where && `On ${where}`, workerMeta(worker)].filter(Boolean).join(" · ") : undefined}
>
  {#snippet actions()}{#if worker}<WorkerStatusBadges {worker} {linked} />{/if}{/snippet}
</SettingsHeading>

{#if worker}
  <SettingsCard>
    <WorkerDetails {worker} {environment} {linked} reason onchanged={() => void records.reload()} />
  </SettingsCard>
  {#if environment.error}<Alert tone="error"
      >{environment.error}{#snippet actions()}<Button size="sm" onclick={() => void environment.refresh()}
          >Refresh tags</Button
        >{/snippet}</Alert
    >{/if}
{:else if records.loaded}
  <Alert tone="info">This worker is not registered (or was archived).</Alert>
{/if}

<script lang="ts">
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import WorkerSettings from "#lib/features/overview/WorkerSettings.svelte";
  import WorkerCliTools from "#lib/features/workers/WorkerCliTools.svelte";
  import WorkerTagEditor from "#lib/features/workers/WorkerTagEditor.svelte";
  import { workerEnvironment } from "#lib/features/workers/worker-environment.svelte.ts";
  import { workerRecords } from "#lib/features/workers/worker-records.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import { useSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import StatusBadge from "#lib/shared/ui/StatusBadge.svelte";

  /** One worker: the machine and its configuration; its provider instances are set in Settings → Providers. */
  const route = useSettingsRoute();
  const overview = useOverview();
  const environment = workerEnvironment(overview);
  const records = workerRecords(overview);
  const id = $derived(route.params.workerId ?? "");
  const record = $derived(records.record(id));
  const linked = $derived(record && records.linked(record));
  const worker = $derived(overview.worker(id) ?? linked?.worker);
  const readOnly = $derived(linked?.readOnly ?? "");
</script>

<svelte:head><title>{worker?.name ?? "Worker"} · Settings · Canopy</title></svelte:head>

<SettingsHeading
  title={worker?.name ?? "Worker"}
  description={record
    ? `Worker on “${record.computerName}”.`
    : records.records.length
      ? "Worker on this computer."
      : undefined}
>
  {#snippet actions()}{#if worker}<StatusBadge
        status={worker.online && !readOnly ? "online" : "offline"}
      />{/if}{/snippet}
</SettingsHeading>

{#if worker}
  {#if readOnly}<Alert title={readOnly}>These are the last saved settings.</Alert>{/if}
  <WorkerSettings {worker} title="Machine" />
  {#key worker.id}<WorkerTagEditor {worker} {environment} {linked} onchanged={() => void records.reload()} />{/key}
  {#if environment.error}<Alert tone="error"
      >{environment.error}{#snippet actions()}<Button size="sm" onclick={() => void environment.refresh()}
          >Refresh tags</Button
        >{/snippet}</Alert
    >{/if}
  <WorkerCliTools {worker} {readOnly} />
{:else if records.loaded}
  <Alert tone="info">This worker is not registered (or was archived).</Alert>
{/if}

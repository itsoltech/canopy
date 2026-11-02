<script lang="ts">
  import { page } from "$app/state";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import WorkerSettings from "#lib/features/overview/WorkerSettings.svelte";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import StatusBadge from "#lib/shared/ui/StatusBadge.svelte";

  /** One worker: the machine and its configuration; its provider instances are set in Settings → Providers. */
  const overview = useOverview();
  const worker = $derived(overview.worker(page.params.workerId ?? ""));
</script>

<svelte:head><title>{worker?.name ?? "Worker"} · Settings · Open Agents</title></svelte:head>

<SettingsHeading title={worker?.name ?? "Worker"}>
  {#snippet actions()}{#if worker}<StatusBadge status={worker.online ? "online" : "offline"} />{/if}{/snippet}
</SettingsHeading>

{#if worker}
  <WorkerSettings {worker} title="Machine" />
{:else}
  <Alert tone="info">This worker is not registered (or was archived).</Alert>
{/if}

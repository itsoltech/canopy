<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import WorkerDetails from "#lib/features/workers/WorkerDetails.svelte";
  import WorkerStatusBadges from "#lib/features/workers/WorkerStatusBadges.svelte";
  import { workerMeta } from "#lib/features/workers/worker-summary.ts";
  import { workerEnvironment } from "#lib/features/workers/worker-environment.svelte.ts";
  import { workerRecords } from "#lib/features/workers/worker-records.svelte.ts";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import { useSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  const cliAnchor = "agent-clis";

  const route = useSettingsRoute();
  const overview = useOverview();
  const environment = workerEnvironment();
  const records = workerRecords(overview);
  const id = $derived(route.params.workerId ?? "");

  const linked = $derived(
    records.computers.flatMap((computer) => computer.workers).find((entry) => entry.worker.id === id),
  );

  const worker = $derived(overview.worker(id) ?? linked?.worker);
  const where = $derived(linked ? `“${linked.record.computerName}”` : records.records.length ? "this computer" : "");
  const anchoredWorker = $derived(route.url.hash === `#${cliAnchor}` ? worker?.id : undefined);

  $effect(() => {
    if (!anchoredWorker) return;

    const frame = requestAnimationFrame(() => {
      const heading = document.getElementById(cliAnchor);
      heading?.scrollIntoView({ block: "start" });
      heading?.focus({ preventScroll: true });
    });

    return () => cancelAnimationFrame(frame);
  });
</script>

<svelte:head><title>{worker?.name ?? "Worker"} · Settings · {applicationName}</title></svelte:head>

<SettingsHeading
  title={worker?.name ?? "Worker"}
  description={worker ? [where && `On ${where}`, workerMeta(worker)].filter(Boolean).join(" · ") : undefined}
>
  {#snippet actions()}{#if worker}<WorkerStatusBadges {worker} {linked} />{/if}{/snippet}
</SettingsHeading>

{#if worker}
  {#key worker.id}
    <WorkerDetails
      {worker}
      {environment}
      {linked}
      {cliAnchor}
      defaultTopic={anchoredWorker ? cliAnchor : undefined}
      onchanged={() => void records.reload()}
    />
  {/key}
{:else if records.error}
  <Alert tone="error">
    {records.error}
    {#snippet actions()}<Button size="sm" onclick={() => void records.reload()}>Retry</Button>{/snippet}
  </Alert>
{:else if records.loaded}
  <Alert tone="info">This worker is not registered (or was archived).</Alert>
{/if}

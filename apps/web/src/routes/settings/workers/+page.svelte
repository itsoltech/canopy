<script lang="ts">
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { onMount } from "svelte";
  import { timestampDate } from "@bufbuild/protobuf/wkt";
  import WorkerRow from "#lib/features/workers/WorkerRow.svelte";
  import AddWorkerWizard from "#lib/features/workers/AddWorkerWizard.svelte";
  import { WorkerSetup } from "#lib/features/workers/worker-setup.svelte.ts";
  import { workerEnvironment } from "#lib/features/workers/worker-environment.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import WorkerConnectionSettings from "#lib/features/workers/WorkerConnectionSettings.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import UpdatesPanel from "#lib/features/workers/UpdatesPanel.svelte";
  import CliUpdatesSummary from "#lib/features/workers/CliUpdatesSummary.svelte";
  import WorkerSshKey from "#lib/features/workers/WorkerSshKey.svelte";
  import NetworkAccessSummary from "#lib/features/network/NetworkAccessSummary.svelte";
  import { useNetworkAccess } from "#lib/features/network/network-access.svelte.ts";

  const overview = useOverview();
  const online = $derived(overview.ownWorkers.filter((w) => w.online).length);
  const setup = new WorkerSetup();
  const environment = workerEnvironment(overview);
  const network = useNetworkAccess();
  let adding = $state(false);
  let error = $state("");
  let now = $state(Date.now());

  const pending = $derived(
    setup.enrollments.filter(
      (e) => !e.usedAt && !e.revokedAt && e.expiresAt && timestampDate(e.expiresAt).getTime() > now,
    ),
  );

  onMount(() => {
    void setup.reload();
    const unsubscribe = overview.subscribe((update) => setup.apply(update));
    const timer = setInterval(() => (now = Date.now()), 1000);

    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  });

  $effect(() => {
    if (overview.resyncs > 0) void setup.reload();
  });

  async function revoke(id: string) {
    try {
      await setup.revoke(id);
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not revoke enrollment";
    }
  }
</script>

<svelte:head><title>Workers · Settings · Canopy</title></svelte:head>

<div class="flex flex-wrap items-start justify-between gap-4 px-1">
  <div class="min-w-0">
    <h1 class="text-base/7 font-semibold text-zinc-950 dark:text-white">Workers</h1>
    <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      Your machines, connected to Canopy. <span class="tabular-nums">{online} of {overview.ownWorkers.length}</span> connected.
    </p>
  </div>
  <div class="shrink-0">
    <Button variant="primary" icon="plus" disabled={!setup.loaded} onclick={() => (adding = true)}>Add worker</Button>
  </div>
</div>
{#if setup.error || error}<Alert tone="error"
    >{error || setup.error}{#snippet actions()}<Button size="sm" onclick={() => void setup.reload()}>Retry</Button
      >{/snippet}</Alert
  >{/if}
<SettingsGroup>
  {#each overview.ownWorkers as worker (worker.id)}<WorkerRow {worker} {setup} {environment} />
  {:else}<SettingsRow
      title="Connect your first machine"
      description="Add a worker to run Claude, Codex or Grok on a machine you control."
    />{/each}
</SettingsGroup>
{#if environment.error}<Alert tone="error"
    >{environment.error}{#snippet actions()}<Button size="sm" onclick={() => void environment.refresh()}
        >Refresh tags</Button
      >{/snippet}</Alert
  >{/if}
{#if overview.workers.some((worker) => worker.nodeId)}
  <p class="px-1 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    Workers from linked computers are managed in Settings → Workers on their home computer.
  </p>
{/if}
<NetworkAccessSummary
  status={network.status}
  loaded={network.loaded}
  busy={network.busy}
  onenable={() =>
    void network
      .update("set_enabled", { enabled: true })
      .then(() => setup.reload())
      .catch((e) => {
        error = e instanceof Error ? e.message : "Could not enable network access";
      })}
/>
<CliUpdatesSummary workers={overview.workers} />
{#if pending.length}
  <SettingsGroup title="Pending enrollments">
    {#each pending as enrollment (enrollment.id)}
      <SettingsRow
        title={enrollment.name}
        description={`Waiting for enrollment · expires ${enrollment.expiresAt ? timestampDate(enrollment.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "soon"}`}
      >
        {#snippet control()}<Button variant="ghost" size="sm" onclick={() => void revoke(enrollment.id)}>Revoke</Button
          >{/snippet}
      </SettingsRow>
    {/each}
  </SettingsGroup>
{/if}
<UpdatesPanel />
<SettingsGroup title="Install over SSH"><WorkerSshKey class="p-4 sm:p-5" /></SettingsGroup>
<WorkerConnectionSettings {setup} />
<AddWorkerWizard {setup} workers={environment.snapshot.workers} bind:open={adding} />

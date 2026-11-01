<script lang="ts">
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import WorkerSettings from "#lib/features/overview/WorkerSettings.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";

  const overview = useOverview();
  const online = $derived(overview.workers.filter((w) => w.online).length);
</script>

<svelte:head><title>Workers · Settings · Open Agents</title></svelte:head>

<div class="px-1">
  <h1 class="text-base/7 font-semibold text-zinc-950 dark:text-white">Workers</h1>
  <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    Machines that run your agents. {online} of {overview.workers.length} online. Register new ones with the gateway CLI (<code class="font-mono">worker add</code>).
  </p>
</div>
{#each overview.workers as worker (worker.id)}
  <WorkerSettings {worker} />
{:else}
  <SettingsGroup>
    <SettingsRow
      title={overview.connection === "unavailable" ? "Workers load once the gateway answers" : "No workers registered"}
      description="Register a worker with the gateway CLI, then start it on its machine."
    />
  </SettingsGroup>
{/each}

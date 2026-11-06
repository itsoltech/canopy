<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import ImportFilters from "#lib/features/imports/ImportFilters.svelte";
  import ImportOverview from "#lib/features/imports/ImportOverview.svelte";
  import ImportSelectionBar from "#lib/features/imports/ImportSelectionBar.svelte";
  import ImportThreadList from "#lib/features/imports/ImportThreadList.svelte";
  import ImportRunRow from "#lib/features/imports/ImportRunRow.svelte";
  import { ImportRunsState } from "#lib/features/imports/import-runs.svelte.ts";
  import { ImportState } from "#lib/features/imports/import-state.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";

  /**
   * Settings → Import (docs/import.md): threads of Claude Code, Codex and Grok on one of this computer's workers.
   * Linked computers import on their own Canopy.
   */
  const overview = useOverview();
  const imports = new ImportState();

  // When a run ends, the list shows the new states (Imported).
  const runs = new ImportRunsState(() => void imports.load());

  onMount(() => {
    void runs.load();

    return () => runs.stop();
  });

  const workers = $derived(overview.workers.filter((w) => !w.nodeId));

  const options = $derived(
    workers.map((w) => ({
      value: w.id,
      label: w.name,
      description: w.online ? undefined : "Offline",
      disabled: !w.online,
    })),
  );

  $effect(() => {
    if (imports.workerId) return;
    const wanted = page.url.searchParams.get("worker");
    const first = workers.find((w) => w.id === wanted) ?? workers.find((w) => w.online);

    if (first) imports.workerId = first.id;
  });

  const workerName = $derived(workers.find((w) => w.id === imports.scan?.workerId)?.name ?? "this worker");
</script>

<svelte:head><title>Import · Settings · Canopy</title></svelte:head>

<div class="settings-stack">
  <SettingsGroup
    title="Import"
    description="Bring threads from Claude Code, Codex and Grok into Canopy. Canopy only reads the CLI files."
  >
    <div class="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div class="min-w-0 sm:w-72">
        <Select
          name="importWorker"
          aria-label="Worker"
          placeholder="Choose a worker"
          {options}
          value={imports.workerId}
          onchange={(value) => (imports.workerId = value)}
        />
      </div>
      <Button
        variant="primary"
        icon="magnifying-glass"
        loading={imports.scanning}
        disabled={!imports.workerId || imports.scanning}
        onclick={() => void imports.runScan()}
      >
        {imports.scan ? "Scan again" : "Scan"}
      </Button>
    </div>
    {#if workers.length === 0}
      <p class="px-4 pb-3 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Add a worker in Workers first. Import reads the CLI files on that computer.
      </p>
    {/if}
  </SettingsGroup>

  {#if runs.runs.length > 0}
    <SettingsGroup title="Imports">
      {#if runs.error}<Alert class="mx-4 mt-3" tone="error">{runs.error}</Alert>{/if}
      <ul role="list" class="divide-y divide-zinc-950/5 dark:divide-white/5">
        {#each runs.runs as run (run.id)}
          <ImportRunRow {run} {runs} />
        {/each}
      </ul>
    </SettingsGroup>
  {/if}

  {#if imports.error}<Alert tone="error">{imports.error}</Alert>{/if}

  {#if imports.scanning}
    <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400" aria-live="polite">
      Looking for Claude Code, Codex and Grok data…
    </p>
    <Skeleton class="h-40 w-full" />
  {:else if imports.scan}
    <SettingsGroup title={`Found on ${workerName}`}>
      <ImportOverview overview={imports.scan.overview} />
      {#if imports.scan.truncated}
        <Alert class="mx-4 mb-3" tone="warning">The scan stopped at its limit. Some threads are not listed.</Alert>
      {/if}
    </SettingsGroup>

    <SettingsGroup title="Threads" description="Choose the threads to import. Each directory maps to a project.">
      <ImportFilters {imports} />
      <ImportSelectionBar {imports} onstart={() => void runs.load()} />
      {#if imports.result}
        <ImportThreadList {imports} />
      {:else}
        <Skeleton class="m-4 h-32" />
      {/if}
    </SettingsGroup>
  {/if}
</div>

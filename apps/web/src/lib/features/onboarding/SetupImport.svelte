<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { page } from "$app/state";
  import type { ui } from "@canopy/contracts";
  import { ImportRunsState } from "#lib/features/imports/import-runs.svelte.ts";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";

  let { worker }: { worker: ui.Worker } = $props();
  const imports = new ImportRunsState(() => {});

  $effect(() => {
    // The background page stays mounted while Settings handles the import.
    const viewingImport = page.shallow?.url.pathname === "/settings/import";

    if (!viewingImport) untrack(() => void imports.load());
  });

  onDestroy(() => imports.stop());

  const run = $derived(imports.runs.find((item) => item.workerId === worker.id));
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
  <ButtonLink href={`/settings/import?worker=${encodeURIComponent(worker.id)}`} variant="secondary">
    Review import
  </ButtonLink>
  {#if run?.status === "running"}
    <span class="text-sm text-zinc-500 dark:text-zinc-400" role="status">Importing threads…</span>
  {:else if run?.status === "paused"}
    <span class="text-sm text-zinc-500 dark:text-zinc-400" role="status">Import paused</span>
  {:else if run?.status === "completed"}
    <span class="text-sm text-zinc-500 dark:text-zinc-400" role="status">Import complete</span>
  {/if}
</div>

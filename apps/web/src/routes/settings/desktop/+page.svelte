<script lang="ts">
  import { onMount } from "svelte";
  import type { DesktopStatus } from "@canopy/ui/desktop";
  import Button from "#lib/shared/ui/Button.svelte";
  import WorkerStatus from "#lib/features/desktop/WorkerStatus.svelte";
  let status = $state<DesktopStatus>();
  onMount(() => {
    const bridge = window.canopyDesktop;
    if (!bridge) return;
    void bridge.status().then((value) => { status = value; });
    return bridge.onStatus((value) => { status = value; });
  });
</script>
<svelte:head><title>Desktop · Settings · Canopy</title></svelte:head>
<div class="grid gap-6">
  {#if status}
    <WorkerStatus {status} />
    <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Manage this computer’s worker and choose where Canopy runs.</p>
    <div><Button onclick={() => window.canopyDesktop?.openSettings()}>Change desktop mode…</Button></div>
  {:else}<p class="text-base/6 sm:text-sm/6">Desktop settings are available in the Canopy desktop app.</p>{/if}
</div>

<script lang="ts">
  import { onMount } from "svelte";
  import type { DesktopStatus } from "@canopy/ui/desktop";
  import Button from "#lib/shared/ui/Button.svelte";
  import WorkerStatus from "#lib/features/desktop/WorkerStatus.svelte";
  import ShareScope from "#lib/features/computers/ShareScope.svelte";

  let status = $state<DesktopStatus>();

  onMount(() => {
    const bridge = window.canopyDesktop;

    if (!bridge) return;
    void bridge.status().then((value) => {
      status = value;
    });

    return bridge.onStatus((value) => {
      status = value;
    });
  });
</script>

<svelte:head><title>Desktop · Settings · Canopy</title></svelte:head>
<div class="settings-stack">
  {#if status}
    <WorkerStatus {status} />
    <div class="flex flex-wrap items-center gap-2">
      <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Manage this computer’s worker and choose where Canopy runs. Desktop settings are never shared.
      </p>
      <ShareScope shared={false} />
    </div>
    <div><Button onclick={() => window.canopyDesktop?.openSettings()}>Change desktop mode…</Button></div>
  {:else}<p class="text-base/6 sm:text-sm/6">Desktop settings are available in the Canopy desktop app.</p>{/if}
</div>

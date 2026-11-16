<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ThreadState } from "../thread-state.svelte.ts";
  import type { ui } from "@canopy/contracts";
  import { plannedGatewayDeparture } from "@canopy/domain/computer-presence";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";

  let {
    view,
    departure,
    class: className,
  }: { view: ThreadState; departure?: ui.GatewayDeparture; class?: ClassValue } = $props();

  let now = $state(Date.now());

  $effect(() => {
    if (!departure || !["updating", "restarting"].includes(departure.state)) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);

    return () => clearInterval(timer);
  });

  const updating = $derived(plannedGatewayDeparture(departure, now));
</script>

{#if updating}
  <Alert tone="info" banner>
    {departure?.state === "restarting"
      ? "Canopy is restarting to update. This thread reconnects automatically."
      : "Canopy is updating. This thread reconnects automatically."}
  </Alert>
{:else if view.failure}
  <Alert tone="warning" banner class={className}>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="min-w-0 flex-1 basis-64">{view.failure}</p>
      <div class="flex shrink-0 gap-2">
        <Button size="sm" variant="ghost" onclick={() => view.history.retry()}>Retry</Button>
        <Button size="sm" variant="ghost" onclick={() => view.history.loadFromScratch()}>Load from scratch</Button>
      </div>
    </div>
  </Alert>
{/if}

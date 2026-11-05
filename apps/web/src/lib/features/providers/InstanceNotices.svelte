<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ConfigNotices from "#lib/features/computers/ConfigNotices.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import { harnessName } from "./instances.ts";

  /**
   * An instance is the same on every linked computer: no switch, only what needs attention. Changes made on two
   * computers at once can be restored here; CLI paths and workers stay per computer.
   */
  let { instance, class: className }: { instance: ui.ProviderInstance; class?: ClassValue } = $props();
  const overview = useOverview();
  const capabilities = useGatewayCapabilities();
  const linked = $derived(!!capabilities?.linkedComputers && overview.computers.size > 0);
  const harness = $derived(harnessName(instance.harness).toLowerCase());

  // Another computer has the CLI or the login; no worker of this one runs the instance (yet).
  const missing = $derived(
    linked &&
      !instance.builtIn &&
      instance.workers.length > 0 &&
      !instance.workers.some((w) => w.enabled && w.available),
  );

  const reason = $derived(instance.workers.find((w) => w.enabled && w.detail)?.detail);
</script>

{#if linked}
  <ConfigNotices
    class={className}
    named={false}
    match={(n) => n.kind === "instance" && n.localId === instance.id && n.globalId.startsWith(`${harness}:`)}
  />
  {#if missing}
    <Alert tone="warning" title="Not available on this computer yet">
      <p>
        No worker here can run this instance{reason ? `: ${reason}` : ""}. Install the CLI or turn the instance on for a
        worker on this computer.
      </p>
    </Alert>
  {/if}
{/if}

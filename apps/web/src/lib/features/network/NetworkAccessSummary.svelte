<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { networkSummary } from "./network.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import ConnectionRequestError from "./ConnectionRequestError.svelte";
  import type { NetworkAccessState } from "./network-access.svelte.ts";

  const capabilities = useGatewayCapabilities();

  /** Network access at a glance on the pages that need it (Mobile devices, Linked computers): where this
   * computer is reachable, or a one-click "Turn on". Details live in Settings → Network access. */
  let {
    network,
    busy = false,
    onenable,
    class: className,
  }: { network: NetworkAccessState; busy?: boolean; onenable: () => void; class?: ClassValue } = $props();

  const status = $derived(network.status);

  const tone = $derived(status.state === "on" ? "emerald" : status.state === "error" ? "rose" : "neutral");

  const title = $derived(
    !network.loaded
      ? network.error
        ? "Network access unavailable"
        : "Checking network access…"
      : status.state === "on"
        ? "Network access is on"
        : status.state === "error"
          ? "Network access can't start"
          : "Network access is off",
  );
</script>

<div class={["grid min-w-0 gap-3", className]}>
  {#if network.error}
    <ConnectionRequestError
      title="Could not check network access"
      error={network.error}
      loaded={network.loaded}
      loading={network.loading}
      onretry={() => void network.reload()}
    />
  {/if}
  <SettingsGroup>
    <SettingsRow
      {title}
      description={network.loaded
        ? [networkSummary(status, capabilities?.linkedComputers), status.note].filter(Boolean).join(" ")
        : undefined}
    >
      {#snippet leading()}<StatusDot {tone} />{/snippet}
      {#snippet control()}
        {#if network.loaded && !network.error && status.state === "off"}<Button
            size="sm"
            disabled={busy || network.loading}
            loading={busy}
            onclick={onenable}>Turn on</Button
          >{/if}
        <ButtonLink size="sm" variant="ghost" href="/settings/network">Manage</ButtonLink>
      {/snippet}
    </SettingsRow>
  </SettingsGroup>
</div>

<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import type { NetworkAccessState } from "../network-access.svelte.ts";
  import CopyValueRow from "./CopyValueRow.svelte";
  import TailscaleHttpsSettings from "./TailscaleHttpsSettings.svelte";
  import { tailscaleState } from "./tailscale.ts";

  /** This computer's Tailscale, read-only: its state, MagicDNS name and tailnet addresses, then HTTPS. */
  let { network }: { network: NetworkAccessState } = $props();

  const status = $derived(network.status.tailscale ?? create(ui.TailscaleSchema));
  const shown = $derived(tailscaleState(status));
  const connected = $derived(status.state === "connected");
  let checking = $state(false);

  async function check() {
    checking = true;

    try {
      await network.update("refresh_tailscale");
    } catch {
      // The page's own request shows a gateway that can't answer.
    } finally {
      checking = false;
    }
  }
</script>

<SettingsGroup title="Tailscale">
  {#snippet actions()}<Button
      size="sm"
      loading={checking}
      disabled={!network.loaded || !!network.error || network.busy}
      onclick={() => void check()}>Check again</Button
    >{/snippet}
  <SettingsRow title="Status" description={shown.description}>
    {#snippet control()}<Badge tone={shown.tone}>{shown.title}</Badge>{/snippet}
  </SettingsRow>
  {#if connected && !status.magicDns}
    <SettingsRow
      title="MagicDNS is off"
      description="Turn it on in the Tailscale admin console to reach this computer by name."
    >
      {#snippet control()}<ButtonLink
          size="sm"
          href="https://login.tailscale.com/admin/dns"
          target="_blank"
          rel="noopener noreferrer">Open admin console</ButtonLink
        >{/snippet}
    </SettingsRow>
  {/if}
  {#if connected && (status.dnsName || status.ipv4.length || status.ipv6.length)}
    <ul role="list" class="divide-y divide-zinc-950/5 dark:divide-white/8">
      {#if status.dnsName && status.magicDns}<CopyValueRow value={status.dnsName} label="MagicDNS name" />{/if}
      {#each [...status.ipv4, ...status.ipv6] as address (address)}
        <CopyValueRow value={address} label={address.includes(":") ? "Tailnet IPv6" : "Tailnet IPv4"} />
      {/each}
    </ul>
  {/if}
</SettingsGroup>
{#if status.https && status.state !== "not_installed"}<TailscaleHttpsSettings {network} https={status.https} />{/if}

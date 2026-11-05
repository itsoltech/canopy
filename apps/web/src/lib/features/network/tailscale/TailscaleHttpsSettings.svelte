<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import type { NetworkAccessState } from "../network-access.svelte.ts";
  import TailscalePortDialog from "./TailscalePortDialog.svelte";
  import UrlQrDialog from "./UrlQrDialog.svelte";
  import { httpsDescription } from "./tailscale.ts";

  /** HTTPS over Tailscale: the switch, the address with a QR code, and its port (docs/tailscale.md). */
  let { network, https }: { network: NetworkAccessState; https: ui.TailscaleHttps } = $props();

  let error = $state("");
  let portOpen = $state(false);
  let qrOpen = $state(false);
  const disabled = $derived(!network.loaded || !!network.error || network.busy);

  async function change(action: string, extra: { enabled?: boolean; port?: number }) {
    error = "";

    try {
      await network.update(action, extra);

      return true;
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not change HTTPS over Tailscale";

      return false;
    }
  }
</script>

<SettingsGroup title="HTTPS over Tailscale">
  <SettingsRow title="Open Canopy over HTTPS" description={httpsDescription(https)}>
    {#snippet control()}<Switch
        name="tailscale-https"
        label="Open Canopy over HTTPS"
        checked={https.enabled}
        disabled={disabled || (!https.enabled && !!https.unavailable)}
        onchange={(enabled) => void change("set_tailscale_https", { enabled })}
      />{/snippet}
  </SettingsRow>
  {#if https.url}
    <SettingsRow title="Address">
      <p class="font-mono text-base/6 break-all text-zinc-950 sm:text-sm/6 dark:text-white">{https.url}</p>
      {#snippet control()}<CopyButton text={https.url} label={`Copy ${https.url}`} /><Button
          size="sm"
          onclick={() => (qrOpen = true)}>Show QR code</Button
        >{/snippet}
    </SettingsRow>
  {/if}
  {#if https.enabled}
    <SettingsRow
      title={https.port ? `Port ${https.port}` : "Port"}
      description={https.portAutomatic ? "Chosen automatically: 443, or 8447 when 443 is in use." : "Chosen by you."}
    >
      {#snippet control()}<Button
          size="sm"
          {disabled}
          onclick={() => {
            error = "";
            portOpen = true;
          }}>Change</Button
        >{/snippet}
    </SettingsRow>
  {/if}
</SettingsGroup>
{#if https.unavailable}<Alert tone={https.enabled ? "warning" : "info"}
    >{https.unavailable}{#snippet actions()}{#if https.adminUrl}<ButtonLink
          size="sm"
          href={https.adminUrl}
          target="_blank"
          rel="noopener noreferrer">Open admin console</ButtonLink
        >{/if}{/snippet}</Alert
  >{/if}
{#if https.state === "error"}<Alert tone="error" title="HTTPS over Tailscale isn't working">{https.error}</Alert>{/if}
{#if error && !portOpen}<Alert tone="error">{error}</Alert>{/if}
<TailscalePortDialog
  bind:open={portOpen}
  port={https.port}
  automatic={https.portAutomatic}
  busy={network.busy}
  {error}
  onsubmit={(port) =>
    void change("set_tailscale_https_port", { port }).then((ok) => {
      if (ok) portOpen = false;
    })}
/>
<UrlQrDialog bind:open={qrOpen} url={https.url} />

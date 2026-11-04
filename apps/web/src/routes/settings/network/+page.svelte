<script lang="ts">
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import HostnameDialog from "#lib/features/network/HostnameDialog.svelte";
  import NetworkAddressRow from "#lib/features/network/NetworkAddressRow.svelte";
  import NetworkSwitchRow from "#lib/features/network/NetworkSwitchRow.svelte";
  import PortDialog from "#lib/features/network/PortDialog.svelte";
  import AttachmentLimitsSettings from "#lib/features/network/AttachmentLimitsSettings.svelte";
  import { useNetworkAccess } from "#lib/features/network/network-access.svelte.ts";
  import type { JsonBody } from "#lib/shared/http.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";

  const network = useNetworkAccess();
  const capabilities = useGatewayCapabilities();
  const status = $derived(network.status);
  let error = $state("");
  let hostnameOpen = $state(false);
  let portOpen = $state(false);

  /** Runs a change; the gateway's words (a busy port, a wrong name) stay visible where it was made. */
  async function change(action: string, extra: { [key: string]: JsonBody } = {}) {
    error = "";

    try {
      await network.update(action, extra);

      return true;
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not change network access";

      return false;
    }
  }

  const setHostnames = (hostnames: string[]) => change("set_hostnames", { hostnames });
</script>

<svelte:head><title>Network access · Settings · Canopy</title></svelte:head>
<div class="min-w-0 px-1">
  <h1 class="text-base/7 font-semibold text-zinc-950 dark:text-white">Network access</h1>
  <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    {capabilities?.linkedComputers
      ? "Pair phones and link your other computers on any network they share with this one: Wi-Fi, Tailscale or the internet."
      : "Connect paired devices and remote workers over Wi-Fi, Tailscale or the internet."}
  </p>
</div>
{#if (error || network.error) && !hostnameOpen && !portOpen}<Alert tone="error"
    >{error || network.error}<Button
      size="sm"
      onclick={() => {
        error = "";
        void network.reload();
      }}>Retry</Button
    ></Alert
  >{/if}
<SettingsGroup title="This computer">
  <NetworkSwitchRow
    {status}
    disabled={!network.loaded || network.busy}
    onchange={(enabled) => void change("set_enabled", { enabled })}
  />
</SettingsGroup>
{#if status.state === "error"}<Alert tone="error" title="Network access can't start"
    >{status.error}{#if !status.portFixed}<Button
        size="sm"
        disabled={network.busy}
        onclick={() => void change("choose_port")}>Pick a free port</Button
      >{/if}</Alert
  >{/if}
{#if status.note}<Alert tone="warning">{status.note}</Alert>{/if}
<SettingsGroup
  title="Reachable at"
  description={capabilities?.linkedComputers
    ? "Phones and linked computers try these addresses in turn. They follow this computer from network to network."
    : "Paired devices and workers try these addresses in turn to reach this gateway."}
>
  {#snippet actions()}<Button size="sm" disabled={!network.loaded || network.busy} onclick={() => (hostnameOpen = true)}
      >Add hostname</Button
    >{/snippet}
  {#if status.addresses.length}
    <ul role="list" class="divide-y divide-zinc-950/5 dark:divide-white/8">
      {#each status.addresses as address (address.origin)}
        <NetworkAddressRow
          {address}
          busy={network.busy}
          onremove={address.kind === "hostname"
            ? () => void setHostnames(status.hostnames.filter((h) => h !== address.host))
            : undefined}
        />
      {/each}
    </ul>
  {:else}
    <SettingsRow
      title={!network.loaded ? "Loading…" : status.state === "on" ? "No network right now" : "Not reachable"}
      description={status.state === "on"
        ? "Connect this computer to a network, or add a hostname."
        : "Turn on network access to see this computer's addresses."}
    />
    {#each status.hostnames as hostname (hostname)}
      <SettingsRow title={hostname} description="Added by you">
        {#snippet control()}<IconButton
            icon="trash"
            label={`Remove ${hostname}`}
            size="sm"
            disabled={network.busy}
            onclick={() => void setHostnames(status.hostnames.filter((h) => h !== hostname))}
          />{/snippet}
      </SettingsRow>
    {/each}
  {/if}
</SettingsGroup>
<SettingsGroup title="Advanced">
  <SettingsRow
    title={status.port ? `Port ${status.port}` : "Port"}
    description={status.portFixed
      ? "Set by this server's configuration."
      : status.port
        ? "Chosen automatically and kept. Change it only if a firewall allows certain ports."
        : "Chosen automatically when you turn network access on."}
  >
    {#snippet control()}{#if !status.portFixed}<Button
          size="sm"
          disabled={!network.loaded || network.busy}
          onclick={() => {
            error = "";
            portOpen = true;
          }}>Change</Button
        >{/if}{/snippet}
  </SettingsRow>
  {#if status.fingerprint}
    <SettingsRow title="Certificate fingerprint">
      <p class="font-mono text-sm/5 break-all text-zinc-500 dark:text-zinc-400">{status.fingerprint}</p>
      {#snippet control()}<CopyButton text={status.fingerprint} label="Copy fingerprint" />{/snippet}
    </SettingsRow>
  {/if}
</SettingsGroup>
<HostnameDialog
  bind:open={hostnameOpen}
  busy={network.busy}
  {error}
  onsubmit={(hostname) =>
    void setHostnames([...status.hostnames, hostname]).then((ok) => {
      if (ok) hostnameOpen = false;
    })}
/>
<AttachmentLimitsSettings />
<PortDialog
  bind:open={portOpen}
  port={status.port}
  busy={network.busy}
  {error}
  onsubmit={(port) =>
    void change("set_port", { port }).then((ok) => {
      if (ok) portOpen = false;
    })}
  onchoose={() =>
    void change("choose_port").then((ok) => {
      if (ok) portOpen = false;
    })}
/>

<script lang="ts">
  import type { NetworkAccessState } from "#lib/features/network/network-access.svelte.ts";
  import NetworkAccessSummary from "#lib/features/network/NetworkAccessSummary.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";

  let {
    network,
    busy,
    choosing,
    shareConfig = $bindable(true),
    onenable,
    oninvite,
    onenter,
  }: {
    network: NetworkAccessState;
    busy: boolean;
    choosing: boolean;
    shareConfig?: boolean;
    onenable: () => void;
    oninvite: () => void;
    onenter: () => void;
  } = $props();
</script>

<SettingsRow
  title="Share configuration"
  description="Settings, providers and proxies follow changes on computers in the same group."
>
  {#snippet control()}<Switch
      name="pair-share-config"
      label="Share configuration"
      checked={shareConfig}
      disabled={busy}
      onchange={(enabled) => {
        shareConfig = enabled;
      }}
    />{/snippet}
</SettingsRow>
{#if choosing}
  <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    Open Linked computers on your other computer, then choose how to pair.
  </p>
  {#if network.error || !network.loaded}
    <NetworkAccessSummary {network} busy={busy || network.busy} {onenable} />
  {:else if network.status.state === "on"}
    <Button variant="primary" disabled={busy} loading={busy} onclick={oninvite}>Generate pairing code</Button>
  {:else}
    <Button variant="primary" disabled={busy || !network.loaded} loading={busy} onclick={onenable}>
      Turn on network access and generate a code
    </Button>
    <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      The other computer connects to this one, so network access needs to be on here. Entering a code from the other
      computer works without it.
    </p>
  {/if}
  <Button disabled={busy} onclick={onenter}>Enter code</Button>
{/if}

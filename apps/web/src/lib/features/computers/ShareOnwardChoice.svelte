<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import { RELAY } from "@canopy/domain/computers";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";

  /** One immediate sharing choice; a selected older peer can always be turned off. */
  let {
    peer,
    recipient,
    busy = false,
    onchange,
    class: className,
  }: {
    peer: ui.LinkedComputer;
    recipient: ui.LinkedComputer;
    busy?: boolean;
    onchange: (enabled: boolean) => void;
    class?: ClassValue;
  } = $props();

  const name = $derived(recipient.displayName || recipient.name);
  const selected = $derived(recipient.shareOnwardNodeIds.includes(peer.nodeId));
  const supported = $derived(peer.capabilities.includes(RELAY) && recipient.capabilities.includes(RELAY));
</script>

<SettingsRow
  class={className}
  title={peer.displayName || peer.name}
  description={supported
    ? `Available to ${name} through this computer while both are connected.`
    : "Needs an update for Share onward."}
>
  {#snippet control()}<Switch
      name={`share-onward-${peer.nodeId}`}
      label={`Share ${peer.displayName || peer.name} onward with ${name}`}
      checked={selected}
      disabled={busy || (!selected && !supported)}
      {onchange}
    />{/snippet}
</SettingsRow>

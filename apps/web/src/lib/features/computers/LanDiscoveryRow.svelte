<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";

  /** Local network discovery of linked computers, a setting of this computer (docs/linked-computers.md, stage 6). */
  let {
    setup,
    disabled = false,
    onchange,
    class: className,
  }: {
    setup: ui.ComputersSnapshot;
    disabled?: boolean;
    onchange: (enabled: boolean) => void;
    class?: ClassValue;
  } = $props();

  const PRIVACY = "Announces only a code that changes every few minutes and that only your linked computers recognize.";

  const description = $derived(
    setup.lanDiscoveryState === "unavailable"
      ? `Not available here. ${setup.lanDiscoveryNote}`
      : setup.lanDiscoveryState === "active" && setup.lanDiscoveryNote
        ? setup.lanDiscoveryNote
        : `Finds new routes when your computers share a network. ${PRIVACY}`,
  );
</script>

<SettingsRow title="Find linked computers on this network" {description} class={className}>
  {#snippet control()}<Switch
      name="lan-discovery"
      label="Find linked computers on this network"
      checked={setup.lanDiscoveryEnabled}
      {disabled}
      {onchange}
    />{/snippet}
</SettingsRow>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";

  /** The one switch per computer: a pinned TLS listener on every interface for phones and linked computers. */
  let {
    status,
    disabled = false,
    onchange,
    class: className,
  }: {
    status: ui.NetworkAccess;
    disabled?: boolean;
    onchange: (enabled: boolean) => void;
    class?: ClassValue;
  } = $props();
</script>

<SettingsRow
  title="Let phones and other computers connect"
  description="Only devices you pair can use the connection, and it's encrypted with this computer's own certificate. Your web interface and database stay private."
  class={className}
>
  {#snippet control()}<Switch
      name="network-access"
      label="Let phones and other computers connect"
      checked={status.enabled}
      {disabled}
      {onchange}
    />{/snippet}
</SettingsRow>

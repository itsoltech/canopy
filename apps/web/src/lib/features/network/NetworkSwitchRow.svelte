<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";

  const capabilities = useGatewayCapabilities();

  const title = $derived(
    capabilities?.linkedComputers ? "Let phones and other computers connect" : "Let devices and workers connect",
  );

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
  {title}
  description="Only devices you pair can use the connection, and it's encrypted with this computer's own certificate. Your web interface and database stay private."
  class={className}
>
  {#snippet control()}<Switch
      name="network-access"
      label={title}
      checked={status.enabled}
      {disabled}
      {onchange}
    />{/snippet}
</SettingsRow>

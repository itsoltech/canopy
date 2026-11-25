<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import LocalComputers from "./LocalComputers.svelte";

  const capabilities = useGatewayCapabilities();
</script>

<svelte:head><title>Linked computers · Settings · {applicationName}</title></svelte:head>

{#if capabilities?.remoteDesktop}
  <SettingsHeading
    title="Linked computers"
    description="Manage linked computers on the computer running your gateway (“Run Canopy on this computer”)."
  />
{:else}
  <LocalComputers />
{/if}

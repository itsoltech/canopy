<script lang="ts">
  import type { Workspace } from "@canopy/domain/workspace";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";

  let { view, onopen = () => {} }: { view: Workspace; onopen?: () => void } = $props();
  const capabilities = useGatewayCapabilities();
</script>

{#if capabilities?.methods && !capabilities.methods.includes("ListThreadDirectory")}
  <Alert>Update Canopy on your gateway to browse files.</Alert>
{:else}{#await import("./WorkspaceTree.svelte")}
    <Skeleton class="h-40 w-full" />
  {:then module}
    {#key view}<module.default {view} {onopen} />{/key}
  {:catch}
    <Alert tone="error">Could not open Files. Reload Canopy to try again.</Alert>
  {/await}
{/if}

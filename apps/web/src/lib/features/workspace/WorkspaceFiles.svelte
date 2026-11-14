<script lang="ts">
  import type { Workspace } from "@canopy/domain/workspace";
  import WorkspaceTreeSkeleton from "./WorkspaceTreeSkeleton.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";

  let { view, root, onopen = () => {} }: { view: Workspace; root: string; onopen?: () => void } = $props();
  const capabilities = useGatewayCapabilities();

  // Both chunks are needed for the first page; avoid an extra round trip after the tree mounts.
  const load = () =>
    Promise.all([import("./WorkspaceTree.svelte"), import("./directory-api.ts")]).then(([tree]) => tree);
</script>

{#if capabilities?.methods && !capabilities.methods.includes("ListThreadDirectory")}
  <Alert>Update Canopy on your gateway to browse files.</Alert>
{:else}{#await load()}
    <!-- Same frame as the tree: the header strip, then placeholder rows. -->
    <div class="h-12 shrink-0 border-b border-divider"></div>
    <div class="pt-1"><WorkspaceTreeSkeleton /></div>
  {:then module}
    {#key view}<module.default {view} {root} {onopen} />{/key}
  {:catch}
    <Alert tone="error">Could not open Files. Reload Canopy to try again.</Alert>
  {/await}
{/if}

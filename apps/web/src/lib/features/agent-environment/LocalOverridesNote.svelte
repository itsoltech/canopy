<script lang="ts">
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";

  /** The library is shared with linked computers; machine overrides are not. */
  const overview = useOverview();
  const capabilities = useGatewayCapabilities();
</script>

{#if capabilities?.linkedComputers && overview.computers.size > 0}<p
    class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400"
  >
    This computer's workers. Linked computers set their own overrides.
  </p>{/if}

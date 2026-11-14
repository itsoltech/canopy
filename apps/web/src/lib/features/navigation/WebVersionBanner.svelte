<script lang="ts">
  import { WEB_MIGRATION_DOCS } from "@canopy/domain/release/web-version";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import { updateState } from "#lib/shared/updates.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import TextLink from "#lib/shared/ui/TextLink.svelte";

  /** A server web app whose version differs from its gateway's: usually a separate web service left behind. */
  const capabilities = useGatewayCapabilities();
  let dismissed = $state("");

  // The reload banner (a newer build of this web app) takes the same place and comes first.
  const lag = $derived(
    updateState.available || !capabilities || capabilities.webLag === dismissed ? "" : capabilities.webLag,
  );
</script>

{#if lag === "older" || lag === "newer"}
  <div
    class="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 macos:max-h-[max(0px,var(--window-safe-height)-2rem)] macos:overflow-y-auto"
    role="status"
  >
    <div
      class="flex max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-white px-4 py-2 text-sm/6 text-zinc-950 shadow-lg ring-1 ring-zinc-950/10 dark:bg-zinc-900 dark:text-white dark:ring-white/10"
    >
      <span class="min-w-0 flex-1">
        {#if lag === "older"}
          This web app is older than the gateway. Remove the separate web service; the gateway serves the web now.
        {:else}
          This web app is newer than the gateway. Update the gateway to the same version.
        {/if}
        <TextLink href={WEB_MIGRATION_DOCS} target="_blank" rel="noreferrer">How to fix</TextLink>
      </span>
      <Button size="sm" onclick={() => (dismissed = lag)}>Dismiss</Button>
    </div>
  </div>
{/if}

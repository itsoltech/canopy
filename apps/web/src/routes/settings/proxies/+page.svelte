<script lang="ts">
  import { untrack } from "svelte";
  import { ui } from "@canopy/contracts";
  import ProxyDialog from "#lib/features/proxies/ProxyDialog.svelte";
  import ProxyEntry from "#lib/features/proxies/ProxyEntry.svelte";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { decode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
  let proxies = $state(untrack(() => decode(ui.ListProxiesResponseSchema, data.proxies).proxies));
  let editing = $state<ui.Proxy>();
  let open = $state(false);

  function saved(proxy: ui.Proxy) {
    proxies = proxies.some((p) => p.id === proxy.id)
      ? proxies.map((p) => (p.id === proxy.id ? proxy : p))
      : [...proxies, proxy];
  }
</script>

<svelte:head><title>Proxies · Canopy</title></svelte:head>
<div class="settings-stack">
  <SettingsHeading
    title="Proxies"
    description="Save a connection once, then choose it in any compatible provider instance."
  >
    {#snippet actions()}<Button
        variant="primary"
        onclick={() => {
          editing = undefined;
          open = true;
        }}>Add proxy</Button
      >{/snippet}
  </SettingsHeading>
  {#if proxies.length === 0}
    <div class="grid gap-2 py-4">
      <h2 class="text-lg font-semibold text-balance text-zinc-950 dark:text-white">One connection for your agents</h2>
      <p class="max-w-prose text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Add CLIProxyAPI, a fork, or an Anthropic/OpenAI-compatible endpoint. Its secret stays encrypted in the gateway.
      </p>
    </div>
  {:else}
    <div class="min-w-0">
      {#each proxies as proxy (proxy.id)}<ProxyEntry
          {proxy}
          onedit={() => {
            editing = proxy;
            open = true;
          }}
          ondelete={() => (proxies = proxies.filter((p) => p.id !== proxy.id))}
        />{/each}
    </div>
  {/if}
</div>
<ProxyDialog bind:open proxy={editing} onsaved={saved} />

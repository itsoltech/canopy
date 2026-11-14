<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { ui } from "@canopy/contracts";
  import ProxyDialog from "#lib/features/proxies/ProxyDialog.svelte";
  import ProxyEntry from "#lib/features/proxies/ProxyEntry.svelte";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { putProxyAccounts, replaceProxy, sharedProxies } from "#lib/features/proxies/proxies.ts";
  import ConfigNotices from "#lib/features/computers/ConfigNotices.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  // The route seeds the tab's shared list; saves, deletes and other devices' changes update it.
  const read = sharedProxies();
  const proxies = $derived(read.data?.proxies ?? data.proxies.proxies);
  let editing = $state<ui.Proxy>();
  let open = $state(false);

  const reload = () => read.reload();
  const saved = (proxy: ui.Proxy) => replaceProxy(read, proxy);
</script>

<svelte:head><title>Proxies · {applicationName}</title></svelte:head>
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
  <ConfigNotices match={(n) => n.kind === "proxy"} onchange={() => void reload()} />
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
          ondelete={() => replaceProxy(read, proxy, true)}
          onaccounts={(accounts) => putProxyAccounts(read, accounts)}
        />{/each}
    </div>
  {/if}
</div>
<ProxyDialog bind:open proxy={editing} onsaved={saved} />

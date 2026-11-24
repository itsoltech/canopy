<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { ui } from "@canopy/contracts";
  import ProxyDialog from "#lib/features/proxies/ProxyDialog.svelte";
  import { useSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import SettingsTopics from "#lib/features/settings/SettingsTopics.svelte";
  import ProxyAccounts from "#lib/features/proxies/ProxyAccounts.svelte";
  import ProxyEntry from "#lib/features/proxies/ProxyEntry.svelte";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { putProxyAccounts, replaceProxy, sharedProxies } from "#lib/features/proxies/proxies.ts";
  import ConfigNotices from "#lib/features/computers/ConfigNotices.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  // The route seeds the tab's shared list; saves, deletes and other devices' changes update it.
  const route = useSettingsRoute();
  const read = sharedProxies();
  const proxies = $derived(read.data?.proxies ?? data.proxies.proxies);
  const accountProxies = $derived(proxies.filter((proxy) => proxy.kind === "cliproxyapi"));
  const anchor = $derived(route.url.hash.slice(1));

  const linkedTopic = $derived.by(() => {
    if (proxies.some((proxy) => anchor === `proxy-${proxy.id}`)) return "connections";

    if (accountProxies.some((proxy) => anchor === `accounts-${proxy.id}`)) return "accounts";

    return undefined;
  });

  $effect(() => {
    if (!linkedTopic) return;
    const id = anchor;

    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(id);
      target?.scrollIntoView({ block: "start" });
      target?.focus({ preventScroll: true });
    });

    return () => cancelAnimationFrame(frame);
  });

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
  />
  <ConfigNotices match={(n) => n.kind === "proxy"} onchange={() => void reload()} />
  <SettingsTopics
    label="Proxy settings"
    defaultTopic={linkedTopic}
    topics={[
      { id: "connections", label: "Connections", content: connections },
      { id: "accounts", label: "Upstream accounts", content: accounts, hidden: !accountProxies.length },
    ]}
  />
</div>

{#snippet connections()}
  <div>
    <Button
      variant="primary"
      onclick={() => {
        editing = undefined;
        open = true;
      }}>Add proxy</Button
    >
  </div>
  {#if proxies.length === 0}
    <div class="grid gap-2 py-4">
      <h2 class="text-lg font-semibold text-balance text-zinc-950 dark:text-white">No proxies yet</h2>
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
        />{/each}
    </div>
  {/if}
{/snippet}

{#snippet accounts()}
  {#each accountProxies as proxy (proxy.id)}
    <section id={`accounts-${proxy.id}`} tabindex="-1" aria-label={proxy.name} class="grid min-w-0 scroll-mt-4 gap-2">
      <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 class="min-w-0 text-lg font-semibold wrap-anywhere text-zinc-950 dark:text-white">{proxy.name}</h2>
        <Button
          size="sm"
          onclick={() => {
            editing = proxy;
            open = true;
          }}>Edit connection</Button
        >
      </div>
      <ProxyAccounts {proxy} onread={(accounts) => putProxyAccounts(read, accounts)} />
    </section>
  {/each}
{/snippet}

<ProxyDialog bind:open proxy={editing} onsaved={saved} />

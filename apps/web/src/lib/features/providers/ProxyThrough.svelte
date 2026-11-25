<script lang="ts">
  import { untrack } from "svelte";
  import type { Provider, ui } from "@canopy/contracts";
  import { proxyAccountsForHarness, proxyAccountsHint, proxyAccountsSummary } from "@canopy/domain/proxy-accounts";
  import ProxyAccountRow from "#lib/features/proxies/ProxyAccountRow.svelte";
  import InsetList from "#lib/shared/ui/InsetList.svelte";
  import TextLink from "#lib/shared/ui/TextLink.svelte";
  import { proxyCall, putProxyAccounts, sharedProxies } from "#lib/features/proxies/proxies.ts";

  let { proxy, harness }: { proxy: ui.Proxy; harness: Provider } = $props();
  const read = sharedProxies();
  const managed = $derived(proxy.kind === "cliproxyapi");
  const accounts = $derived(managed ? proxyAccountsForHarness(proxy.accounts, harness) : []);

  const summary = $derived(
    managed
      ? (proxyAccountsSummary(proxy.accounts, harness) ?? proxyAccountsHint(proxy.accounts, proxy.managementKeySet))
      : undefined,
  );

  // A primitive: the read's result replaces the proxy, which must not ask again.
  const readable = $derived(proxy.managementKeySet && managed ? proxy.id : "");

  $effect(() => {
    const id = readable;

    if (id)
      untrack(
        () =>
          void proxyCall("accounts", { id }).then(
            (accounts) => putProxyAccounts(read, accounts),
            () => {},
          ),
      );
  });
</script>

<div class="grid min-w-0 gap-1.5">
  <p class="min-w-0 text-base/6 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
    Through <TextLink
      href={`/settings/proxies#${accounts.length ? "accounts" : "proxy"}-${proxy.id}`}
      class="wrap-anywhere">{proxy.name}</TextLink
    >{#if summary}<span aria-hidden="true">{" · "}</span><span>{summary}</span>{/if}
  </p>
  {#if accounts.length}
    <InsetList label={`Accounts of ${proxy.name}`} class="px-3">
      {#each accounts as account (account.id)}
        <ProxyAccountRow {account} compact />
      {/each}
    </InsetList>
  {/if}
</div>

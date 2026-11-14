<script lang="ts">
  import { untrack } from "svelte";
  import type { ui } from "@canopy/contracts";
  import { proxyAccountsHint, proxyAccountsSummary } from "@canopy/domain/proxy-accounts";
  import TextLink from "#lib/shared/ui/TextLink.svelte";
  import { proxyCall, putProxyAccounts, sharedProxies } from "#lib/features/proxies/proxies.ts";

  /**
   * Which proxy an instance runs through and a one-line summary of that proxy's accounts for this harness. Plan
   * limits of a proxy belong to its upstream accounts, so this replaces the plan meters; details are on the proxy.
   */
  let { instance }: { instance: ui.ProviderInstance } = $props();
  const read = sharedProxies();
  const proxy = $derived(read.data?.proxies.find((p) => p.id === instance.proxyId));
  const managed = $derived(proxy?.kind === "cliproxyapi");

  const summary = $derived(
    proxy && managed
      ? (proxyAccountsSummary(proxy.accounts, instance.harness) ??
          proxyAccountsHint(proxy.accounts, proxy.managementKeySet))
      : undefined,
  );

  $effect(() => {
    const id = proxy?.managementKeySet && managed ? proxy.id : "";

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

{#if proxy}
  <p class="min-w-0 text-base/6 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
    Through <TextLink href={`/settings/proxies#proxy-${proxy.id}`} class="break-words">{proxy.name}</TextLink
    >{#if summary}<span aria-hidden="true"> · </span><span>{summary}</span>{/if}
  </p>
{/if}

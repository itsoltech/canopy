<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { proxyAccountsHint } from "@canopy/domain/proxy-accounts";
  import {
    proxyCapacityGroups,
    supportedProxyAccounts,
    unsupportedProxyAccountText,
  } from "@canopy/domain/proxy-capacity";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatRelative } from "#lib/shared/format.ts";
  import TextLink from "#lib/shared/ui/TextLink.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import ProxyAccountRow from "./ProxyAccountRow.svelte";
  import ProxyCapacitySummary from "./ProxyCapacitySummary.svelte";

  /** A cache-only view. The overview feed and gateway usage lease own refreshes. */
  let { proxy, onclose }: { proxy: ui.Proxy; onclose: () => void } = $props();
  const snapshot = $derived(proxy.accounts);
  const hint = $derived(proxyAccountsHint(snapshot, proxy.managementKeySet));

  const accounts = $derived(supportedProxyAccounts(snapshot?.accounts ?? []));
  const unsupported = $derived((snapshot?.accounts.length ?? 0) - accounts.length);
  const groups = $derived(proxyCapacityGroups(accounts, clock.now));
</script>

<section class="grid min-w-0 gap-1">
  <div class="min-w-0 text-base font-medium sm:text-sm">
    <TextLink href={`/settings/proxies#proxy-${proxy.id}`} onclick={onclose} class="flex min-w-0">
      <TruncatedText text={`Through ${proxy.name}`} />
    </TextLink>
  </div>
  {#if snapshot?.state === "ok"}
    {#if accounts.length}
      {#each groups as group (group.mark)}
        <section class="grid min-w-0 gap-2 border-t border-zinc-950/5 pt-2 dark:border-white/5">
          <ProxyCapacitySummary {group} />
          <details class="min-w-0">
            <summary class="cursor-pointer text-sm/5 text-zinc-500 focus-ring sm:text-xs/5 dark:text-zinc-400"
              >Account limits</summary
            >
            <ul role="list" class="divide-y divide-zinc-950/5 dark:divide-white/5">
              {#each group.accounts as account (account.id)}<ProxyAccountRow {account} compact />{/each}
            </ul>
          </details>
        </section>
      {/each}
      {#if snapshot.total > snapshot.accounts.length}<p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
          Showing {snapshot.accounts.length} of {snapshot.total}.
        </p>{/if}
    {:else if !unsupported}
      <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">The proxy has no accounts yet.</p>
    {/if}
    {#if unsupported}<p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        {unsupportedProxyAccountText(unsupported)}
      </p>{/if}
  {:else}
    <p role="status" class="min-h-10 text-sm/5 text-pretty text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      {hint ?? "Checking accounts…"}
      {#if snapshot && proxy.managementKeySet}Open proxy settings to check access, then refresh.{/if}
    </p>
  {/if}
  <p class="min-h-5 text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5 dark:text-zinc-400">
    {#if snapshot?.checkedAt}Checked {formatRelative(snapshot.checkedAt)}{/if}
  </p>
</section>

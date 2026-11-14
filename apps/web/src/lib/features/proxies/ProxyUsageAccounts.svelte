<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { proxyAccountsHint, proxyProviderName } from "@canopy/domain/proxy-accounts";
  import { formatRelative } from "#lib/shared/format.ts";
  import TextLink from "#lib/shared/ui/TextLink.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import ProxyAccountRow from "./ProxyAccountRow.svelte";

  /** A cache-only view. The overview feed and gateway usage lease own refreshes. */
  let { proxy, onclose }: { proxy: ui.Proxy; onclose: () => void } = $props();
  const snapshot = $derived(proxy.accounts);
  const hint = $derived(proxyAccountsHint(snapshot, proxy.managementKeySet));
  const accounts = $derived(
    [...(snapshot?.accounts ?? [])].sort(
      (a, b) => proxyProviderName(a.provider).localeCompare(proxyProviderName(b.provider)) || a.id.localeCompare(b.id),
    ),
  );
</script>

<section class="grid min-w-0 gap-1">
  <div class="min-w-0 text-base font-medium sm:text-sm">
    <TextLink href={`/settings/proxies#proxy-${proxy.id}`} onclick={onclose} class="flex min-w-0">
      <TruncatedText text={`Through ${proxy.name}`} />
    </TextLink>
  </div>
  {#if snapshot?.state === "ok"}
    {#if accounts.length}
      <ul role="list" class="divide-y divide-zinc-950/5 dark:divide-white/5">
        {#each accounts as account (account.id)}<ProxyAccountRow {account} compact />{/each}
      </ul>
      {#if snapshot.total > accounts.length}<p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
          Showing {accounts.length} of {snapshot.total}.
        </p>{/if}
    {:else}
      <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">The proxy has no accounts yet.</p>
    {/if}
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

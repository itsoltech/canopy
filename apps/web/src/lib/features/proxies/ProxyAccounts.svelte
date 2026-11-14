<script lang="ts">
  import { untrack } from "svelte";
  import type { ui } from "@canopy/contracts";
  import { proxyAccountsHint } from "@canopy/domain/proxy-accounts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import InsetList from "#lib/shared/ui/InsetList.svelte";
  import { formatRelative } from "#lib/shared/format.ts";
  import ProxyAccountRow from "./ProxyAccountRow.svelte";
  import { proxyCall } from "./proxies.ts";

  /**
   * The upstream accounts of a CLIProxyAPI proxy, read by the gateway with the stored management key. Opening the
   * card asks once (a read under a minute old answers without calling the proxy); Refresh reads now.
   */
  let { proxy, onread }: { proxy: ui.Proxy; onread: (accounts: ui.ProxyAccounts) => void } = $props();
  let busy = $state(false);
  let failure = $state<string>();
  const accounts = $derived(proxy.accounts);
  const hint = $derived(proxyAccountsHint(accounts, proxy.managementKeySet));

  async function read(force: boolean) {
    busy = true;
    failure = undefined;

    try {
      onread(await proxyCall("accounts", { id: proxy.id, force }));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    if (proxy.managementKeySet && proxy.id) untrack(() => void read(false));
  });
</script>

<div class="grid min-w-0 gap-2">
  <div class="flex min-w-0 items-center justify-between gap-3">
    <h3 class="min-w-0 text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">
      Accounts{#if accounts?.state === "ok"}<span class="font-normal text-zinc-500 dark:text-zinc-400">
          · {accounts.total}</span
        >{/if}
    </h3>
    {#if proxy.managementKeySet}<Button size="sm" icon="arrow-path" loading={busy} onclick={() => read(true)}
        >Refresh</Button
      >{/if}
  </div>
  {#if hint}<p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{hint}</p>{/if}
  {#if failure}<Alert tone="error">{failure}</Alert>{/if}
  {#if accounts?.state === "ok"}
    {#if accounts.accounts.length}
      <InsetList label={`Accounts of ${proxy.name}`}>
        {#each accounts.accounts as account (account.id)}<ProxyAccountRow {account} />{/each}
      </InsetList>
      {#if accounts.total > accounts.accounts.length}<p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
          Showing {accounts.accounts.length} of {accounts.total}.
        </p>{/if}
    {:else}
      <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">The proxy has no accounts yet.</p>
    {/if}
  {/if}
  {#if accounts?.checkedAt}<p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      Checked {formatRelative(accounts.checkedAt)}
    </p>{/if}
</div>

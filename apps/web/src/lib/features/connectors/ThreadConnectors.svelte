<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { connectorLabel, accountStatus } from "./api.ts";
  import { useConnectorAccounts } from "./accounts.svelte.ts";
  import ConnectorIcon from "./ConnectorIcon.svelte";
  let { threadId, class: className }: { threadId: string; class?: ClassValue } = $props();
  const catalog = useConnectorAccounts(() => ({ threadId }));
  const status = $derived(catalog.loading ? 'Loading connections…' : catalog.error || (!catalog.accounts.length ? 'No accounts granted to this worker.' : ''));
</script>
<section aria-label="Connectors" class={["grid min-w-0 gap-2 p-3 text-base/6 sm:text-xs/5", className]}>
  <div class="flex items-center justify-between gap-2"><h3 class="font-medium text-zinc-700 dark:text-zinc-300">Connectors</h3><a href="/settings/connectors" class="text-zinc-500 underline decoration-zinc-400/50 underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-100">Manage</a></div>
  {#if status}<p role="status" class="text-zinc-500 dark:text-zinc-400">{status}</p>{/if}
  <ul role="list" class="grid gap-2">
    {#each catalog.accounts as account (account.id)}<li class="flex min-w-0 items-center gap-2" title={accountStatus(account.status)}><ConnectorIcon type={account.connectorType} /><span class="truncate">{connectorLabel(account, catalog.types)}</span>{#if account.status !== 'connected'}<span class="text-amber-700 dark:text-amber-400">Reconnect</span>{/if}</li>{/each}
  </ul>
</section>

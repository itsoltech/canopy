<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { connectorLabel, accountStatus } from "#lib/features/connectors/api.ts";
  import { useConnectorAccounts } from "#lib/features/connectors/accounts.svelte.ts";
  import ConnectorIcon from "#lib/features/connectors/ConnectorIcon.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  let { botId, class: className }: { botId: string; class?: ClassValue } = $props();
  const catalog = useConnectorAccounts(() => ({ botId }));
</script>
<div class={["grid gap-3 text-base/6 sm:text-sm/6", className]}>
  {#if catalog.loading}<p role="status" class="text-zinc-500 dark:text-zinc-400">Loading connections…</p>{:else if !catalog.accounts.length}<p class="text-zinc-500 dark:text-zinc-400">No accounts are granted to this bot yet.</p>{/if}
  <ul role="list" class="grid gap-2">
    {#each catalog.accounts as account (account.id)}
      <li class="flex min-w-0 items-center gap-2"><ConnectorIcon type={account.connectorType} /><span class="min-w-0 flex-1 truncate">{connectorLabel(account, catalog.types)}</span><span class="text-zinc-500 dark:text-zinc-400">{accountStatus(account.status)}</span></li>
    {/each}
  </ul>
  {#if catalog.error}<Alert tone="error">{catalog.error}</Alert>{/if}
  <div><a href="/settings/connectors" class="font-medium underline underline-offset-4">Manage connector access</a></div>
</div>

<script lang="ts">
  import { untrack } from "svelte";
  import { bots as botContract, connectors } from "@canopy/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import ConnectorIcon from "#lib/features/connectors/ConnectorIcon.svelte";
  import ConnectAccountDialog from "#lib/features/connectors/ConnectAccountDialog.svelte";
  import AccountDetail from "#lib/features/connectors/AccountDetail.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { rise } from "#lib/shared/ui/motion.ts";
  import { decode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";
  let { data }: PageProps = $props();
  const overview = useOverview();
  const route = useSettingsRoute();
  const catalog = $derived(decode(connectors.ListConnectorsResponseSchema, data.connections));
  let accounts = $state<connectors.ConnectorAccount[]>(untrack(() => decode(connectors.ListConnectorsResponseSchema, data.connections).accounts));
  const bots = $derived(decode(botContract.ListBotsResponseSchema, data.bots).bots.map((b) => ({ id: b.id, name: b.configuration?.name ?? 'Bot' })));
  let selected = $state('');
  let connecting = $state(false);
  let notice = $state(untrack(() => route.url.searchParams.get('connection')));
  const type = $derived(catalog.types.find((t) => t.id === selected));
  function update(account: connectors.ConnectorAccount) {
    notice = null;
    accounts = accounts.some((a) => a.id === account.id) ? accounts.map((a) => a.id === account.id ? account : a) : [...accounts, account];
    window.dispatchEvent(new Event('connectors-changed'));
  }
  function remove(id: string) {
    notice = null;
    accounts = accounts.filter((a) => a.id !== id);
    window.dispatchEvent(new Event('connectors-changed'));
  }
</script>
<div class="grid min-w-0 gap-7">
  <SettingsHeading title="Connectors" description="Connect your apps once. Choose which workers and bots can use each account." />
  {#if notice === 'connected'}<Alert>Account connected. Choose who can use it below.</Alert>{:else if notice === 'error'}<Alert tone="error">Sign-in could not finish. Reconnect the account to try again.</Alert>{/if}
  <section aria-label="Connect an app" class="grid gap-4">
    <h2 class="text-lg font-semibold text-balance">Add an account</h2>
    <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {#each catalog.types as entry (entry.id)}
        <button type="button" onclick={() => { selected = entry.id; connecting = true; }} class="relative flex min-w-0 items-center gap-2.5 rounded-xl px-3 py-3 text-left text-base/5 ring-1 ring-zinc-950/10 hover:bg-zinc-950/4 focus-ring sm:text-sm/5 dark:ring-white/10 dark:hover:bg-white/5"><ConnectorIcon type={entry.id} class="shrink-0" /><span class="min-w-0 text-pretty">{entry.name}</span></button>
      {/each}
    </div>
  </section>
  <section aria-label="Connected accounts" class="grid gap-4">
    <h2 class="text-lg font-semibold text-balance">Your accounts</h2>
    {#each accounts as account (account.id)}
      {@const entry = catalog.types.find((t) => t.id === account.connectorType)}
      {#if entry}<div in:rise><AccountDetail {account} type={entry} workers={overview.workers} {bots} onupdate={update} onremove={remove} /></div>{/if}
    {:else}<p class="py-4 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">No accounts connected yet. Pick an app above to connect one.</p>{/each}
  </section>
</div>
{#if connecting && type}<ConnectAccountDialog bind:open={connecting} {type} onsave={update} />{/if}

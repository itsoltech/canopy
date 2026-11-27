<script lang="ts">
  import { providerCopy, providerOf, type MessengerProvider } from "#lib/features/bots/messengers/providers.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import InsetList from "#lib/shared/ui/InsetList.svelte";
  import type { MessengerCatalog } from "./messenger-catalog.svelte.ts";
  import TokenBotAccount from "./TokenBotAccount.svelte";
  import TokenBotDialog from "./TokenBotDialog.svelte";

  let { catalog, provider }: { catalog: MessengerCatalog; provider: Exclude<MessengerProvider, "slack"> } = $props();

  let adding = $state(false);
  const copy = $derived(providerCopy(provider));
  const accounts = $derived(catalog.accounts.filter((account) => providerOf(account) === provider));
</script>

<section aria-labelledby={`${provider}-bot-heading`} class="grid min-w-0 gap-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 id={`${provider}-bot-heading`} class="text-base/6 font-semibold sm:text-sm/6">{copy.account} accounts</h3>
    <Button size="sm" disabled={!catalog.ready} onclick={() => (adding = true)}>Add {copy.account}</Button>
    <p class="w-full text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      Receive and reply to {copy.label} messages as your bot.
    </p>
  </div>
  {#if accounts.length}
    <InsetList label={`${copy.account} accounts`} class="@container">
      {#each accounts as account (account.id)}
        <li>
          <TokenBotAccount
            {account}
            {provider}
            onsaved={(saved) => catalog.saved(saved)}
            onremove={(id) => catalog.removed(id)}
          />
        </li>
      {/each}
    </InsetList>
  {:else if catalog.ready && !catalog.failed}
    <p class="text-sm text-zinc-500 dark:text-zinc-400">No {copy.account} accounts connected.</p>
  {/if}
</section>

{#if adding}<TokenBotDialog bind:open={adding} {provider} onsaved={(saved) => catalog.saved(saved)} />{/if}

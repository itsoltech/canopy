<script lang="ts">
  import type { connectors } from "@canopy/contracts";
  import { providerOf } from "#lib/features/bots/messengers/providers.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import InsetList from "#lib/shared/ui/InsetList.svelte";
  import { changed, type MessengerCatalog } from "./messenger-catalog.svelte.ts";
  import SlackBotAccount from "./SlackBotAccount.svelte";
  import SlackBotSetupDialog from "./SlackBotSetupDialog.svelte";

  let {
    catalog,
    slackUsers,
    oauthCompletion,
    canAdd,
  }: {
    catalog: MessengerCatalog;
    slackUsers: readonly connectors.ConnectorAccount[];
    oauthCompletion?: connectors.CompleteConnectorOAuthResponse;
    canAdd: boolean;
  } = $props();

  let adding = $state(false);
  const accounts = $derived(catalog.accounts.filter((account) => providerOf(account) === "slack"));

  const availableUsers = $derived(
    slackUsers.filter(
      (user) =>
        (user.status === "connected" || user.status === "error") &&
        !accounts.some((bot) => bot.connectorAccountId === user.id),
    ),
  );
</script>

<section aria-labelledby="slack-bot-heading" class="grid min-w-0 gap-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 id="slack-bot-heading" class="text-base/6 font-semibold sm:text-sm/6">Slack Bot accounts</h3>
    {#if canAdd}<Button size="sm" disabled={!catalog.ready} onclick={() => (adding = true)}>Add Slack Bot</Button>{/if}
    <p class="w-full text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      Receive and reply to Slack messages as your Slack app’s bot.
    </p>
  </div>
  {#if accounts.length}
    <InsetList label="Slack Bot accounts" class="@container">
      {#each accounts as account (account.id)}
        <li>
          <SlackBotAccount
            {account}
            linkedUser={slackUsers.find((user) => user.id === account.connectorAccountId)}
            {availableUsers}
            sharedManifest={catalog.response?.slackAppManifest ?? ""}
            {oauthCompletion}
            onsaved={(saved) => catalog.saved(saved)}
            onremove={(id) => catalog.removed(id)}
            onrefresh={changed}
          />
        </li>
      {/each}
    </InsetList>
  {:else if catalog.ready && !catalog.failed}
    <p class="text-sm text-zinc-500 dark:text-zinc-400">No Slack Bot accounts connected.</p>
  {/if}
</section>

{#if adding}
  <SlackBotSetupDialog
    bind:open={adding}
    {availableUsers}
    sharedManifest={catalog.response?.slackAppManifest}
    manifest={catalog.response?.slackBotAppManifest}
    createUrl={catalog.response?.slackBotAppCreateUrl}
    onsaved={(saved) => catalog.saved(saved)}
  />
{/if}

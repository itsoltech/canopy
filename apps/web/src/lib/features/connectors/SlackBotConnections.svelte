<script lang="ts">
  import type { connectors, ui } from "@canopy/contracts";
  import { onMount } from "svelte";
  import { messengerAccounts } from "#lib/features/bots/messengers/api.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import InsetList from "#lib/shared/ui/InsetList.svelte";
  import SlackBotAccount from "./SlackBotAccount.svelte";
  import SlackBotSetupDialog from "./SlackBotSetupDialog.svelte";

  let {
    slackUsers,
    oauthCompletion,
    adding = $bindable(false),
    ready = $bindable(false),
  }: {
    slackUsers: readonly connectors.ConnectorAccount[];
    oauthCompletion?: connectors.CompleteConnectorOAuthResponse;
    adding?: boolean;
    ready?: boolean;
  } = $props();

  let catalog = $state<ui.ListMessengerAccountsResponse>();
  let loading = $state(true);
  let failed = $state(false);
  let fetchId = 0;

  const accounts = $derived(catalog?.accounts ?? []);

  const availableUsers = $derived(
    slackUsers.filter(
      (user) =>
        (user.status === "connected" || user.status === "error") &&
        !accounts.some((bot) => bot.connectorAccountId === user.id),
    ),
  );

  async function reload() {
    const id = ++fetchId;

    try {
      const next = await messengerAccounts();

      if (id !== fetchId) return;
      catalog = next;
      ready = true;
      failed = false;
    } catch {
      if (id === fetchId) failed = true;
    } finally {
      if (id === fetchId) loading = false;
    }
  }

  onMount(() => {
    void reload();

    const refresh = () => {
      if (!document.hidden) void reload();
    };

    window.addEventListener("focus", refresh);
    window.addEventListener("messenger-accounts-changed", refresh);
    const timer = setInterval(refresh, 30_000);

    return () => {
      ++fetchId;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("messenger-accounts-changed", refresh);
    };
  });

  function changed() {
    window.dispatchEvent(new Event("messenger-accounts-changed"));
  }

  function saved(account: ui.MessengerAccount) {
    if (catalog)
      catalog.accounts = accounts.some((entry) => entry.id === account.id)
        ? accounts.map((entry) => (entry.id === account.id ? account : entry))
        : [...accounts, account];
    changed();
  }

  function removed(id: string) {
    if (catalog) catalog.accounts = accounts.filter((account) => account.id !== id);
    changed();
  }
</script>

<section aria-labelledby="slack-bot-heading" class="grid min-w-0 gap-4">
  <div class="flex flex-wrap items-start justify-between gap-2">
    <div class="grid gap-1">
      <h2 id="slack-bot-heading" class="text-lg font-semibold">Slack Bot accounts</h2>
      <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Receive and reply to Slack messages as your Slack app’s bot.
      </p>
    </div>
    <Button size="sm" variant="ghost" disabled={loading} onclick={reload}>Refresh status</Button>
  </div>
  {#if loading}
    <p role="status" class="text-sm text-zinc-500 dark:text-zinc-400">Loading Slack Bot accounts…</p>
  {/if}
  {#if failed}
    <Alert tone="error">Could not load Slack Bot accounts. Refresh status to try again.</Alert>
  {/if}
  {#if accounts.length}
    <InsetList label="Slack Bot accounts" class="@container">
      {#each accounts as account (account.id)}
        <li>
          <SlackBotAccount
            {account}
            linkedUser={slackUsers.find((user) => user.id === account.connectorAccountId)}
            {availableUsers}
            sharedManifest={catalog?.slackAppManifest ?? ""}
            {oauthCompletion}
            onsaved={saved}
            onremove={removed}
            onrefresh={changed}
          />
        </li>
      {/each}
    </InsetList>
    <p class="text-sm text-zinc-500 dark:text-zinc-400">
      Choose who can message each bot in Bot settings → Messengers.
    </p>
  {:else if ready && !failed}
    <p class="text-sm text-zinc-500 dark:text-zinc-400">No Slack Bot accounts connected.</p>
  {/if}
</section>

{#if adding}
  <SlackBotSetupDialog
    bind:open={adding}
    {availableUsers}
    sharedManifest={catalog?.slackAppManifest}
    manifest={catalog?.slackBotAppManifest}
    createUrl={catalog?.slackBotAppCreateUrl}
    onsaved={saved}
  />
{/if}

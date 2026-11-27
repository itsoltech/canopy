<script lang="ts">
  import type { connectors } from "@canopy/contracts";
  import { onMount } from "svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { MessengerCatalog } from "./messenger-catalog.svelte.ts";
  import SlackBotConnections from "./SlackBotConnections.svelte";
  import TokenBotConnections from "./TokenBotConnections.svelte";

  let {
    slackUsers,
    oauthCompletion,
    canAddSlack,
  }: {
    slackUsers: readonly connectors.ConnectorAccount[];
    oauthCompletion?: connectors.CompleteConnectorOAuthResponse;
    canAddSlack: boolean;
  } = $props();

  const catalog = new MessengerCatalog();

  onMount(() => catalog.watch());
</script>

<section aria-labelledby="messaging-heading" class="grid min-w-0 gap-6">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h2 id="messaging-heading" class="text-lg font-semibold">Messaging</h2>
    <Button size="sm" variant="ghost" disabled={catalog.loading} onclick={() => catalog.reload()}>Refresh status</Button
    >
    <p class="w-full text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      Connect bot accounts, then choose who can message each bot in Bot settings → Messengers.
    </p>
  </div>
  {#if catalog.loading}
    <p role="status" class="text-sm text-zinc-500 dark:text-zinc-400">Loading messenger accounts…</p>
  {/if}
  {#if catalog.failed}
    <Alert tone="error">Could not load messenger accounts. Refresh status to try again.</Alert>
  {/if}
  <SlackBotConnections {catalog} {slackUsers} {oauthCompletion} canAdd={canAddSlack} />
  <TokenBotConnections {catalog} provider="telegram" />
  <TokenBotConnections {catalog} provider="discord" />
</section>

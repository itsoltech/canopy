<script lang="ts">
  import { ui } from "@canopy/contracts";
  import { create } from "@bufbuild/protobuf";
  import { onMount } from "svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import MessengerRouteEditor from "./MessengerRouteEditor.svelte";
  import { messengerAccounts, messengerRoutes, deleteMessengerRoute, messengerStatus } from "./api.ts";
  import { providerCopy, providerOf } from "./providers.ts";

  let { botId }: { botId: string } = $props();
  let catalog = $state(create(ui.ListMessengerAccountsResponseSchema));
  let routes = $state<ui.BotMessengerRoute[]>([]);
  let loading = $state(true);
  let loaded = $state(false);
  let busy = $state(false);
  let error = $state("");
  let status = $state("");
  let editRoute = $state<ui.BotMessengerRoute | "new">();
  let remove = $state<string>();

  const availableAccounts = $derived(
    catalog.accounts.filter(
      (account) =>
        account.enabled &&
        ["connected", "connecting", "retrying"].includes(account.status) &&
        !routes.some((route) => route.accountId === account.id),
    ),
  );

  async function reload() {
    error = "";
    loading = true;

    try {
      const [accounts, response] = await Promise.all([messengerAccounts(), messengerRoutes(botId)]);
      catalog = accounts;
      routes = response.routes;
      loaded = true;
    } catch {
      error = "Could not load messengers. Try loading them again.";
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void reload();

    const refresh = () => {
      if (!document.hidden && !editRoute && !busy) void reload();
    };

    window.addEventListener("focus", refresh);
    window.addEventListener("messenger-accounts-changed", refresh);

    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("messenger-accounts-changed", refresh);
    };
  });

  async function saved() {
    editRoute = undefined;
    status = "Message route saved.";
    await reload();
  }

  async function disconnect() {
    if (!remove || busy) return;
    busy = true;
    error = "";

    try {
      await deleteMessengerRoute(remove);
      remove = undefined;
      status = "Message route removed.";
      await reload();
    } catch {
      error = "Could not remove these settings. Try again.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="grid min-w-0 gap-4 text-base/6 sm:text-sm/6">
  <p class="text-zinc-500 dark:text-zinc-400">You can manage routes in your private conversation with this bot.</p>
  {#if loading}<p role="status" class="text-zinc-500 dark:text-zinc-400">Loading messengers…</p>{/if}
  {#if error}
    <Alert tone="error">{error}</Alert>
    <div><Button disabled={loading || busy} onclick={reload}>Reload messengers</Button></div>
  {/if}
  {#if !loading && loaded}
    <div class="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <a href="/settings/connectors#topic-messaging" class="font-medium underline underline-offset-4"
        >Manage messenger accounts</a
      >
      <Button size="sm" disabled={busy || !!editRoute} onclick={reload}>Refresh status</Button>
    </div>
    <div class="grid min-w-0 gap-3">
      <h4 class="font-medium">Message routes</h4>
      {#each routes as route (route.id)}
        {@const account = catalog.accounts.find((item) => item.id === route.accountId)}
        <div class="grid min-w-0 gap-2 rounded-lg bg-zinc-950/3 p-3 dark:bg-white/5">
          <p class="truncate font-medium" title={account?.name}>
            {account?.name ?? "Messenger account"}
          </p>
          <p class="text-sm text-zinc-500 dark:text-zinc-400">
            {route.delivery === "reply" ? `Reply in ${providerCopy(providerOf(account)).label}` : "Notify in Canopy"}
            {#if route.observe}
              · Channel monitoring on{/if}
            {#if !account?.enabled || account.status !== "connected"}
              · {messengerStatus(account)}{/if}
          </p>
          <p class="text-sm break-words text-zinc-500 select-text dark:text-zinc-400">
            Allowed users: {route.userIds.join(", ")}
          </p>
          <div class="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!!editRoute || busy}
              onclick={() => {
                editRoute = route;
                remove = undefined;
              }}>Edit route</Button
            >
            <Button size="sm" disabled={busy} onclick={() => (remove = route.id)}>Remove route</Button>
          </div>
        </div>
      {/each}
      {#if editRoute}
        {#key editRoute}<MessengerRouteEditor
            {botId}
            route={editRoute === "new" ? undefined : editRoute}
            accounts={editRoute === "new" ? availableAccounts : catalog.accounts}
            onsaved={saved}
            oncancel={() => (editRoute = undefined)}
          />{/key}
      {:else if availableAccounts.length}
        {#if !routes.length}<p class="text-zinc-500 dark:text-zinc-400">No message routes yet.</p>{/if}
        <div>
          <Button
            onclick={() => {
              editRoute = "new";
              remove = undefined;
            }}>Add message route</Button
          >
        </div>
      {:else if !routes.length}
        <p class="text-zinc-500 dark:text-zinc-400">
          Connect a Slack, Telegram or Discord bot in Settings to add a message route.
        </p>
      {/if}
    </div>
    {#if remove}
      <div class="grid gap-3 rounded-lg border border-red-500/30 p-3" role="alert">
        <p>Remove this route? The bot stops receiving messages through it.</p>
        <div class="flex flex-wrap justify-end gap-2">
          <Button disabled={busy} onclick={() => (remove = undefined)}>Cancel</Button>
          <Button variant="danger" loading={busy} onclick={disconnect}>Remove route</Button>
        </div>
      </div>
    {/if}
  {/if}
  <p role="status" class="min-h-5 text-sm text-zinc-500 dark:text-zinc-400">{status}</p>
</div>

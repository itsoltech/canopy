<script lang="ts">
  import { ui } from "@canopy/contracts";
  import { create } from "@bufbuild/protobuf";
  import { onMount } from "svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import MessengerAccountEditor from "./MessengerAccountEditor.svelte";
  import MessengerRouteEditor from "./MessengerRouteEditor.svelte";
  import {
    messengerAccounts,
    messengerRoutes,
    deleteMessengerAccount,
    deleteMessengerRoute,
    messengerStatus,
  } from "./api.ts";

  let { botId }: { botId: string } = $props();
  let catalog = $state(create(ui.ListMessengerAccountsResponseSchema));
  let routes = $state<ui.BotMessengerRoute[]>([]);
  let loading = $state(true);
  let loaded = $state(false);
  let busy = $state(false);
  let error = $state("");
  let status = $state("");
  let editAccount = $state<ui.MessengerAccount | "new">();
  let editRoute = $state<ui.BotMessengerRoute | "new">();
  let remove = $state<{ id: string; kind: "account" | "route" }>();

  const availableAccounts = $derived(
    catalog.accounts.filter((account) => !routes.some((route) => route.accountId === account.id)),
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
  });

  async function saved() {
    editAccount = undefined;
    editRoute = undefined;
    status = "Messenger settings saved.";
    await reload();
  }

  async function disconnect() {
    if (!remove || busy) return;
    busy = true;
    error = "";

    try {
      if (remove.kind === "account") await deleteMessengerAccount(remove.id);
      else await deleteMessengerRoute(remove.id);
      remove = undefined;
      status = "Messenger settings removed.";
      await reload();
    } catch {
      error = "Could not remove these settings. Try again.";
    } finally {
      busy = false;
    }
  }

  async function copyManifest() {
    try {
      await navigator.clipboard.writeText(catalog.slackAppManifest);
      status = "Slack manifest copied.";
    } catch {
      error = "Could not copy the manifest. Use Create Slack app to continue.";
    }
  }
</script>

<div class="grid min-w-0 gap-4 text-base/6 sm:text-sm/6">
  <p class="text-zinc-500 dark:text-zinc-400">
    Receive Slack messages and choose where responses go. Accounts and routes save separately from the bot settings
    below. You can also ask this bot to manage routes and instructions in your private conversation.
  </p>
  {#if loading}<p role="status" class="text-zinc-500 dark:text-zinc-400">Loading messengers…</p>{/if}
  {#if error}
    <Alert tone="error">{error}</Alert>
    <div><Button disabled={loading || busy} onclick={reload}>Reload messengers</Button></div>
  {/if}
  {#if !loading && loaded}
    <div class="grid min-w-0 gap-3">
      <div class="flex items-center justify-between gap-3">
        <h4 class="font-medium">Slack accounts</h4>
        <Button size="sm" disabled={busy || !!editAccount || !!editRoute} onclick={reload}>Refresh status</Button>
      </div>
      <p class="text-sm text-zinc-500 dark:text-zinc-400">
        Accounts are shared by bots on this computer. This uses a separate Slack app from the Slack connector in
        Connections.
      </p>
      {#each catalog.accounts as account (account.id)}
        <div class="flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-zinc-950/3 px-3 py-2 dark:bg-white/5">
          <div class="min-w-0 flex-1 basis-36">
            <p class="truncate font-medium" title={account.name}>{account.name}</p>
            <p class="text-sm text-zinc-500 dark:text-zinc-400">{messengerStatus(account)}</p>
          </div>
          <Button
            size="sm"
            disabled={!!editAccount || busy}
            onclick={() => {
              editAccount = account;
              remove = undefined;
            }}>Edit account</Button
          >
          <Button size="sm" disabled={busy} onclick={() => (remove = { id: account.id, kind: "account" })}
            >Disconnect account</Button
          >
        </div>
      {/each}
      {#if editAccount}
        {#key editAccount}
          <MessengerAccountEditor
            account={editAccount === "new" ? undefined : editAccount}
            onsaved={saved}
            oncancel={() => (editAccount = undefined)}
          />
        {/key}
      {:else}
        {#if !catalog.accounts.length}<p class="text-zinc-500 dark:text-zinc-400">
            Connect a Slack account to add a message route.
          </p>{/if}
        <div>
          <Button
            onclick={() => {
              editAccount = "new";
              remove = undefined;
            }}>Connect Slack account</Button
          >
        </div>
      {/if}
      <details class="rounded-lg border border-zinc-950/10 p-3 dark:border-white/10">
        <summary class="cursor-pointer font-medium">Set up the Slack app</summary>
        <div class="grid gap-3 pt-3 text-sm text-zinc-500 dark:text-zinc-400">
          <ol class="grid list-decimal gap-2 pl-5">
            <li>
              Create an app using the Canopy manifest. It enables Socket Mode and the bot’s message events and scopes.
            </li>
            <li>
              Install it in your workspace. In Basic Information, generate an app-level token with the connections:write
              scope.
            </li>
            <li>Copy the app-level token and the bot token from OAuth &amp; Permissions into the account fields.</li>
            <li>
              Invite the app to the channels you want this bot to read. Reinstall it after changing scopes or the
              manifest.
            </li>
          </ol>
          <div class="flex flex-wrap items-center gap-3">
            <a
              href={catalog.slackAppCreateUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="font-medium text-zinc-950 underline underline-offset-4 dark:text-white">Create Slack app</a
            >
            <Button size="sm" onclick={copyManifest}>Copy manifest</Button>
          </div>
        </div>
      </details>
    </div>
    <div class="grid min-w-0 gap-3">
      <h4 class="font-medium">Message routes</h4>
      {#each routes as route (route.id)}
        <div class="grid min-w-0 gap-2 rounded-lg bg-zinc-950/3 p-3 dark:bg-white/5">
          <p
            class="truncate font-medium"
            title={catalog.accounts.find((account) => account.id === route.accountId)?.name}
          >
            {catalog.accounts.find((account) => account.id === route.accountId)?.name ?? "Slack account"}
          </p>
          <p class="text-sm text-zinc-500 dark:text-zinc-400">
            {route.delivery === "reply" ? "Reply in Slack" : "Notify in Canopy"} · {route.observe
              ? "Channel monitoring on"
              : "Channel monitoring off"}
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
            <Button size="sm" disabled={busy} onclick={() => (remove = { id: route.id, kind: "route" })}
              >Remove route</Button
            >
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
        {#if !routes.length}<p class="text-zinc-500 dark:text-zinc-400">
            No message routes yet. Choose who can message this bot and where it responds.
          </p>{/if}
        <div>
          <Button
            onclick={() => {
              editRoute = "new";
              remove = undefined;
            }}>Add message route</Button
          >
        </div>
      {/if}
    </div>
    {#if remove}
      <div class="grid gap-3 rounded-lg border border-red-500/30 p-3" role="alert">
        <p>
          {remove.kind === "account"
            ? "Disconnect this Slack account? Every bot route using it will be removed."
            : "Remove this route? The bot will stop receiving messages through it."}
        </p>
        <div class="flex flex-wrap justify-end gap-2">
          <Button disabled={busy} onclick={() => (remove = undefined)}>Cancel</Button>
          <Button variant="danger" loading={busy} onclick={disconnect}
            >{remove.kind === "account" ? "Disconnect account" : "Remove route"}</Button
          >
        </div>
      </div>
    {/if}
  {/if}
  <p role="status" class="min-h-5 text-sm text-zinc-500 dark:text-zinc-400">{status}</p>
</div>

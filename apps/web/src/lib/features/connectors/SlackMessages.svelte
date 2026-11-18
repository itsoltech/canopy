<script lang="ts">
  import type { connectors, ui } from "@canopy/contracts";
  import { onMount, untrack } from "svelte";
  import { requestJson } from "#lib/shared/http.ts";
  import { objectOf, str } from "#lib/shared/json.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import {
    messengerAccounts,
    saveMessengerAccount,
    deleteMessengerAccount,
    messengerStatus,
  } from "#lib/features/bots/messengers/api.ts";
  import ManualReturn from "./ManualReturn.svelte";
  import SlackMessageToken from "./SlackMessageToken.svelte";
  import SlackMessagesSetup from "./SlackMessagesSetup.svelte";

  let {
    account,
    oauthCompletion,
    onupdate,
    onreconnect,
  }: {
    account: connectors.ConnectorAccount;
    oauthCompletion?: connectors.CompleteConnectorOAuthResponse;
    onupdate: (account: connectors.ConnectorAccount, alreadyConnected?: boolean) => void;
    onreconnect: () => void;
  } = $props();

  let accounts = $state<ui.MessengerAccount[]>([]);
  let manifest = $state("");
  let loading = $state(true);
  let loaded = $state(false);
  let busy = $state(false);
  let error = $state("");
  let status = $state("");
  let editing = $state(false);
  let removing = $state(false);
  let waiting = $state(false);
  let legacyId = $state("");
  let seenCompletion = untrack(() => oauthCompletion);
  const needsAccount = $derived(account.status === "disconnected" || account.status === "needs_reconnect");
  const linked = $derived(accounts.find((item) => item.connectorAccountId === account.id));
  const legacy = $derived(accounts.filter((item) => !item.connectorAccountId));
  const editedAccount = $derived(linked ?? legacy.find((item) => item.id === legacyId));

  const options = $derived([
    { value: "", label: "Set up messages for this account" },
    ...legacy.map((item) => ({ value: item.id, label: item.name })),
  ]);

  async function reload() {
    if (busy) return;

    try {
      const result = await messengerAccounts();
      accounts = result.accounts;
      manifest = result.slackAppManifest;
      loaded = true;
      error = "";
    } catch {
      error = "Could not load the message connection. Refresh its status to try again.";
    } finally {
      loading = false;
    }
  }

  function changed() {
    window.dispatchEvent(new Event("messenger-accounts-changed"));
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
      window.removeEventListener("focus", refresh);
      window.removeEventListener("messenger-accounts-changed", refresh);
      clearInterval(timer);
    };
  });

  $effect(() => {
    if (seenCompletion === oauthCompletion) return;
    seenCompletion = oauthCompletion;

    if (oauthCompletion?.account?.id === account.id)
      untrack(() => {
        waiting = false;
        void reload();
      });
  });

  function connected(next: connectors.ConnectorAccount, alreadyConnected?: boolean) {
    waiting = false;
    onupdate(next, alreadyConnected);
    changed();
  }

  function saved(next: ui.MessengerAccount) {
    accounts = [...accounts.filter((item) => item.id !== next.id), next];
    editing = false;
    legacyId = "";
    status = "Message connection saved.";
    changed();
  }

  async function authorize() {
    if (busy || !linked || needsAccount) return;
    busy = true;
    error = "";

    try {
      const result = objectOf(
        await requestJson("POST", `/api/connectors/${account.id}/oauth`, { slackMessaging: true }, 65000),
      );

      window.location.assign(str(result["authorizationUrl"]));

      if (window.canopyDesktop) waiting = true;
    } catch {
      error = "Could not authorize messages. Check the registered Slack app and try again.";
    } finally {
      busy = false;
    }
  }

  async function setEnabled() {
    if (busy || !linked || (!linked.enabled && needsAccount)) return;
    busy = true;
    error = "";

    try {
      const result = await saveMessengerAccount({
        id: linked.id,
        connectorAccountId: account.id,
        name: linked.name,
        enabled: !linked.enabled,
      });

      if (result.account) saved(result.account);
    } catch {
      error = "Could not change message reception. Try again.";
    } finally {
      busy = false;
    }
  }

  async function disconnect() {
    if (busy || !linked) return;
    busy = true;
    error = "";

    const id = linked.id;

    try {
      await deleteMessengerAccount(id);
      accounts = accounts.filter((item) => item.id !== id);
      removing = false;
      editing = false;
      status = "Message reception disconnected.";
      changed();
    } catch {
      error = "Could not disconnect message reception. Try again.";
    } finally {
      busy = false;
    }
  }
</script>

<Disclosure
  class="border-t border-zinc-950/5 px-3 py-2 text-base/6 sm:text-sm/6 dark:border-white/8"
  summaryClass="py-1"
>
  {#snippet summary()}
    <span class="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <span class="font-medium">Slack messages</span>
      <span role="status" class="text-sm text-zinc-500 dark:text-zinc-400"
        >{loading ? "Loading…" : linked ? messengerStatus(linked) : loaded ? "Not set up" : "Unavailable"}</span
      >
    </span>
  {/snippet}
  <div class="grid min-w-0 gap-3 pt-3">
    <p class="text-zinc-500 dark:text-zinc-400">
      Use this account’s registered Slack app to receive messages for all your bots.
    </p>
    {#if needsAccount}
      <Alert>Reconnect this Slack account to set up or resume messages.</Alert>
      <div><Button size="sm" disabled={busy} onclick={onreconnect}>Reconnect account</Button></div>
    {/if}
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <div><Button size="sm" disabled={busy || loading} onclick={reload}>Refresh status</Button></div>
    {#if loaded}
      <SlackMessagesSetup {manifest} />
      {#if linked}
        {#if linked.status === "needs_authorization"}<p class="text-zinc-500 dark:text-zinc-400">
            The app-level token is saved. Authorize messages to finish connecting.
          </p>
        {:else if linked.status === "needs_reconnect" || linked.status === "error"}<p
            class="text-zinc-500 dark:text-zinc-400"
          >
            Authorize messages again or update the app-level token to reconnect.
          </p>{/if}
        <div class="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={busy || editing || needsAccount} onclick={authorize}
            >{linked.status === "needs_authorization" ? "Authorize messages" : "Reconnect messages"}</Button
          >
          <Button size="sm" disabled={busy || editing || (!linked.enabled && needsAccount)} onclick={setEnabled}
            >{linked.enabled ? "Pause messages" : "Resume messages"}</Button
          >
          <Button size="sm" disabled={busy || editing} onclick={() => (editing = true)}>Update token</Button>
          <Button size="sm" disabled={busy || editing} onclick={() => (removing = true)}>Disconnect messages</Button>
        </div>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">
          Pausing stops reception for every bot using this account. Message routes stay saved.
        </p>
      {:else if !editing}
        <div>
          <Button size="sm" disabled={busy || needsAccount} onclick={() => (editing = true)}>Set up messages</Button>
        </div>
      {/if}
      {#if editing}
        {#if !linked && legacy.length}<Field
            label="Message connection"
            description="Link an earlier connection to preserve its message routes."
          >
            <Select bind:value={legacyId} {options} />
          </Field>{/if}
        {#key editedAccount?.id}<SlackMessageToken
            connector={account}
            account={editedAccount}
            onsaved={saved}
            oncancel={() => (editing = false)}
          />{/key}
      {/if}
      {#if waiting}<ManualReturn {waiting} onconnected={connected} />{/if}
      {#if linked}<p class="text-sm text-zinc-500 dark:text-zinc-400">
          Choose who can message each bot in Bot settings → Messengers.
        </p>{/if}
    {/if}
    {#if status}<p role="status" class="text-sm text-zinc-500 dark:text-zinc-400">{status}</p>{/if}
  </div>
</Disclosure>
<Dialog
  bind:open={removing}
  title="Disconnect messages?"
  description="This removes every bot’s message route for this account. Connected tools keep working. Reconnect and add routes to receive messages again."
  dismissible={!busy}
>
  <DialogActions>
    <Button data-autofocus disabled={busy} onclick={() => (removing = false)}>Cancel</Button>
    <Button variant="danger" loading={busy} onclick={disconnect}>Disconnect messages</Button>
  </DialogActions>
</Dialog>

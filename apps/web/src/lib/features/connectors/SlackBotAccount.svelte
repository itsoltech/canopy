<script lang="ts">
  import type { connectors, ui } from "@canopy/contracts";
  import { untrack } from "svelte";
  import { deleteMessengerAccount, messengerStatus, saveMessengerAccount } from "#lib/features/bots/messengers/api.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import { objectOf, str } from "#lib/shared/json.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import ConnectorIcon from "./ConnectorIcon.svelte";
  import ManualReturn from "./ManualReturn.svelte";
  import SlackBotAppSetup from "./SlackBotAppSetup.svelte";
  import SlackBotSetupDialog from "./SlackBotSetupDialog.svelte";

  let {
    account,
    linkedUser,
    availableUsers,
    sharedManifest,
    oauthCompletion,
    onsaved,
    onremove,
    onrefresh,
  }: {
    account: ui.MessengerAccount;
    linkedUser?: connectors.ConnectorAccount;
    availableUsers: readonly connectors.ConnectorAccount[];
    sharedManifest: string;
    oauthCompletion?: connectors.CompleteConnectorOAuthResponse;
    onsaved: (account: ui.MessengerAccount) => void;
    onremove: (id: string) => void;
    onrefresh: () => void;
  } = $props();

  let open = $state(untrack(() => account.status === "needs_authorization"));
  let editing = $state(false);
  let removing = $state(false);
  let waiting = $state(false);
  let busy = $state(false);
  let error = $state("");
  let seenCompletion = untrack(() => oauthCompletion);

  const shared = $derived(account.requiresSlackUser || Boolean(account.connectorAccountId));
  const orphaned = $derived(shared && !linkedUser);
  const userUnavailable = $derived(linkedUser?.status === "disconnected" || linkedUser?.status === "needs_reconnect");
  const needsAuthorization = $derived(account.status === "needs_authorization");
  const needsReconnect = $derived(["needs_reconnect", "disconnected", "error"].includes(account.status));

  const status = $derived(
    orphaned || userUnavailable
      ? "Slack User needed"
      : needsAuthorization
        ? "Authorization needed"
        : messengerStatus(account),
  );

  $effect(() => {
    if (seenCompletion === oauthCompletion) return;
    seenCompletion = oauthCompletion;

    if (waiting && oauthCompletion?.slackMessaging && oauthCompletion.account?.id === account.connectorAccountId)
      waiting = false;
  });

  async function authorize() {
    if (busy || !linkedUser || userUnavailable) return;
    busy = true;
    error = "";

    try {
      const result = objectOf(
        await requestJson("POST", `/api/connectors/${linkedUser.id}/oauth`, { slackMessaging: true }, 65000),
      );

      window.location.assign(str(result["authorizationUrl"]));

      if (window.canopyDesktop) waiting = true;
    } catch {
      error = "Could not authorize Slack Bot. Check the Slack app settings and try again.";
    } finally {
      busy = false;
    }
  }

  async function setEnabled() {
    if (busy) return;
    busy = true;
    error = "";

    try {
      const result = await saveMessengerAccount({ id: account.id, name: account.name, enabled: !account.enabled });

      if (result.account) onsaved(result.account);
    } catch {
      error = "Could not change message reception. Try again.";
    } finally {
      busy = false;
    }
  }

  async function disconnect() {
    if (busy) return;
    busy = true;
    error = "";

    try {
      await deleteMessengerAccount(account.id);
      onremove(account.id);
    } catch {
      error = "Could not disconnect Slack Bot. Try again.";
    } finally {
      busy = false;
    }
  }
</script>

<Disclosure bind:open class="px-3" summaryClass="min-h-14 items-center py-2 text-base/5 sm:text-sm/5">
  {#snippet summary()}
    <span
      class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 @min-[36rem]:grid-cols-[auto_minmax(0,1fr)_minmax(0,12rem)]"
    >
      <span class="row-span-2 @min-[36rem]:row-span-1"><ConnectorIcon type="slack" /></span>
      <span class="truncate font-medium" title={account.name}>{account.name}</span>
      <span role="status" class="col-start-2 flex min-w-0 items-center gap-1.5 text-sm/5 @min-[36rem]:col-start-auto">
        <StatusDot
          tone={status === "Connected" ? "emerald" : account.status === "error" ? "rose" : "amber"}
          active={account.enabled && (account.status === "connecting" || account.status === "retrying")}
        />
        <span>{status}</span>
      </span>
    </span>
  {/snippet}
  <div class="grid min-w-0 gap-3 border-t border-zinc-950/5 py-3 text-base/6 sm:text-sm/6 dark:border-white/8">
    {#if orphaned}
      <Alert>Link a Slack User account from the same app and workspace to restore these routes.</Alert>
    {:else if userUnavailable}
      <Alert>Reconnect {linkedUser?.name} under Tool accounts, then authorize Slack Bot again.</Alert>
    {:else if needsAuthorization}
      <p>Authorize Slack Bot in Slack to finish connecting.</p>
    {:else if needsReconnect && !shared && account.enabled}
      <p>Check the Slack app and update its tokens to reconnect.</p>
    {:else if linkedUser}
      <p class="wrap-anywhere text-zinc-500 dark:text-zinc-400">
        This bot uses the Slack app registered for {linkedUser.name} in Slack User.
      </p>
    {/if}
    {#if error && !removing}<Alert tone="error">{error}</Alert>{/if}
    <div class="flex flex-wrap gap-2">
      {#if orphaned}
        <Button size="sm" disabled={!availableUsers.length} onclick={() => (editing = true)}>Link Slack User</Button>
      {:else}
        {#if shared}
          <Button
            size="sm"
            variant={needsAuthorization || needsReconnect ? "primary" : "secondary"}
            disabled={busy || waiting || userUnavailable}
            onclick={authorize}>{needsAuthorization ? "Authorize Slack Bot" : "Reconnect Slack Bot"}</Button
          >
        {/if}
        <Button size="sm" disabled={busy || waiting} onclick={() => (editing = true)}>Edit account</Button>
      {/if}
      {#if !orphaned || account.enabled}
        <Button
          size="sm"
          disabled={busy || waiting || (!account.enabled && (userUnavailable || needsAuthorization))}
          onclick={setEnabled}>{account.enabled ? "Pause messages" : "Resume messages"}</Button
        >
      {/if}
      <Button
        size="sm"
        disabled={busy || waiting}
        onclick={() => {
          error = "";
          removing = true;
        }}>Disconnect Slack Bot</Button
      >
    </div>
    {#if orphaned && !availableUsers.length}
      <p class="text-zinc-500 dark:text-zinc-400">Connect Slack User first to link this existing bot.</p>
    {/if}
    {#if shared && linkedUser && sharedManifest}<SlackBotAppSetup shared manifest={sharedManifest} />{/if}
    {#if waiting}<ManualReturn
        {waiting}
        onconnected={() => {
          waiting = false;
          onrefresh();
        }}
      />{/if}
  </div>
</Disclosure>

{#if editing}<SlackBotSetupDialog bind:open={editing} {account} {linkedUser} {availableUsers} {onsaved} />{/if}
<Dialog
  bind:open={removing}
  title="Disconnect Slack Bot?"
  description="This removes every message route using this account. To receive messages again, reconnect the bot and add routes."
  dismissible={!busy}
>
  {#if error && removing}<Alert tone="error" class="mb-3">{error}</Alert>{/if}
  <DialogActions>
    <Button data-autofocus disabled={busy} onclick={() => (removing = false)}>Cancel</Button>
    <Button variant="danger" loading={busy} onclick={disconnect}>Disconnect Slack Bot</Button>
  </DialogActions>
</Dialog>

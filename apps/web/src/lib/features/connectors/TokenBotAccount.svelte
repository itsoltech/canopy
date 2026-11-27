<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { deleteMessengerAccount, messengerStatus, saveMessengerAccount } from "#lib/features/bots/messengers/api.ts";
  import { providerCopy, type MessengerProvider } from "#lib/features/bots/messengers/providers.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import ConnectorIcon from "./ConnectorIcon.svelte";
  import TokenBotDialog from "./TokenBotDialog.svelte";

  let {
    account,
    provider,
    onsaved,
    onremove,
  }: {
    account: ui.MessengerAccount;
    provider: Exclude<MessengerProvider, "slack">;
    onsaved: (account: ui.MessengerAccount) => void;
    onremove: (id: string) => void;
  } = $props();

  const copy = $derived(providerCopy(provider));
  let open = $state(false);
  let editing = $state(false);
  let removing = $state(false);
  let busy = $state(false);
  let error = $state("");
  const status = $derived(messengerStatus(account));
  const needsReconnect = $derived(["needs_reconnect", "disconnected", "error"].includes(account.status));

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
      error = `Could not disconnect ${copy.account}. Try again.`;
    } finally {
      busy = false;
    }
  }
</script>

<Disclosure
  bind:open
  align="center"
  summaryClass="min-h-12 px-3 py-2 text-base/5 hover:bg-zinc-950/3 focus-visible:-outline-offset-4 sm:text-sm/5 dark:hover:bg-white/4"
>
  {#snippet summary()}
    <span
      class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 @min-[24rem]:grid-cols-[auto_minmax(0,1fr)_auto]"
    >
      <ConnectorIcon type={provider} class="row-span-2 @min-[24rem]:row-span-1" />
      <span class="truncate font-medium" title={account.name}>{account.name}</span>
      <span
        role="status"
        class="col-start-2 flex min-w-0 items-center gap-1.5 text-sm/5 text-zinc-600 @min-[24rem]:col-start-auto dark:text-zinc-300"
      >
        <StatusDot
          tone={status === "Connected" ? "emerald" : account.status === "error" ? "rose" : "amber"}
          active={account.enabled && (account.status === "connecting" || account.status === "retrying")}
        />
        <span class="wrap-anywhere">{status}</span>
      </span>
    </span>
  {/snippet}
  <div class="grid min-w-0 gap-3 border-t border-zinc-950/5 p-3 text-base/6 sm:text-sm/6 dark:border-white/8">
    {#if needsReconnect && account.enabled}
      <p>Check the bot in {copy.label} and update its token to reconnect.</p>
    {/if}
    {#if error && !removing}<Alert tone="error">{error}</Alert>{/if}
    <div class="flex flex-wrap gap-2">
      <Button
        size="sm"
        variant={needsReconnect ? "primary" : "secondary"}
        disabled={busy}
        onclick={() => (editing = true)}>Edit account</Button
      >
      <Button size="sm" disabled={busy} onclick={setEnabled}
        >{account.enabled ? "Pause messages" : "Resume messages"}</Button
      >
      <Button
        size="sm"
        disabled={busy}
        onclick={() => {
          error = "";
          removing = true;
        }}>Disconnect {copy.account}</Button
      >
    </div>
  </div>
</Disclosure>

{#if editing}<TokenBotDialog bind:open={editing} {provider} {account} {onsaved} />{/if}
<Dialog
  bind:open={removing}
  title={`Disconnect ${copy.account}?`}
  description="This removes every message route using this account. To receive messages again, reconnect the bot and add routes."
  dismissible={!busy}
>
  {#if error && removing}<Alert tone="error" class="mb-3">{error}</Alert>{/if}
  <DialogActions>
    <Button data-autofocus disabled={busy} onclick={() => (removing = false)}>Cancel</Button>
    <Button variant="danger" loading={busy} onclick={disconnect}>Disconnect {copy.account}</Button>
  </DialogActions>
</Dialog>

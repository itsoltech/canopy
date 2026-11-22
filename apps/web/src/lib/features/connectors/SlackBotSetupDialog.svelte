<script lang="ts">
  import type { connectors, ui } from "@canopy/contracts";
  import { untrack } from "svelte";
  import { saveMessengerAccount } from "#lib/features/bots/messengers/api.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import SlackBotAppSetup from "./SlackBotAppSetup.svelte";

  let {
    open = $bindable(false),
    account,
    linkedUser,
    availableUsers = [],
    sharedManifest = "",
    manifest = "",
    createUrl = "",
    onsaved,
  }: {
    open?: boolean;
    account?: ui.MessengerAccount;
    linkedUser?: connectors.ConnectorAccount;
    availableUsers?: readonly connectors.ConnectorAccount[];
    sharedManifest?: string;
    manifest?: string;
    createUrl?: string;
    onsaved: (account: ui.MessengerAccount) => void;
  } = $props();

  let name = $state(untrack(() => account?.name ?? ""));
  let appToken = $state("");
  let botToken = $state("");
  let userId = $state("");
  let busy = $state(false);
  let submitted = $state(false);
  let error = $state("");
  const relinking = $derived(account?.requiresSlackUser && !linkedUser);
  const selectedUser = $derived(availableUsers.find((user) => user.id === userId));
  const shared = $derived(Boolean(linkedUser || relinking || selectedUser));
  const users = $derived(availableUsers.map((user) => ({ value: user.id, label: user.name })));

  const appTokenError = $derived(
    submitted && (!account || appToken) && !/^xapp-\S+$/.test(appToken.trim())
      ? "Enter an app-level token starting with xapp-."
      : undefined,
  );

  const botTokenError = $derived(
    submitted && !shared && (!account || botToken) && !/^xoxb-\S+$/.test(botToken.trim())
      ? "Enter a bot token starting with xoxb-."
      : undefined,
  );

  async function save() {
    if (busy || (relinking && !selectedUser)) return;
    error = "";
    submitted = true;

    if (appTokenError || botTokenError) return;
    busy = true;

    try {
      const result = await saveMessengerAccount({
        id: account?.id,
        name: name.trim(),
        connectorAccountId: linkedUser?.id ?? selectedUser?.id,
        appToken: appToken.trim() || undefined,
        botToken: shared ? undefined : botToken.trim() || undefined,
      });

      if (!result.account) throw new Error("Slack Bot was not saved");
      onsaved(result.account);
      open = false;
    } catch {
      error = relinking
        ? "Could not link Slack Bot. Check the Slack User account and try again."
        : "Could not save Slack Bot. Check that the tokens come from the same Slack app and try again.";
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  bind:open
  title={relinking ? "Link Slack User" : account ? "Edit Slack Bot" : "Connect Slack Bot"}
  description={relinking
    ? "Choose a Slack User account from the same app and workspace to keep your message routes."
    : account
      ? "Leave token fields blank to keep their saved values."
      : "Receive and reply to messages as your Slack app’s bot."}
  dismissible={!busy}
>
  <form
    class="grid gap-4"
    onsubmit={(event) => {
      event.preventDefault();
      void save();
    }}
  >
    {#if !account}
      {#if users.length && sharedManifest}
        <Field label="Slack app">
          <Select
            bind:value={userId}
            options={[
              { value: "", label: "Use a separate Slack app" },
              ...users.map((user) => ({
                value: user.value,
                label: `Use Slack User · ${user.label}`,
              })),
            ]}
            onchange={() => {
              appToken = "";
              botToken = "";
              submitted = false;
              error = "";
            }}
            disabled={busy}
          />
        </Field>
      {/if}
      {#if shared}
        <SlackBotAppSetup shared manifest={sharedManifest} />
      {:else}
        <SlackBotAppSetup {manifest} {createUrl} />
      {/if}
    {/if}
    {#if relinking}
      <Field label="Slack User account">
        <Select bind:value={userId} options={[{ value: "", label: "Choose an account" }, ...users]} disabled={busy} />
      </Field>
    {:else}
      <Field label="Account name"><Input bind:value={name} maxlength={120} required disabled={busy} /></Field>
    {/if}
    {#if !relinking}
      <Field label="App-level token" optional={!!account} error={appTokenError}>
        <Input
          type="password"
          bind:value={appToken}
          required={!account}
          disabled={busy}
          autocomplete="new-password"
          spellcheck={false}
          placeholder="xapp-…"
        />
      </Field>
      {#if !shared}
        <Field label="Bot token" optional={!!account} error={botTokenError}>
          <Input
            type="password"
            bind:value={botToken}
            required={!account}
            disabled={busy}
            autocomplete="new-password"
            spellcheck={false}
            placeholder="xoxb-…"
          />
        </Field>
      {/if}
    {/if}
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <DialogActions>
      <Button disabled={busy} onclick={() => (open = false)}>Cancel</Button>
      <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || (relinking && !selectedUser)}
        >{relinking
          ? "Link Slack User"
          : account
            ? "Save changes"
            : shared
              ? "Save token"
              : "Connect Slack Bot"}</Button
      >
    </DialogActions>
  </form>
</Dialog>

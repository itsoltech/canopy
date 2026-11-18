<script lang="ts">
  import type { connectors, ui } from "@canopy/contracts";
  import { untrack } from "svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import { saveMessengerAccount, saveOnEnter } from "#lib/features/bots/messengers/api.ts";

  let {
    connector,
    account,
    onsaved,
    oncancel,
  }: {
    connector: connectors.ConnectorAccount;
    account?: ui.MessengerAccount;
    onsaved: (account: ui.MessengerAccount) => void;
    oncancel: () => void;
  } = $props();

  let appToken = $state("");
  const linking = untrack(() => !!account && !account.connectorAccountId);
  let busy = $state(false);
  let error = $state("");

  async function save() {
    if (busy) return;
    error = "";

    if ((!account || appToken) && !appToken.trim().startsWith("xapp-")) {
      error = "Enter an app-level token starting with xapp- and try again.";

      return;
    }

    busy = true;

    try {
      const saved = await saveMessengerAccount({
        id: account?.id,
        connectorAccountId: connector.id,
        name: connector.name,
        enabled: account?.enabled ?? true,
        appToken: appToken.trim() || undefined,
      });

      appToken = "";

      if (saved.account) onsaved(saved.account);
    } catch {
      error = "Could not save the message connection. Check the app-level token and try again.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="grid min-w-0 gap-3" aria-busy={busy}>
  {#if linking}<p class="text-zinc-500 dark:text-zinc-400">
      Link only a connection from this same Slack app and workspace. Existing message routes stay in place.
    </p>{/if}
  <Field
    label="App-level token"
    optional={!!account}
    description={account
      ? "Leave blank to keep the saved token."
      : "In Basic Information, generate a token with connections:write."}
  >
    <Input
      onkeydown={(event) => saveOnEnter(event, save)}
      type="password"
      bind:value={appToken}
      disabled={busy}
      autocomplete="new-password"
      spellcheck={false}
      placeholder="xapp-…"
    />
  </Field>
  <p class="text-sm text-zinc-500 dark:text-zinc-400">
    Use the registered Slack app’s token. Canopy stores it encrypted and never shows it again.
  </p>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <div class="flex flex-wrap justify-end gap-2">
    <Button disabled={busy} onclick={oncancel}>Cancel</Button>
    <Button variant="primary" loading={busy} onclick={save}>{linking ? "Link connection" : "Save token"}</Button>
  </div>
</div>

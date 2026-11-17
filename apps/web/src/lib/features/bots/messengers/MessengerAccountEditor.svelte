<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { untrack } from "svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import { saveMessengerAccount, saveOnEnter } from "./api.ts";

  let {
    account,
    onsaved,
    oncancel,
  }: {
    account?: ui.MessengerAccount;
    onsaved: () => void;
    oncancel: () => void;
  } = $props();

  let name = $state(untrack(() => account?.name ?? ""));
  let enabled = $state(untrack(() => account?.enabled ?? true));
  let appToken = $state("");
  let botToken = $state("");
  let busy = $state(false);
  let error = $state("");

  async function save() {
    if (busy) return;
    error = "";

    if (!name.trim()) {
      error = "Name this Slack account before saving.";

      return;
    }

    if ((!account || appToken) && !appToken.startsWith("xapp-")) {
      error = "Add an app-level token starting with xapp- and try again.";

      return;
    }

    if ((!account || botToken) && !botToken.startsWith("xoxb-")) {
      error = "Add a bot token starting with xoxb- and try again.";

      return;
    }

    busy = true;

    try {
      await saveMessengerAccount({
        id: account?.id,
        name: name.trim(),
        enabled,
        appToken: appToken || undefined,
        botToken: botToken || undefined,
      });
      appToken = "";
      botToken = "";
      onsaved();
    } catch {
      error = "Could not save the Slack account. Check its tokens and try again.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="grid min-w-0 gap-3 rounded-xl border border-zinc-950/10 p-4 dark:border-white/10" aria-busy={busy}>
  <h4 class="font-medium">{account ? "Edit Slack account" : "Connect Slack account"}</h4>
  <Field label="Account name"
    ><Input
      onkeydown={(event) => saveOnEnter(event, save)}
      bind:value={name}
      disabled={busy}
      maxlength={100}
      placeholder="Team workspace"
    /></Field
  >
  <Field
    label="App-level token"
    optional={!!account}
    description={account ? "Leave blank to keep the saved token." : "Create an app-level token with connections:write."}
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
  <Field
    label="Bot token"
    optional={!!account}
    description={account ? "Leave blank to keep the saved token." : "Install the Slack app, then copy its bot token."}
  >
    <Input
      onkeydown={(event) => saveOnEnter(event, save)}
      type="password"
      bind:value={botToken}
      disabled={busy}
      autocomplete="new-password"
      spellcheck={false}
      placeholder="xoxb-…"
    />
  </Field>
  <Checkbox
    name="messenger-enabled"
    label="Enable account"
    description="Turning this off pauses every bot using this account."
    bind:checked={enabled}
    disabled={busy}
  />
  <p class="text-sm text-zinc-500 dark:text-zinc-400">
    Tokens stay encrypted on this computer’s gateway. Saved tokens are never shown again.
  </p>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <div class="flex flex-wrap justify-end gap-2">
    <Button disabled={busy} onclick={oncancel}>Cancel</Button>
    <Button variant="primary" loading={busy} onclick={save}>Save account</Button>
  </div>
</div>

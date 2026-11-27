<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { untrack } from "svelte";
  import { saveMessengerAccount } from "#lib/features/bots/messengers/api.ts";
  import { providerCopy, type MessengerProvider } from "#lib/features/bots/messengers/providers.ts";
  import { HttpError } from "#lib/shared/http.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import StepList from "./StepList.svelte";

  /** Connects or edits a Telegram or Discord bot, which needs only a bot token. */
  let {
    open = $bindable(false),
    provider,
    account,
    onsaved,
  }: {
    open?: boolean;
    provider: Exclude<MessengerProvider, "slack">;
    account?: ui.MessengerAccount;
    onsaved: (account: ui.MessengerAccount) => void;
  } = $props();

  const copy = $derived(providerCopy(provider));
  let name = $state(untrack(() => account?.name ?? ""));
  let token = $state("");
  let busy = $state(false);
  let error = $state("");

  async function save() {
    if (busy) return;
    error = "";
    busy = true;

    try {
      const result = await saveMessengerAccount({
        id: account?.id,
        name: name.trim(),
        ...(!account && { provider }),
        botToken: token.trim() || undefined,
      });

      if (!result.account) throw new Error(`${copy.account} was not saved`);
      onsaved(result.account);
      open = false;
    } catch (cause) {
      // The gateway explains setup problems in fixed text; anything else gets a generic next step.
      error =
        cause instanceof HttpError && cause.status >= 400 && cause.status < 500
          ? cause.message
          : `Could not save ${copy.account}. Check the token and try again.`;
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  bind:open
  title={account ? `Edit ${copy.account}` : `Connect ${copy.account}`}
  description={account
    ? "Leave the token blank to keep its saved value."
    : `Receive and reply to ${copy.label} messages as your bot.`}
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
      <div class="rounded-lg bg-zinc-950/2.5 p-3 text-base/6 sm:text-sm/6 dark:bg-white/5">
        <StepList steps={copy.setup} />
      </div>
    {/if}
    <Field label="Account name"><Input bind:value={name} maxlength={120} required disabled={busy} /></Field>
    <Field label="Bot token" optional={!!account}>
      <Input
        type="password"
        bind:value={token}
        required={!account}
        disabled={busy}
        autocomplete="new-password"
        spellcheck={false}
        placeholder={copy.tokenPlaceholder}
      />
    </Field>
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <DialogActions>
      <Button disabled={busy} onclick={() => (open = false)}>Cancel</Button>
      <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || (!account && !token.trim())}
        >{account ? "Save changes" : `Connect ${copy.account}`}</Button
      >
    </DialogActions>
  </form>
</Dialog>

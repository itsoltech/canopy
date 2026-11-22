<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { isString } from "#lib/shared/json.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";

  let {
    open = $bindable(false),
    settings,
    busy,
    error,
    onsave,
  }: {
    open?: boolean;
    settings: ui.PushRelaySettings;
    busy: boolean;
    error: string;
    onsave: (body: { origin: string; bearer: string; caPem?: string }) => void;
  } = $props();

  let origin = $state("");
  let caPem = $state("");
  let clearCa = $state(false);
  let form = $state<HTMLFormElement>();
  const sameOrigin = $derived(!!settings.origin && URL.parse(origin.trim())?.origin === settings.origin);
  const hasSavedCa = $derived(sameOrigin && settings.hasPrivateCa);
  const usesSystemCa = $derived(hasSavedCa && clearCa);

  $effect(() => {
    if (!open) form?.reset();
    origin = open ? settings.origin : "";
    caPem = "";
    clearCa = false;
  });

  function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();

    if (busy) return;
    const bearer = new FormData(event.currentTarget).get("bearer");
    const certificate = usesSystemCa ? "" : caPem.trim() || undefined;

    onsave({
      origin: origin.trim(),
      bearer: isString(bearer) ? bearer.trim() : "",
      ...(certificate !== undefined && { caPem: certificate }),
    });
  }
</script>

<Dialog bind:open title={settings.origin ? "Edit push relay" : "Configure push relay"} dismissible={!busy}>
  <form bind:this={form} method="post" class="grid gap-5" autocomplete="off" onsubmit={submit}>
    <Field label="Relay address" description="Enter the HTTPS address from your relay operator.">
      <Input type="url" placeholder="https://relay.example.com" bind:value={origin} required disabled={busy} />
    </Field>
    <Field
      label="Relay token"
      optional={sameOrigin}
      description={sameOrigin ? "Leave blank to keep the saved token." : "Enter the token for this relay address."}
    >
      <Input
        type="password"
        name="bearer"
        autocomplete="off"
        spellcheck={false}
        required={!sameOrigin}
        disabled={busy}
      />
    </Field>
    <Disclosure summaryClass="text-base/6 sm:text-sm/6">
      {#snippet summary()}
        <span class="flex flex-wrap justify-between gap-x-2">
          Certificates
          {#if usesSystemCa || hasSavedCa}<span class="text-sm/6 text-zinc-500 sm:text-xs/6 dark:text-zinc-400">
              {usesSystemCa ? "Use system certificates" : "Private CA saved"}
            </span>{/if}
        </span>
      {/snippet}
      <div class="grid gap-3 pt-3">
        <Field
          label="Private CA certificate (PEM)"
          optional
          description={hasSavedCa
            ? "Leave blank to keep the saved certificate."
            : "Add a certificate if your relay uses a private certificate authority."}
        >
          <Textarea rows={3} bind:value={caPem} spellcheck={false} disabled={busy || usesSystemCa} />
        </Field>
        {#if hasSavedCa}<Checkbox
            name="clear-ca"
            label="Use system certificates"
            description="Remove the relay’s private CA certificate."
            bind:checked={clearCa}
            disabled={busy}
          />{/if}
      </div>
    </Disclosure>
    {#if error}<Alert tone="error" title="Could not save relay">{error}</Alert>{/if}
    <DialogActions>
      <Button disabled={busy} onclick={() => (open = false)}>Cancel</Button>
      <Button type="submit" variant="primary" loading={busy}>Save relay</Button>
    </DialogActions>
  </form>
</Dialog>

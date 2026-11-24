<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";

  let {
    open = $bindable(false),
    invitation,
    qr,
    usable,
    seconds,
    copied,
    manualCopyText,
    paired,
    oncopy,
    class: className,
  }: {
    open?: boolean;
    invitation?: ui.CreateMobilePairingResponse;
    qr: string;
    usable: boolean;
    seconds: number;
    copied: boolean;
    manualCopyText: string;
    paired: boolean;
    oncopy: () => void;
    class?: ClassValue;
  } = $props();

  const desktop = $derived(invitation?.pairing?.clientKind === "desktop");
</script>

<Dialog
  bind:open
  class={className}
  title={desktop ? "Pair a desktop app" : "Pair a phone"}
  description={paired || !usable
    ? ""
    : desktop
      ? "Copy this invitation into Desktop settings → Connect to a Canopy gateway. It grants full access to your gateway’s UI."
      : "Open Canopy on your phone and scan this QR code. Use a network both devices can reach."}
>
  <div class="grid min-w-0 justify-items-center gap-5">
    {#if paired && desktop}<Alert title="Desktop app invitation accepted">
        Open Device access to check when the app last connected to this gateway.
      </Alert>
    {:else if paired}<Alert tone="info">Device paired.</Alert>
    {:else if !usable}<Alert tone="warning"
        >This code expired or was revoked. Close this window and create a new code.</Alert
      >
    {:else}
      {#if !desktop}<img
          src={qr}
          alt="One-time Canopy pairing QR code"
          width="260"
          height="260"
          class="h-auto max-w-full rounded-xl bg-white"
        />{/if}
      <div class="grid justify-items-center gap-2">
        <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          {desktop ? "Keep this invitation private." : "Or enter the code, an address and fingerprint"}
        </p>
        {#if !desktop && !manualCopyText}<p class="font-mono text-xl tracking-wide select-all">
            {invitation?.code}
          </p>{/if}
        <Button size="sm" onclick={oncopy}>{copied ? "Copied" : desktop ? "Copy invitation" : "Copy code"}</Button>
      </div>
      {#if manualCopyText}
        <div class="grid w-full min-w-0 gap-2">
          <p role="status" class="text-base/6 sm:text-sm/6">
            {desktop
              ? "Could not copy the invitation. Select and copy it manually."
              : "Could not copy the code. Select and copy it manually."}
          </p>
          <Field label={desktop ? "Desktop invitation" : "Pairing code"}>
            <Textarea
              readonly
              value={manualCopyText}
              rows={desktop ? 4 : 1}
              spellcheck={false}
              autocomplete="off"
              onfocus={(event) => event.currentTarget.select()}
            />
          </Field>
        </div>
      {/if}
      <div class="grid w-full min-w-0 gap-3">
        {#each invitation?.routes?.addresses ?? [] as address (address)}
          <div class="flex min-w-0 items-center gap-2">
            <p class="min-w-0 flex-1 font-mono text-base/6 break-all sm:text-sm/6">{address}</p>
            <CopyButton text={address} label="Copy address" />
          </div>
        {/each}
        <div class="flex min-w-0 items-center gap-2">
          <p class="min-w-0 flex-1 font-mono text-base/6 break-all text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
            {invitation?.routes?.fingerprint}
          </p>
          <CopyButton text={invitation?.routes?.fingerprint ?? ""} label="Copy certificate fingerprint" />
        </div>
      </div>
      <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        One use · expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
      </p>
    {/if}
  </div>
</Dialog>

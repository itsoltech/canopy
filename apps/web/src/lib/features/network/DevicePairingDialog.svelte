<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";

  let {
    open = $bindable(false),
    invitation,
    qr,
    usable,
    seconds,
    copied,
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
  description={desktop
    ? "Copy this invitation into Desktop settings → Connect to a Canopy gateway. It grants full access to your gateway’s UI."
    : "Open Canopy on your phone and scan this QR code. Use a network both devices can reach."}
>
  <div class="grid min-w-0 justify-items-center gap-5">
    {#if paired}<Alert tone="info">Device paired. You can close this window.</Alert>
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
          {desktop
            ? "Keep this invitation private. It can be used once."
            : "Or enter the code, an address and fingerprint"}
        </p>
        <p class="font-mono text-xl tracking-wide select-all">{invitation?.code}</p>
        <Button size="sm" onclick={oncopy}>{copied ? "Copied" : desktop ? "Copy invitation" : "Copy code"}</Button>
      </div>
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

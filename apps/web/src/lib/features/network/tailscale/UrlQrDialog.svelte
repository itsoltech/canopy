<script lang="ts">
  import QRCode from "qrcode";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";

  /** The HTTPS over Tailscale address as a QR code for a phone in the same tailnet. */
  let { open = $bindable(false), url }: { open?: boolean; url: string } = $props();

  let qr = $state("");

  $effect(() => {
    if (!open || !url) return;
    let current = true;

    void QRCode.toDataURL(url, { width: 260, margin: 2, errorCorrectionLevel: "M" }).then((data) => {
      if (current) qr = data;
    });

    return () => {
      current = false;
    };
  });
</script>

<Dialog bind:open title="Open on a phone" description="Scan this code on a phone signed in to the same tailnet.">
  <div class="grid min-w-0 justify-items-center gap-5">
    {#if qr}<img
        src={qr}
        alt={`QR code for ${url}`}
        width="260"
        height="260"
        class="h-auto max-w-full rounded-xl bg-white"
      />{/if}
    <div class="flex w-full min-w-0 items-center gap-2">
      <p class="min-w-0 flex-1 font-mono text-base/6 break-all sm:text-sm/6">{url}</p>
      <CopyButton text={url} label={`Copy ${url}`} class="shrink-0" />
    </div>
  </div>
</Dialog>

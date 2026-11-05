<script lang="ts">
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";

  /** The HTTPS port of HTTPS over Tailscale: a chosen one, or back to automatic (0). */
  let {
    open = $bindable(false),
    port,
    automatic,
    busy = false,
    error = "",
    onsubmit,
  }: {
    open?: boolean;
    port: number;
    automatic: boolean;
    busy?: boolean;
    error?: string;
    onsubmit: (port: number) => void;
  } = $props();

  let value = $state<number>();

  $effect(() => {
    if (open) value = port || undefined;
  });
</script>

<Dialog
  bind:open
  title="Change HTTPS port"
  description="Devices open Canopy at the new address. The old address stops working."
>
  <form
    class="grid gap-5"
    onsubmit={(event) => {
      event.preventDefault();
      if (value) onsubmit(value);
    }}
  >
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <Field label="Port" description="From 1 to 65535. Another Tailscale Serve entry can't share it."
      ><Input name="tailscale-https-port" type="number" min={1} max={65535} bind:value required /></Field
    >
    <DialogActions>
      {#if !automatic}<Button disabled={busy} onclick={() => onsubmit(0)}>Use automatic port</Button>{/if}
      <Button type="submit" variant="primary" disabled={busy || !value} loading={busy}>Use this port</Button>
    </DialogActions>
  </form>
</Dialog>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";

  const capabilities = useGatewayCapabilities();

  /** A fixed port for a firewall that allows only certain ports, or a new free one. */
  let {
    open = $bindable(false),
    port,
    busy = false,
    error = "",
    onsubmit,
    onchoose,
    class: className,
  }: {
    open?: boolean;
    port: number;
    busy?: boolean;
    error?: string;
    onsubmit: (port: number) => void;
    onchoose: () => void;
    class?: ClassValue;
  } = $props();

  let value = $state<number>();

  $effect(() => {
    if (open) value = port || undefined;
  });
</script>

<Dialog
  bind:open
  class={className}
  title="Change port"
  description={capabilities?.linkedComputers
    ? "Phones and linked computers learn the new port when they next connect here. A phone that can't reach this computer then needs the new address."
    : "Paired devices and workers learn the new port when they next connect here. A device that can't reach this gateway then needs the new address."}
>
  <form
    class="grid gap-5"
    onsubmit={(event) => {
      event.preventDefault();
      if (value) onsubmit(value);
    }}
  >
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <Field label="Port" description="From 1 to 65535. Ports above 1024 usually work without extra permissions."
      ><Input name="port" type="number" min={1} max={65535} bind:value required /></Field
    >
    <DialogActions>
      <Button disabled={busy} onclick={onchoose}>Pick a free port</Button>
      <Button type="submit" variant="primary" disabled={busy || !value} loading={busy}>Use this port</Button>
    </DialogActions>
  </form>
</Dialog>

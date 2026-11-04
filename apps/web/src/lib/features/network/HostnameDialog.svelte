<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";

  /** Another name devices can use for this computer: a Tailscale MagicDNS name, a DNS name, a forwarded port. */
  let {
    open = $bindable(false),
    busy = false,
    error = "",
    onsubmit,
    class: className,
  }: {
    open?: boolean;
    busy?: boolean;
    error?: string;
    onsubmit: (hostname: string) => void;
    class?: ClassValue;
  } = $props();

  let hostname = $state("");

  $effect(() => {
    if (!open) hostname = "";
  });
</script>

<Dialog
  bind:open
  class={className}
  title="Add hostname"
  description="A name paired devices and workers can also use, like a Tailscale MagicDNS name or a DNS name of this server. Detected addresses are added automatically."
>
  <form
    class="grid gap-5"
    onsubmit={(event) => {
      event.preventDefault();
      onsubmit(hostname);
    }}
  >
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <Field
      label="Hostname"
      description="Add :port only when a router or firewall forwards another port to this computer."
      ><Input
        name="hostname"
        bind:value={hostname}
        placeholder="laptop.tailnet.ts.net"
        required
        autocomplete="off"
        spellcheck={false}
      /></Field
    >
    <Button type="submit" variant="primary" disabled={busy} loading={busy}>Add hostname</Button>
  </form>
</Dialog>

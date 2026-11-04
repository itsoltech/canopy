<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";

  /** A manual route: an address of the linked computer's listener. Used only through its pinned certificate. */
  let {
    open = $bindable(false),
    computer,
    busy = false,
    error = "",
    onsubmit,
    class: className,
  }: {
    open?: boolean;
    computer: ui.LinkedComputer | undefined;
    busy?: boolean;
    error?: string;
    onsubmit: (address: string) => void;
    class?: ClassValue;
  } = $props();

  let address = $state("");

  $effect(() => {
    if (!open) address = "";
  });
</script>

<Dialog
  bind:open
  class={className}
  title="Add route"
  description={`Another address where ${computer?.displayName || computer?.name || "this computer"} listens, for example on a VPN. The connection still has to present its pinned certificate.`}
>
  <form
    class="grid gap-5"
    onsubmit={(event) => {
      event.preventDefault();
      onsubmit(address);
    }}
  >
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <Field label="Address"
      ><Input
        name="route-address"
        bind:value={address}
        placeholder="https://laptop.tailnet.ts.net:4100"
        required
        autocomplete="off"
        spellcheck={false}
      /></Field
    >
    <Button type="submit" variant="primary" disabled={busy} loading={busy}>Add route</Button>
  </form>
</Dialog>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import CommandBlock from "./CommandBlock.svelte";
  import { workerSsh } from "./ssh.ts";

  let { class: className }: { class?: ClassValue } = $props();
  let publicKey = $state("");
  let busy = $state(false);
  let rotating = $state(false);
  let error = $state("");

  async function load(rotate = false) {
    busy = true;
    error = "";

    try {
      await workerSsh({ action: rotate ? "rotate" : "key" }, AbortSignal.timeout(20_000), (event) => {
        if (event.publicKey) publicKey = event.publicKey;
      });
      rotating = false;
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load SSH key";
    } finally {
      busy = false;
    }
  }
</script>

<div class={["grid min-w-0 gap-3", className]}>
  <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    Add this public key to the target user’s <code>~/.ssh/authorized_keys</code>. Canopy keeps your private key
    encrypted in the gateway.
  </p>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  {#if publicKey}<CommandBlock text={publicKey} label="Canopy SSH public key" copyLabel="Copy public key" />{/if}
  <div class="flex flex-wrap gap-2">
    <Button size="sm" loading={busy} onclick={() => void load()}
      >{publicKey ? "Refresh public key" : "Show public key"}</Button
    >
    {#if publicKey}<Button size="sm" disabled={busy} onclick={() => (rotating = !rotating)}>Rotate key…</Button>{/if}
  </div>
  {#if rotating}
    <Alert tone="warning"
      >Rotation replaces Canopy’s key for future SSH connections. Remove the old public key from your hosts and add the
      new one. Running workers stay connected.
      {#snippet actions()}<Button size="sm" loading={busy} onclick={() => void load(true)}>Rotate SSH key</Button
        ><Button size="sm" onclick={() => (rotating = false)}>Cancel</Button>{/snippet}
    </Alert>
  {/if}
</div>

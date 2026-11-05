<script lang="ts">
  import type { connectors } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import { completeConnectorOAuth } from "./api.ts";

  /** The manual return: the code the sign-in page shows when Canopy did not open by itself. */
  let {
    onconnected,
    class: className,
  }: { onconnected: (account: connectors.ConnectorAccount) => void; class?: ClassValue } = $props();

  let pasted = $state("");
  let busy = $state(false);
  let error = $state("");

  async function submit() {
    if (busy) return;
    busy = true;
    error = "";

    try {
      const result = await completeConnectorOAuth({ pastedCode: pasted.trim() });

      if (!result.account || result.error) throw new Error(result.error);
      pasted = "";
      onconnected(result.account);
    } catch {
      error = "This code did not work. It works once and expires after 10 minutes. Start sign-in again.";
    } finally {
      busy = false;
    }
  }
</script>

<div class={["grid gap-3", className]}>
  <Field label="Sign-in code" description="Copy it from the sign-in page, then paste it here."
    ><Input bind:value={pasted} autocomplete="off" spellcheck={false} disabled={busy} /></Field
  >
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <div><Button size="sm" loading={busy} disabled={!pasted.trim()} onclick={submit}>Use code</Button></div>
</div>

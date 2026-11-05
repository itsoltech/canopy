<script lang="ts">
  import type { connectors } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import ConnectionError from "./ConnectionError.svelte";
  import { completeConnectorOAuth } from "./api.ts";

  /** The manual return: the code the sign-in page shows when Canopy did not open by itself. */
  let {
    onconnected,
    class: className,
  }: { onconnected: (account: connectors.ConnectorAccount, alreadyConnected?: boolean) => void; class?: ClassValue } =
    $props();

  let pasted = $state("");
  let busy = $state(false);
  let error = $state("");
  let failure = $state<connectors.ConnectorError>();

  async function submit() {
    if (busy) return;
    busy = true;
    error = "";
    failure = undefined;

    try {
      const result = await completeConnectorOAuth({ pastedCode: pasted.trim() });

      if (result.failure || result.error || !result.account) {
        failure = result.failure;
        error = result.error || "Sign-in could not finish. Start sign-in again.";

        return;
      }

      pasted = "";
      onconnected(result.account, result.alreadyConnected);
    } catch {
      error = "Could not reach Canopy. Check the connection, then use the code again.";
    } finally {
      busy = false;
    }
  }
</script>

<div class={["grid gap-3", className]}>
  <Field label="Sign-in code" description="Paste the code from the sign-in page, or that page's whole address."
    ><Input bind:value={pasted} autocomplete="off" spellcheck={false} disabled={busy} /></Field
  >
  {#if failure}<ConnectionError error={failure} />{:else if error}<Alert tone="error">{error}</Alert>{/if}
  <div><Button size="sm" loading={busy} disabled={!pasted.trim()} onclick={submit}>Use code</Button></div>
</div>

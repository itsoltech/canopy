<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { requestJson } from "#lib/shared/http.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import CallbackUrl from "./CallbackUrl.svelte";

  /** A registered OAuth app for one connector type: its callback to register, then issuer, client ID and secret. */
  let {
    type,
    callback,
    saved = false,
    ondone,
    class: className,
  }: { type: string; callback: string; saved?: boolean; ondone: () => void; class?: ClassValue } = $props();

  let clientId = $state("");
  let clientSecret = $state("");

  let issuer = $state(
    untrack(() =>
      type === "slack" ? "https://mcp.slack.com" : type === "github" ? "https://github.com/login/oauth" : "",
    ),
  );

  let busy = $state(false);
  let error = $state("");

  async function save() {
    if (busy) return;
    busy = true;
    error = "";
    const body = { connectorType: type, clientId, clientSecret, issuer };
    clientSecret = "";

    try {
      await requestJson("POST", "/api/connectors/oauth/app", body);
      ondone();
    } catch {
      error = "Could not save the OAuth app. Check its client ID and issuer.";
    } finally {
      busy = false;
    }
  }
</script>

<div class={["grid gap-4", className]}>
  <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    {saved
      ? "An app is saved for this connector type. Saving again replaces it for every account."
      : "Saved once for this connector type, for every account."}
  </p>
  <CallbackUrl url={callback} />
  <Field label="Authorization server issuer"
    ><Input bind:value={issuer} placeholder="https://auth.example.com" disabled={busy} /></Field
  >
  <Field label="Client ID"><Input bind:value={clientId} autocomplete="off" spellcheck={false} disabled={busy} /></Field>
  <Field label="Client secret" optional
    ><Input type="password" bind:value={clientSecret} autocomplete="off" spellcheck={false} disabled={busy} /></Field
  >
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <div><Button size="sm" loading={busy} disabled={!clientId || !issuer} onclick={save}>Save OAuth app</Button></div>
</div>

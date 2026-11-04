<script lang="ts">
  import { connectors } from "@canopy/contracts";
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { page } from "$app/state";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import OAuthAppForm from "./OAuthAppForm.svelte";

  let {
    open = $bindable(false),
    type,
    account,
    onsave,
    class: className,
  }: {
    open?: boolean;
    type: connectors.ConnectorType;
    account?: connectors.ConnectorAccount | undefined;
    onsave: (account: connectors.ConnectorAccount) => void;
    class?: ClassValue;
  } = $props();

  let savedAccount = $state(untrack(() => account));
  let name = $state(untrack(() => account?.name ?? ""));
  let endpoint = $state(untrack(() => account?.url ?? type.url));
  let transport = $state(untrack(() => account?.transport ?? "http"));
  let authKind = $state(untrack(() => account?.authKind ?? type.authKinds[0] ?? "oauth"));
  let token = $state("");
  let headerText = $state("");
  let scope = $state("");
  let busy = $state(false);
  let error = $state("");
  let appSaved = $state(untrack(() => type.oauthAppSet));
  const callback = $derived(`${page.url.origin}/api/connectors/oauth/callback`);

  async function connect() {
    if (busy) return;
    busy = true;
    error = "";

    try {
      const headers: Record<string, string> = {};

      for (const line of headerText.split("\n").filter((s) => s.trim())) {
        const colon = line.indexOf(":");

        if (colon < 1) throw new Error("Use one header per line: Header-Name: value");
        headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
      }

      const body = {
        id: savedAccount?.id ?? "",
        connectorType: type.id,
        name,
        url: endpoint,
        transport,
        authKind,
        token: authKind === "headers" ? token : "",
        headers: authKind === "headers" ? headers : {},
        replaceCredentials: true,
        expectedRevision: savedAccount?.revision.toString() ?? "0",
      };

      token = "";
      headerText = "";

      const saved = decode(
        connectors.ConnectorAccountResponseSchema,
        await requestJson("POST", "/api/connectors", body),
      ).account!;

      savedAccount = saved;
      onsave(saved);

      if (authKind === "oauth") {
        const response = (await requestJson("POST", `/api/connectors/${saved.id}/oauth`, { scope }, 65000)) as {
          authorizationUrl: string;
        };

        window.location.assign(response.authorizationUrl);
      } else open = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not connect this account.";
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  bind:open
  title="{account ? 'Reconnect' : 'Connect'} {type.name}"
  description={type.requirements}
  dismissible={!busy}
  class={className}
>
  <form
    class="grid gap-5"
    onsubmit={(event) => {
      event.preventDefault();
      void connect();
    }}
  >
    <Field label="Account name" description="A name you recognize, such as personal or work."
      ><Input bind:value={name} required maxlength={80} disabled={busy} placeholder="work" /></Field
    >
    {#if !type.url || type.id === "custom"}<Field label="Remote MCP endpoint"
        ><Input bind:value={endpoint} required disabled={busy} placeholder="https://mcp.example.com/mcp" /></Field
      >{/if}
    {#if type.id === "custom"}<Field label="Transport"
        ><Select
          bind:value={transport}
          disabled={busy}
          options={[
            { value: "http", label: "Streamable HTTP" },
            { value: "sse", label: "SSE" },
          ]}
        /></Field
      >{/if}
    {#if type.authKinds.length > 1}<Field label="Authentication"
        ><Select
          bind:value={authKind}
          disabled={busy}
          options={type.authKinds.map((value) => ({
            value,
            label: value === "oauth" ? "Sign in with OAuth" : "Token or secret headers",
          }))}
        /></Field
      >{/if}
    {#if authKind === "headers"}
      <Field label="Bearer token" optional
        ><Input
          type="password"
          bind:value={token}
          autocomplete="off"
          spellcheck={false}
          disabled={busy}
          placeholder="Stored encrypted in the gateway"
        /></Field
      >
      <Disclosure summaryClass="text-base/6 sm:text-sm/6"
        >{#snippet summary()}Custom secret headers{/snippet}
        <div class="pt-3">
          <Field label="Headers" optional description="One per line: Header-Name: value"
            ><Textarea bind:value={headerText} rows={3} autocomplete="off" spellcheck={false} disabled={busy} /></Field
          >
        </div></Disclosure
      >
    {:else}
      <Field label="OAuth scopes" optional description="Space-separated scopes required by your application."
        ><Input
          bind:value={scope}
          disabled={busy}
          placeholder={type.id === "slack" ? "search:read.public users:read" : "Use server defaults"}
        /></Field
      >
      <p class="text-base/6 wrap-anywhere text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Callback: <code>{callback}</code>
      </p>
      <Disclosure summaryClass="text-base/6 sm:text-sm/6"
        >{#snippet summary()}{appSaved ? "OAuth app configured · Replace" : "Use a registered OAuth app"}{/snippet}
        <div class="pt-4"><OAuthAppForm type={type.id} ondone={() => (appSaved = true)} /></div></Disclosure
      >
    {/if}
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <DialogActions
      ><Button disabled={busy} onclick={() => (open = false)}>Cancel</Button><Button
        type="submit"
        variant="primary"
        loading={busy}
        disabled={!name.trim() || !endpoint}
      >
        {authKind === "oauth" ? "Continue to sign in" : "Connect account"}</Button
      ></DialogActions
    >
  </form>
</Dialog>

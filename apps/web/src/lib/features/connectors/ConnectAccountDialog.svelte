<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { connectors } from "@canopy/contracts";
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { page } from "$app/state";
  import { requestJson } from "#lib/shared/http.ts";
  import { objectOf, str } from "#lib/shared/json.ts";
  import { decode } from "#lib/shared/wire.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import { rise } from "#lib/shared/ui/motion.ts";
  import Select from "#lib/shared/ui/Select.svelte";
  import AuthMethodPicker from "./AuthMethodPicker.svelte";
  import OAuthFields from "./OAuthFields.svelte";
  import SetupSteps from "./SetupSteps.svelte";
  import TokenFields from "./TokenFields.svelte";

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

  const methods = $derived(
    type.authKinds.map(
      (kind) =>
        type.authMethods.find((m) => m.authKind === kind) ??
        create(connectors.ConnectorAuthMethodSchema, {
          authKind: kind,
          label: kind === "oauth" ? "Sign in with OAuth" : "Token or secret headers",
        }),
    ),
  );

  const method = $derived(methods.find((m) => m.authKind === authKind) ?? methods[0]!);

  const ready = $derived(
    Boolean(name.trim() && endpoint) &&
      (authKind === "oauth" ? !method.oauthAppRequired || appSaved : !method.tokenRequired || Boolean(token.trim())),
  );

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
        const response = objectOf(await requestJson("POST", `/api/connectors/${saved.id}/oauth`, { scope }, 65000));

        window.location.assign(str(response["authorizationUrl"]));
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
    {#if methods.length > 1}<AuthMethodPicker {methods} bind:value={authKind} disabled={busy} />{/if}
    {#key method.authKind}
      <div in:rise>
        <SetupSteps
          {method}
          documentationUrl={type.documentationUrl}
          name={type.name}
          description={methods.length === 1}
        />
      </div>
    {/key}
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
    {#if authKind === "headers"}
      <TokenFields {method} bind:token bind:headers={headerText} disabled={busy} />
    {:else}
      <OAuthFields type={type.id} {method} {callback} bind:scope bind:appSaved disabled={busy} />
    {/if}
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <DialogActions
      ><Button disabled={busy} onclick={() => (open = false)}>Cancel</Button><Button
        type="submit"
        variant="primary"
        loading={busy}
        disabled={!ready}
      >
        {authKind === "oauth" ? "Continue to sign in" : "Connect account"}</Button
      ></DialogActions
    >
  </form>
</Dialog>

<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import SecretValue from "#lib/features/providers/SecretValue.svelte";
  import type { KeyAction } from "#lib/features/providers/instances.ts";
  import ProxyMappings from "./ProxyMappings.svelte";
  import { proxyCall, proxyKinds } from "./proxies.ts";

  let {
    proxy,
    onsaved,
    oncancel,
    class: className,
  }: {
    proxy?: ui.Proxy | undefined;
    onsaved: (proxy: ui.Proxy) => void;
    oncancel: () => void;
    class?: ClassValue;
  } = $props();

  let name = $state(untrack(() => proxy?.name ?? ""));
  let kind = $state(untrack(() => proxy?.kind ?? "cliproxyapi"));
  let baseUrl = $state(untrack(() => proxy?.baseUrl ?? ""));
  let secret = $state("");
  let action = $state<KeyAction>(untrack(() => (proxy?.secretSet ? "keep" : "replace")));
  let managementKey = $state("");
  let managementAction = $state<KeyAction>(untrack(() => (proxy?.managementKeySet ? "keep" : "replace")));
  let websockets = $state(untrack(() => proxy?.codex?.supportsWebsockets ?? false));

  let headers = $state(
    untrack(() =>
      Object.entries(proxy?.codex?.extraHeaders ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n"),
    ),
  );

  let busy = $state(false);
  let failure = $state<string>();

  /** Omitted keeps the stored key; empty removes it (also when the kind has no management API). */
  function managementChange(): { managementKey?: string } {
    if (kind !== "cliproxyapi" || managementAction === "clear")
      return proxy?.managementKeySet ? { managementKey: "" } : {};

    return managementAction === "replace" && managementKey ? { managementKey } : {};
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    event.stopPropagation();
    failure = undefined;
    const extraHeaders: Record<string, string> = {};

    for (const line of headers.split("\n").filter((line) => line.trim())) {
      const colon = line.indexOf(":");

      if (colon < 1) return void (failure = "Enter extra headers as Name: value, one per line.");
      extraHeaders[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }

    busy = true;

    try {
      const saved = await proxyCall("save", {
        id: proxy?.id ?? "",
        name,
        kind,
        baseUrl,
        ...(action === "replace" && { secret }),
        ...managementChange(),
        expectedRevision: proxy?.revision ?? 0n,
        codex: { wireApi: "responses", supportsWebsockets: websockets, extraHeaders },
      });

      secret = "";
      managementKey = "";

      if (saved.proxy) onsaved(saved.proxy);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }
</script>

<form class={["grid min-w-0 gap-5", className]} onsubmit={save}>
  <div class="grid items-start gap-4 sm:grid-cols-2">
    <Field label="Name"
      ><Input name="proxy-name" bind:value={name} required maxlength={80} placeholder="Team proxy" /></Field
    >
    <Field label="Kind" description={proxyKinds.find((k) => k.value === kind)?.compatibility}
      ><Select
        name="proxy-kind"
        options={proxyKinds}
        bind:value={
          () => kind,
          (value) => {
            kind = value;
            websockets = false;
          }
        }
      /></Field
    >
  </div>
  <Field
    label="Base URL"
    description="The address of your proxy, with or without /v1. Canopy adds the right path for each agent."
  >
    <Input
      name="proxy-url"
      bind:value={baseUrl}
      required
      placeholder="https://proxy.example"
      autocomplete="off"
      inputmode="url"
      spellcheck="false"
    />
  </Field>
  <Field label="Secret" description="Encrypted in the gateway. Saved values are never shown again.">
    <SecretValue set={proxy?.secretSet ?? false} bind:action bind:value={secret} name="proxy-secret" />
  </Field>
  {#if kind === "cliproxyapi"}
    <Field
      label="Management key"
      description="Optional. Lets Canopy show the proxy's accounts and their status. Encrypted in the gateway."
    >
      <SecretValue
        set={proxy?.managementKeySet ?? false}
        bind:action={managementAction}
        bind:value={managementKey}
        name="proxy-management-key"
        allowClear
      />
    </Field>
  {/if}
  {#if kind !== "anthropic"}
    <Disclosure>
      {#snippet summary()}Advanced: Codex transport{/snippet}
      <div class="grid gap-4 pt-4">
        <Field label="Wire API" description="The installed Codex adapter uses the Responses API."
          ><Input value="responses" readonly /></Field
        >
        <Checkbox
          name="proxy-websockets"
          bind:checked={websockets}
          label="Supports WebSockets"
          description="Use HTTP streaming unless the proxy supports Codex WebSocket interruptions."
        />
        <Field
          label="Extra headers"
          description="Public routing metadata only, one Name: value per line. Credentials belong in Secret."
        >
          <Textarea name="proxy-headers" bind:value={headers} rows={3} />
        </Field>
      </div>
    </Disclosure>
  {/if}
  <Disclosure>
    {#snippet summary()}Advanced: how agents use this proxy{/snippet}
    <ProxyMappings {kind} {baseUrl} class="pt-4" />
  </Disclosure>
  {#if failure}<Alert tone="error">{failure}</Alert>{/if}
  <div class="flex flex-wrap justify-end gap-2">
    <Button variant="ghost" onclick={oncancel}>Cancel</Button>
    <Button type="submit" variant="primary" loading={busy}>{proxy ? "Save proxy" : "Add proxy"}</Button>
  </div>
</form>

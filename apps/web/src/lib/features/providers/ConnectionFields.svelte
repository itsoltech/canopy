<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { Provider, ProviderProfileKind } from "@canopy/contracts";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Fieldset from "#lib/shared/ui/Fieldset.svelte";
  import GrowIn from "#lib/shared/ui/GrowIn.svelte";
  import ChoiceCard from "#lib/shared/ui/ChoiceCard.svelte";
  import ProxyPicker from "#lib/features/proxies/ProxyPicker.svelte";

  /**
   * How an instance reaches its models: the harness's own login (the device's, or its own for Codex, signed in from
   * the app) or an Anthropic/OpenAI-compatible endpoint (CLIProxyAPI) with a key. `kindLocked`: the built-in device
   * login, or an instance threads use, keeps its kind.
   */
  let {
    harness,
    kind = $bindable(),
    proxyId = $bindable(""),
    ownLogin = $bindable(false),
    kindLocked = false,
    errors,
    prefix,
    class: className,
  }: {
    harness: Provider;
    kind: ProviderProfileKind;
    proxyId: string;
    ownLogin: boolean;
    kindLocked?: boolean;
    errors: { proxyId?: string | undefined };
    prefix: string;
    class?: ClassValue;
  } = $props();

  const endpoint = $derived(kind === ProviderProfileKind.CLIPROXYAPI);

  const options = $derived([
    {
      value: ProviderProfileKind.CLIPROXYAPI,
      label: "Proxy",
      description: "A saved CLIProxyAPI or compatible connection. Manage connections in Settings → Proxies.",
    },
    {
      value: ProviderProfileKind.NATIVE,
      label: "Device login",
      description:
        harness === Provider.GROK
          ? "Grok CLI's login on the device (grok login), or XAI_API_KEY in its variables."
          : harness === Provider.CODEX
            ? "Codex's own login: the device's, or sign in with ChatGPT from here."
            : "Claude Code's login on the device (or a key in its variables).",
    },
  ]);
</script>

<div class={["grid gap-4", className]}>
  <Fieldset legend="Connection" disabled={kindLocked}>
    {#each options as option (option.value)}
      <ChoiceCard
        name="{prefix}-kind"
        checked={kind === option.value}
        title={option.label}
        description={option.description}
        disabled={kindLocked}
        onchange={() => (kind = option.value)}
      />
    {/each}
  </Fieldset>
  {#if endpoint}
    <GrowIn class="grid gap-4">
      <ProxyPicker {harness} bind:value={proxyId} error={errors.proxyId} />
    </GrowIn>
  {:else if harness === Provider.CODEX}
    <GrowIn>
      <Checkbox
        name="{prefix}-own-login"
        label="Own login (sign in with ChatGPT)"
        description="Keeps a login of its own in its shadow home instead of the device's; sign in from the instance once it runs on a worker."
        bind:checked={ownLogin}
      />
    </GrowIn>
  {/if}
</div>

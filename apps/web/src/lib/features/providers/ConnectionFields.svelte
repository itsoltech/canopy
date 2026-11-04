<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { Provider, ProviderProfileKind } from "@canopy/contracts";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import Fieldset from "#lib/shared/ui/Fieldset.svelte";
  import GrowIn from "#lib/shared/ui/GrowIn.svelte";
  import ChoiceCard from "#lib/shared/ui/ChoiceCard.svelte";
  import ProxyPicker from "#lib/features/proxies/ProxyPicker.svelte";

  /**
   * How an instance reaches its models: the harness's own login (the device's, or its own for Codex, signed in from
   * the app) or an Anthropic/OpenAI-compatible endpoint (CLIProxyAPI) with a key.
   */
  let {
    harness,
    kind = $bindable(),
    proxyId = $bindable(""),
    ownLogin = $bindable(false),
    errors,
    prefix,
    class: className,
  }: {
    harness: Provider;
    kind: ProviderProfileKind;
    proxyId: string;
    ownLogin: boolean;
    errors: { proxyId?: string | undefined };
    prefix: string;
    class?: ClassValue;
  } = $props();

  const endpoint = $derived(kind === ProviderProfileKind.CLIPROXYAPI);

  const options = $derived([
    {
      value: ProviderProfileKind.CLIPROXYAPI,
      label: "Proxy",
      description: "A saved compatible connection.",
    },
    {
      value: ProviderProfileKind.NATIVE,
      label: "Device login",
      description:
        harness === Provider.GROK
          ? "Grok CLI's login on the device (grok login), or XAI_API_KEY in its variables."
          : harness === Provider.CODEX
            ? "Use the device's login or sign in here."
            : "Claude Code's login on the device (or a key in its variables).",
    },
  ]);
</script>

<div class={["grid gap-3", className]}>
  <Fieldset legend="Connection">
    <div class="grid gap-2 sm:grid-cols-2">
      {#each options as option (option.value)}
        <ChoiceCard
          name="{prefix}-kind"
          checked={kind === option.value}
          title={option.label}
          description={option.description}
          onchange={() => (kind = option.value)}
        />
      {/each}
    </div>
  </Fieldset>
  {#if endpoint}
    <GrowIn class="grid gap-4">
      <ProxyPicker {harness} bind:value={proxyId} error={errors.proxyId} />
    </GrowIn>
  {:else if harness === Provider.CODEX}
    <GrowIn>
      <SettingsRow
        title="Own login"
        description="Sign in with ChatGPT in a separate session home. Changing this home may start fresh sessions."
      >
        {#snippet control()}<Switch
            name="{prefix}-own-login"
            label="Own login (sign in with ChatGPT)"
            bind:checked={ownLogin}
          />{/snippet}
      </SettingsRow>
    </GrowIn>
  {/if}
</div>

<script lang="ts">
  import { Provider, ProviderProfileKind } from "@open-agents/contracts";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Fieldset from "#lib/shared/ui/Fieldset.svelte";
  import GrowIn from "#lib/shared/ui/GrowIn.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Radio from "#lib/shared/ui/Radio.svelte";
  import type { KeyAction } from "./instances.ts";
  import SecretValue from "./SecretValue.svelte";

  /**
   * How an instance reaches its models: the harness's own login (the device's, or its own for Codex, signed in from
   * the app) or an Anthropic/OpenAI-compatible endpoint (CLIProxyAPI) with a key. `kindLocked`: the built-in device
   * login, or an instance threads use, keeps its kind.
   */
  let {
    harness,
    kind = $bindable(),
    baseUrl = $bindable(""),
    apiKeySet,
    keyAction = $bindable(),
    apiKey = $bindable(""),
    ownLogin = $bindable(false),
    kindLocked = false,
    errors,
    prefix,
  }: {
    harness: Provider;
    kind: ProviderProfileKind;
    baseUrl: string;
    apiKeySet: boolean;
    keyAction: KeyAction;
    apiKey: string;
    ownLogin: boolean;
    kindLocked?: boolean;
    errors: { baseUrl?: string | undefined; apiKey?: string | undefined };
    prefix: string;
  } = $props();

  const endpoint = $derived(kind === ProviderProfileKind.CLIPROXYAPI);
  const options = $derived([
    { value: ProviderProfileKind.CLIPROXYAPI, label: "API endpoint", description: "An Anthropic/OpenAI-compatible URL with a key, e.g. CLIProxyAPI." },
    {
      value: ProviderProfileKind.NATIVE,
      label: "Device login",
      description: harness === Provider.CODEX ? "Codex's own login: the device's, or sign in with ChatGPT from here." : "Claude Code's login on the device (or a key in its variables).",
    },
  ]);
</script>

<div class="grid gap-4">
  <Fieldset legend="Connection" disabled={kindLocked}>
    {#each options as option (option.value)}
      <label class="flex gap-3 rounded-xl p-3 ring-1 ring-zinc-950/10 has-checked:bg-brand-50/50 has-checked:ring-brand-600/40 dark:ring-white/10 dark:has-checked:bg-brand-500/10 dark:has-checked:ring-brand-500/40">
        <span class="flex h-lh items-center text-base/6 sm:text-sm/6"><Radio name="{prefix}-kind" value={option.value} checked={kind === option.value} onchange={() => (kind = option.value)} /></span>
        <span class="min-w-0 text-base/6 sm:text-sm/6">
          <span class="font-medium text-zinc-950 dark:text-white">{option.label}</span>
          <span class="block text-pretty text-zinc-500 dark:text-zinc-400">{option.description}</span>
        </span>
      </label>
    {/each}
  </Fieldset>
  {#if endpoint}
    <GrowIn class="grid gap-4">
      <Field label="Endpoint URL" error={errors.baseUrl}>
        <Input name="{prefix}-url" bind:value={baseUrl} placeholder="http://127.0.0.1:8317" autocomplete="off" spellcheck="false" inputmode="url" class="font-mono" />
      </Field>
      <Field label="API key" error={errors.apiKey}>
        <SecretValue set={apiKeySet} bind:action={keyAction} bind:value={apiKey} name="{prefix}-key" placeholder="Key" allowClear />
      </Field>
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

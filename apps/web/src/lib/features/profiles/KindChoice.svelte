<script lang="ts">
  import { ProviderProfileKind } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import Radio from "#lib/shared/ui/Radio.svelte";

  /** How a profile connects: the device's own CLI login, or an API endpoint with a key. Native radios as cards. */
  let { value = $bindable(), class: className }: { value: ProviderProfileKind; class?: ClassValue } = $props();
  const id = $props.id();
  const options: { kind: ProviderProfileKind; label: string; description: string }[] = [
    { kind: ProviderProfileKind.CLIPROXYAPI, label: "API endpoint", description: "An Anthropic/OpenAI-compatible URL with a key, e.g. CLIProxyAPI." },
    { kind: ProviderProfileKind.NATIVE, label: "Device login", description: "The CLI login on the worker, with your own variables." },
  ];
</script>

<div role="radiogroup" aria-label="Connection" class={["grid gap-2 sm:grid-cols-2", className]}>
  {#each options as option (option.kind)}
    <label
      for="{id}-{option.kind}"
      class="relative flex gap-3 rounded-xl p-3 ring-1 ring-zinc-950/10 has-checked:bg-brand-500/5 has-checked:ring-2 has-checked:ring-brand-600 has-disabled:opacity-60 dark:ring-white/10 dark:has-checked:bg-brand-500/10 dark:has-checked:ring-brand-500"
    >
      <span class="flex h-lh shrink-0 items-center text-base/6 sm:text-sm/6">
        <Radio id="{id}-{option.kind}" name="kind" value={option.kind} checked={value === option.kind} onchange={() => (value = option.kind)} />
      </span>
      <span class="grid min-w-0 gap-0.5">
        <span class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">{option.label}</span>
        <span class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">{option.description}</span>
      </span>
    </label>
  {/each}
</div>

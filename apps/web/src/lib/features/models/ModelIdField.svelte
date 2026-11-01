<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import type { ProviderKey } from "#lib/features/threads/providers.ts";
  import Combobox from "#lib/shared/ui/Combobox.svelte";
  import { nameOfModel, suggestedModels } from "./catalog.ts";
  import { useModelCatalog } from "./model-catalog.svelte.ts";

  /**
   * Model id as free text with suggestions for the provider (your workers' catalogs, aliases and models
   * used before): a combobox for forms and settings rows. Empty = the profile's default model. Inside a `Field` it takes its id.
   */
  let {
    provider,
    value = "",
    name = "model",
    label,
    placeholder = "Profile default",
    onchange,
    class: className,
  }: {
    provider: ProviderKey;
    value?: string;
    name?: string;
    label: string;
    placeholder?: string;
    onchange?: ((model: string) => void) | undefined;
    class?: ClassValue;
  } = $props();

  const overview = useOverview();
  const catalog = useModelCatalog();
  const models = $derived(suggestedModels(provider, overview.threads.values(), catalog.workers.values()));
  const nameOf = (model: string) => nameOfModel(model, catalog.workers.values());
</script>

<Combobox
  items={models}
  key={(m) => m}
  text={(m) => m}
  filter={(m, q) => m.toLowerCase().includes(q.toLowerCase()) || nameOf(m).toLowerCase().includes(q.toLowerCase())}
  query={value}
  value={value || undefined}
  {name}
  {label}
  {placeholder}
  onchange={(text) => onchange?.(text.trim())}
  class={className}
>
  {#snippet option(model, state)}
    {@const name = nameOf(model)}
    <span class="flex items-center gap-2">
      <span class="min-w-0 flex-1 truncate">{name}</span>
      {#if name !== model}<span class="shrink-0 font-mono text-xs text-zinc-500 dark:text-zinc-400">{model}</span>{/if}
      {#if state.selected}<span class="sr-only">(current)</span>{/if}
    </span>
  {/snippet}
  {#snippet empty()}Type any model id{/snippet}
</Combobox>

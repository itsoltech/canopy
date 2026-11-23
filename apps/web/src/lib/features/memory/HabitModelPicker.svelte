<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import type { ProviderKey } from "#lib/features/threads/providers.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import SearchPicker from "#lib/shared/ui/SearchPicker.svelte";

  let {
    models,
    value,
    provider,
    open = $bindable(false),
    disabled,
    onchange,
  }: {
    models: ReadonlyMap<string, ui.MemoryReflectionModel>;
    value: string;
    provider: ProviderKey | undefined;
    open?: boolean;
    disabled: boolean;
    onchange: (value: string) => void;
  } = $props();

  const auto = { id: "", label: "Auto", detail: "Use a small model from this profile." };

  const choices = $derived([
    auto,
    ...[...models.values()].map(({ model, label }) => ({
      id: model,
      label: label || model,
      detail: label && label !== model ? model : "",
    })),
  ]);

  const summary = $derived(choices.find((item) => item.id === value)?.label ?? value);
</script>

<div class="max-w-48 min-w-0 shrink">
  <SearchPicker
    bind:open
    label="Model"
    searchLabel="Search models"
    placeholder="Search models"
    items={choices}
    key={(item) => item.id}
    text={(item) => `${item.label} ${item.id}`}
    {value}
    onselect={(item) => onchange(item.id)}
  >
    {#snippet trigger(props)}
      <PillButton {...props} {disabled} class="max-w-full pl-1.5 disabled:opacity-50" aria-label={`Model: ${summary}`}>
        {#if provider}<ProviderIcon {provider} size="sm" />{/if}
        <span class="truncate text-zinc-800 dark:text-zinc-200">{summary}</span>
      </PillButton>
    {/snippet}
    {#snippet option(item, { selected })}
      <div class="flex min-h-6 items-center gap-2 sm:min-h-5 pointer-coarse:min-h-8">
        <div class="min-w-0 flex-1 wrap-anywhere">
          <div class="font-medium">{item.label}</div>
          {#if item.detail}<div class="text-sm/5 text-muted sm:text-xs/4">{item.detail}</div>{/if}
        </div>
        <Icon name="check" class={["text-brand-600 dark:text-brand-400", !selected && "invisible"]} />
      </div>
    {/snippet}
    {#snippet empty()}No models found{/snippet}
  </SearchPicker>
</div>

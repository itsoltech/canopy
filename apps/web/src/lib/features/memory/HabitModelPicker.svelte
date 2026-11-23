<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import SearchPicker from "#lib/shared/ui/SearchPicker.svelte";

  let {
    models,
    value,
    disabled,
    onchange,
  }: {
    models: ReadonlyMap<string, ui.MemoryReflectionModel>;
    value: string;
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
  let open = $state(false);

  $effect(() => {
    if (disabled) open = false;
  });
</script>

<div class="w-64 max-w-full">
  <SearchPicker
    bind:open
    label="Model"
    searchLabel="Search models"
    placeholder="Search models"
    placement="bottom-end"
    items={choices}
    key={(item) => item.id}
    text={(item) => `${item.label} ${item.id}`}
    {value}
    onselect={(item) => onchange(item.id)}
  >
    {#snippet trigger(props)}
      <Button {...props} {disabled} class="w-full" aria-label={`Model: ${summary}`}>
        <span class="min-w-0 flex-1 text-left wrap-anywhere whitespace-normal">{summary}</span>
        <Icon name="chevron-up-down" />
      </Button>
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

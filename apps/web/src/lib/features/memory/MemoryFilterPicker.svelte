<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import PickerRow from "#lib/shared/ui/PickerRow.svelte";
  import PickerTrigger from "#lib/shared/ui/PickerTrigger.svelte";
  import SearchPicker from "#lib/shared/ui/SearchPicker.svelte";

  let {
    label,
    allLabel,
    searchLabel,
    options,
    value,
    onchange,
  }: {
    label: string;
    allLabel: string;
    searchLabel: string;
    options: readonly ui.MemoryFilterOption[];
    value: string;
    onchange: (id: string) => void;
  } = $props();

  const items = $derived([{ id: "", label: allLabel }, ...options]);
  const text = $derived(items.find((item) => item.id === value)?.label ?? `${label} ${value.slice(0, 8)}`);
</script>

<SearchPicker
  {label}
  {searchLabel}
  placeholder={searchLabel}
  {items}
  key={(item) => item.id}
  text={(item) => item.label}
  {value}
  onselect={(item) => onchange(item.id)}
>
  {#snippet trigger(props)}
    <PickerTrigger {...props} icon="chevron-up-down" title={text} aria-label={`${label} — ${text}`} {text} />
  {/snippet}
  {#snippet option(item, { selected })}
    <PickerRow title={item.label} {selected} />
  {/snippet}
</SearchPicker>

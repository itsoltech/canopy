<script lang="ts" generics="T extends string">
  import type { ClassValue } from "svelte/elements";
  import { segmentedItem, segmentedTrack } from "#lib/shared/ui/segmented.ts";

  /** Gallery switch between a few values (buttons with aria-pressed). */
  let {
    options,
    value = $bindable(),
    label,
    class: className,
  }: { options: readonly { value: T; label: string }[]; value: T; label: string; class?: ClassValue } = $props();
</script>

<div role="group" aria-label={label} class={["inline-flex", segmentedTrack, className]}>
  {#each options as option (option.value)}
    <button
      type="button"
      aria-pressed={value === option.value}
      data-active={value === option.value || undefined}
      class={segmentedItem}
      onclick={() => (value = option.value)}
    >
      {option.label}
    </button>
  {/each}
</div>

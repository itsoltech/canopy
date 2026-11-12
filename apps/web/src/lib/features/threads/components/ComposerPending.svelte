<script lang="ts">
  import type { ComposerPendingItem } from "@canopy/domain/composer-pending";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

  let {
    items,
    onexpand,
    class: className,
  }: { items: readonly ComposerPendingItem[]; onexpand: () => void; class?: ClassValue } = $props();
</script>

<div
  class={["flex h-6 max-w-2/3 min-w-0 shrink-0 [scrollbar-width:none] items-center gap-1 overflow-x-auto", className]}
>
  {#each items as item (item.key)}
    <button
      type="button"
      class="flex h-6 shrink-0 items-center gap-1 rounded-md bg-brand-600/8 pr-1.5 pl-1 text-xs/4 text-brand-700 tabular-nums focus-ring hover:bg-brand-600/15 dark:bg-brand-400/12 dark:text-brand-300 dark:hover:bg-brand-400/20"
      aria-label={item.label}
      {@attach tooltip(item.label)}
      onfocus={onexpand}
      onpointerdown={(event) => {
        event.preventDefault();
        onexpand();
      }}
      onclick={onexpand}
    >
      <Icon name={item.icon} tone="inherit" class="size-3.5 shrink-0" />
      {item.count.toLocaleString()}
    </button>
  {/each}
</div>

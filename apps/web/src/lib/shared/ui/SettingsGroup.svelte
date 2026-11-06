<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import SettingsCard from "./SettingsCard.svelte";

  /**
   * Titled group of settings rows on one card; `actions` sit right of the title. `cards`: the items are cards
   * of their own (workers), stacked with a gap instead of rows on one card.
   */
  let {
    title,
    description,
    cards = false,
    class: className,
    actions,
    children,
  }: {
    title?: string;
    description?: string | undefined;
    cards?: boolean;
    class?: ClassValue;
    actions?: Snippet;
    children: Snippet;
  } = $props();

  const id = $props.id();
</script>

<section class={className} aria-labelledby={title ? id : undefined}>
  {#if title || actions}
    <div class="settings-group-header mb-3 flex flex-wrap items-end justify-between gap-2 px-1">
      <div class="min-w-0">
        {#if title}<h2 {id} class="text-base/7 font-semibold text-zinc-950 dark:text-white">{title}</h2>{/if}
        {#if description}<p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
            {description}
          </p>{/if}
      </div>
      {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
    </div>
  {/if}
  {#if cards}<div class="grid grid-cols-1 gap-3">{@render children()}</div>
  {:else}<SettingsCard class="divide-y divide-zinc-950/5 dark:divide-white/8">{@render children()}</SettingsCard>{/if}
</section>

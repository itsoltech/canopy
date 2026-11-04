<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";

  /** A short titled list in a move preview: what moves along, what to do again, what stays. Empty renders nothing. */
  let {
    title,
    items,
    icon = "check",
    class: className,
  }: { title: string; items: readonly string[]; icon?: IconName; class?: ClassValue } = $props();
</script>

{#if items.length}
  <div class={["grid min-w-0 grid-cols-1 gap-1", className]}>
    <p class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">{title}</p>
    <ul role="list" class="grid gap-1">
      {#each items as item (item)}
        <li class="flex min-w-0 gap-2 text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
          <span class="flex h-lh shrink-0 items-center"
            ><Icon name={icon} class="size-4 text-zinc-400 dark:text-zinc-500" /></span
          >
          <span class="min-w-0 text-pretty">{item}</span>
        </li>
      {/each}
    </ul>
  </div>
{/if}

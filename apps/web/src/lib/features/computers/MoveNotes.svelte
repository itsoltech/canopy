<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** A short titled list in a move preview: what moves along, what to do again, what stays. Empty renders nothing. */
  let { title, items, class: className }: { title: string; items: readonly string[]; class?: ClassValue } = $props();
</script>

{#if items.length}
  <div class={["grid min-w-0 grid-cols-1 gap-1", className]}>
    <p class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">{title}</p>
    <ul role="list" class="grid gap-1">
      {#each items as item (item)}
        <li class="min-w-0 text-base/6 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
          {item}
        </li>
      {/each}
    </ul>
  </div>
{/if}

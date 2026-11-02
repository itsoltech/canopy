<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** Where the palette is: the open submenu's title, after its parent's when nested deeper. */
  let { titles, class: className }: { titles: readonly string[]; class?: ClassValue } = $props();
  const parent = $derived(titles.length > 1 ? titles.at(-2) : undefined);
</script>

<span
  class={[
    "flex min-w-0 shrink items-center gap-1 rounded-md bg-zinc-950/5 py-0.5 pr-2 pl-1.5 text-sm/5 font-medium text-zinc-700 sm:text-xs/5 dark:bg-white/8 dark:text-zinc-300",
    className,
  ]}
>
  {#if parent}<span class="truncate text-zinc-500 dark:text-zinc-400">{parent}{" ›"}</span>{/if}
  <span class="truncate">{titles.at(-1)}</span>
</span>

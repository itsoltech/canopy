<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** A bounded label column; long content gets the whole card width. */
  let {
    label,
    stacked = false,
    children,
    class: className,
  }: {
    label: string;
    stacked?: boolean;
    children: Snippet;
    class?: ClassValue;
  } = $props();
</script>

<div class={["grid min-w-0 gap-x-3 gap-y-1", !stacked && "grid-cols-[minmax(0,7rem)_minmax(0,1fr)]", className]}>
  <dt class="min-w-0 font-medium wrap-anywhere text-zinc-900 dark:text-zinc-100">{label}</dt>
  <dd class="min-w-0 wrap-anywhere text-zinc-700 select-text dark:text-zinc-300">{@render children()}</dd>
</div>

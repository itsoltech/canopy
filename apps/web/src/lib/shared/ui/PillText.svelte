<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** Read-only text in a row of pills (where a `PillButton` would be when there is nothing to choose). */
  let { class: className, children }: { class?: ClassValue; children: Snippet } = $props();
</script>

<span
  class={[
    "min-w-0 truncate px-2 text-sm/5 text-zinc-500 select-none sm:text-(length:--type-compact)/5 dark:text-zinc-400",
    className,
  ]}>{@render children()}</span
>

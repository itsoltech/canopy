<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import TruncatedText from "./TruncatedText.svelte";

  /** Label of a menu row with an optional description under it (rows of `MenuItem`, `MenuCheckItem`). */
  let {
    description,
    class: className,
    children,
  }: { description?: string | undefined; class?: ClassValue; children: Snippet } = $props();
</script>

<span class={["grid min-w-0 flex-1", className]}>
  <TruncatedText>{@render children()}</TruncatedText>
  {#if description}<span class="text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">{description}</span>{/if}
</span>

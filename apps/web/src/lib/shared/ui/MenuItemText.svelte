<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import TruncatedText from "./TruncatedText.svelte";

  /** Label of a menu row with an optional description under it (rows of `MenuItem`, `MenuCheckItem`). */
  let {
    description,
    wrapLabel = false,
    class: className,
    children,
  }: { description?: string | undefined; wrapLabel?: boolean; class?: ClassValue; children: Snippet } = $props();
</script>

<span class={["grid min-w-0 flex-1", className]}>
  {#if wrapLabel}
    <span class="line-clamp-3 wrap-anywhere">{@render children()}</span>
  {:else}
    <TruncatedText>{@render children()}</TruncatedText>
  {/if}
  {#if description}<span class="text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">{description}</span>{/if}
</span>

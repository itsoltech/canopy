<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /**
   * A line of small secondary text with a quiet button that shows or hides more of what is above or below
   * it ("Show all 120 lines", "Show raw"); `note` says what is shown now ("First 24 of 120 lines") on the left.
   * `expanded` is the button's state for assistive tech. Chrome, so a selection here is never quoted (Cite).
   */
  let {
    expanded,
    onclick,
    note,
    class: className,
    children,
  }: { expanded: boolean; onclick: () => void; note?: string | undefined; class?: ClassValue; children: Snippet } = $props();
</script>

<div data-quote-skip class={["flex items-center justify-between gap-3 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400", className]}>
  {#if note}<p class="tabular-nums">{note}</p>{/if}
  <button type="button" class="rounded-md font-medium text-zinc-700 hover:text-zinc-950 focus-ring dark:text-zinc-300 dark:hover:text-white" aria-expanded={expanded} {onclick}>{@render children()}</button>
</div>

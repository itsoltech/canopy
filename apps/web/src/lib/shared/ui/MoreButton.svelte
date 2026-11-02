<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /**
   * A quiet text button that shows or hides more of something next to it ("Show all 120 lines",
   * "Show raw"): `expanded` is its state for assistive tech. Sits in a line of small secondary text.
   */
  let { expanded, onclick, class: className, children }: { expanded: boolean; onclick: () => void; class?: ClassValue; children: Snippet } = $props();
</script>

<button
  type="button"
  class={["rounded-md font-medium text-zinc-700 hover:text-zinc-950 focus-ring dark:text-zinc-300 dark:hover:text-white", className]}
  aria-expanded={expanded}
  {onclick}>{@render children()}</button
>

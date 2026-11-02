<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** A list of rows on a light ring with hairline dividers (instances, workers, models); rows go in as `<li>`. */
  let { label, class: className, children }: { label?: string; class?: ClassValue; children: Snippet } = $props();
</script>

<ul role="list" aria-label={label} class={["divide-y divide-zinc-950/5 overflow-hidden rounded-xl ring-1 ring-zinc-950/10 dark:divide-white/8 dark:ring-white/10", className]}>
  {@render children()}
</ul>

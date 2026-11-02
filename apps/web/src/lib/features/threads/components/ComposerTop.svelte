<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  /** One overlap, shared by the queue, questions and future status strips. Panels themselves never offset each other. */
  let { children, class: className }: { children: Snippet; class?: ClassValue } = $props();
</script>

<div data-composer-panels class={["grid grid-cols-1 rounded-t-2xl bg-white pb-4 ring-1 ring-zinc-950/10 divide-y divide-zinc-950/10 dark:bg-zinc-950 dark:ring-white/10 dark:divide-white/10", className]}>
  {@render children()}
</div>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  let { label, children, class: className }: { label: string; children: Snippet; class?: ClassValue } = $props();
</script>

<div
  role="group"
  aria-label={label}
  class={[
    "inline-flex w-fit max-w-full items-stretch divide-x divide-zinc-950/10 rounded-md bg-white ring-1 ring-zinc-950/10 dark:divide-white/10 dark:bg-white/5 dark:ring-white/10",
    "[&>button]:rounded-none [&>button:first-child]:rounded-l-md [&>button:last-child]:rounded-r-md",
    className,
  ]}
>
  {@render children()}
</div>

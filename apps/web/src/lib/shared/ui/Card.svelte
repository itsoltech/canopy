<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** Bordered surface for standalone or interactive content. Padding is the caller's choice. */
  let { as = "div", class: className, children, ...rest }: { as?: "div" | "section" | "article" | "li"; class?: ClassValue; children: Snippet; [key: `aria-${string}`]: string | undefined } = $props();
</script>

<svelte:element this={as} class={["rounded-xl bg-white ring-1 ring-zinc-950/10 dark:bg-zinc-900 dark:ring-white/10", className]} {...rest}>
  {@render children()}
</svelte:element>

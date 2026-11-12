<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { prefersReducedMotion } from "svelte/motion";
  import { expand, rise } from "./motion.ts";

  /**
   * Content that grows in when it appears and shrinks out when it goes (accordion, motion.ts `expand`),
   * so what is below or above it moves smoothly instead of jumping. Put it inside the `{#if}`; spacing
   * that should grow with it belongs in `class` (padding), not in a parent's gap.
   */
  let {
    class: className,
    children,
    overlay = false,
  }: { class?: ClassValue; children: Snippet; overlay?: boolean } = $props();

  const transition = (node: HTMLElement) =>
    overlay ? rise(node, { instant: prefersReducedMotion.current }) : expand(node);
</script>

<div class={className} transition:transition>{@render children()}</div>

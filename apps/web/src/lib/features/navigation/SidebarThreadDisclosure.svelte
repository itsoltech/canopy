<script lang="ts">
  import type { Snippet } from "svelte";
  import { prefersReducedMotion } from "svelte/motion";
  import type { TransitionConfig } from "svelte/transition";
  import Button from "#lib/shared/ui/Button.svelte";
  import { duration, inOut } from "#lib/shared/ui/motion.ts";

  let {
    label,
    working = false,
    expanded,
    ontoggle,
    children,
  }: {
    label: string;
    working?: boolean;
    expanded: boolean;
    ontoggle: () => void;
    children: Snippet;
  } = $props();

  const id = $props.id();

  // Clip the grid itself so the list keeps its natural height while the track opens or closes.
  function expandSection(_node: HTMLElement): TransitionConfig {
    if (prefersReducedMotion.current) return { duration: 0 };

    return {
      duration: duration("fast"),
      easing: inOut,
      css: (t) => `grid-template-rows: ${t}fr; overflow-x: visible; overflow-y: clip; opacity: ${t}`,
    };
  }
</script>

<h2 class:working>
  <Button
    class="w-full"
    size="sm"
    variant="ghost"
    icon="chevron-right"
    aria-expanded={expanded}
    aria-controls={id}
    onclick={ontoggle}
  >
    {label}
    <span aria-hidden="true" class="ms-1 h-px flex-1 bg-current opacity-25"></span>
  </Button>
</h2>
<div {id}>
  {#if expanded}
    <div
      class="grid min-w-0 grid-rows-[1fr]"
      transition:expandSection
      onoutrostart={(event) => (event.currentTarget.inert = true)}
      onintrostart={(event) => (event.currentTarget.inert = false)}
    >
      <div class="min-h-0 min-w-0">
        <div class="pt-0.5">{@render children()}</div>
      </div>
    </div>
  {/if}
</div>

<style>
  .working :global(button) {
    color: color-mix(in oklab, light-dark(var(--theme-sky-700), var(--theme-sky-400)) 60%, var(--theme-muted));
    --icon-color: currentColor;
  }

  h2 :global(button > svg:first-child) {
    transition: rotate var(--duration-fast) var(--ease-in-out);
  }

  h2 :global(button[aria-expanded="true"] > svg:first-child) {
    rotate: 90deg;
  }

  @media (prefers-reduced-motion: reduce) {
    h2 :global(button > svg:first-child) {
      transition: none;
    }
  }
</style>

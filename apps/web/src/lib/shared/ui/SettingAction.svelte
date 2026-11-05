<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** Reserve the action's space while it is unavailable, including its height. */
  let { active, children, class: className }: { active: boolean; children: Snippet; class?: ClassValue } = $props();
</script>

<div
  class={["setting-action flex shrink-0 items-center", className]}
  data-active={active}
  inert={!active}
  aria-hidden={!active}
>
  {@render children()}
</div>

<style>
  .setting-action {
    opacity: 0;
    scale: var(--scale-medium);
    transition:
      opacity var(--duration-quick) var(--ease-smooth-out),
      scale var(--duration-quick) var(--ease-smooth-out);
  }

  .setting-action[data-active="true"] {
    opacity: 1;
    scale: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .setting-action {
      scale: none;
      transition: none;
    }
  }
</style>

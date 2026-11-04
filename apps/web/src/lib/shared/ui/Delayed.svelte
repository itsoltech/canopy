<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * Renders its content only after `ms` (a loading placeholder): a load that finishes sooner replaces an
   * empty space instead of a placeholder that flashes for a frame or two.
   */
  let { ms = 300, children }: { ms?: number; children: Snippet } = $props();
  let shown = $state(false);

  $effect(() => {
    const timer = setTimeout(() => (shown = true), ms);

    return () => clearTimeout(timer);
  });
</script>

{#if shown}{@render children()}{/if}

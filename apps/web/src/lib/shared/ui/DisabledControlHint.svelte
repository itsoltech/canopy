<script lang="ts">
  import type { Snippet } from "svelte";
  import { tooltip } from "./tooltip.ts";

  /** Disabled native buttons cannot receive focus; their wrapper exposes the reason to keyboard and touch. */
  let {
    reason,
    label = "Sending unavailable",
    children,
  }: { reason?: string | undefined; label?: string; children: Snippet } = $props();
</script>

{#if reason}
  <span
    role="button"
    tabindex="0"
    aria-disabled="true"
    aria-label={label}
    class="relative flex rounded-full focus-ring"
    {@attach tooltip(reason, { touch: "tap" })}
  >
    <span class="pointer-events-none flex" aria-hidden="true">{@render children()}</span>
  </span>
{:else}
  {@render children()}
{/if}

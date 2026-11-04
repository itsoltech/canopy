<script lang="ts">
  import type { Snippet } from "svelte";
  import { tooltip } from "./tooltip.ts";

  /** Disabled native buttons cannot receive focus; their wrapper exposes the reason to keyboard and touch. */
  let { reason, children }: { reason?: string | undefined; children: Snippet } = $props();
</script>

{#if reason}
  <span
    role="button"
    tabindex="0"
    aria-disabled="true"
    aria-label="Sending unavailable"
    class="relative flex rounded-full focus-ring"
    {@attach tooltip(reason, { touch: "tap" })}
  >
    <span class="pointer-events-none" aria-hidden="true">{@render children()}</span>
  </span>
{:else}
  {@render children()}
{/if}

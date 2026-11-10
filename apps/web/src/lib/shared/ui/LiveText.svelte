<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { runningAnimation } from "../activity.ts";

  /** A static text raster under a moving soft mask. Both sweep and counter-motion use only transforms. */
  let { text, active = true, class: className }: { text: string; active?: boolean; class?: ClassValue } = $props();
</script>

<span class={["live-text", active && "live-text-active", className]} {@attach active ? runningAnimation : undefined}>
  <span class="truncate">{text}</span>
  {#if active}
    <span class="live-text-sweep" aria-hidden="true"><span class="live-text-ink">{text}</span></span>
  {/if}
</span>

<style>
  .live-text {
    position: relative;
    display: inline-grid;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    vertical-align: bottom;
  }
  .live-text-active {
    color: var(--color-zinc-500);
  }
  :global(.dark) .live-text-active {
    color: var(--color-zinc-400);
  }
  .live-text-sweep {
    position: absolute;
    inset-block: 0;
    left: -20%;
    width: 40%;
    pointer-events: none;
    mask-image: linear-gradient(90deg, transparent, #000, transparent);
    animation: live-text-sweep var(--duration-shimmer) var(--ease-linear) infinite;
  }
  .live-text-ink {
    position: relative;
    left: 50%;
    display: block;
    width: 250%;
    overflow: hidden;
    color: var(--color-zinc-300);
    text-overflow: ellipsis;
    white-space: nowrap;
    animation: live-text-ink var(--duration-shimmer) var(--ease-linear) infinite;
  }
  :global(.dark) .live-text-ink {
    color: var(--color-zinc-100);
  }
  @keyframes live-text-sweep {
    to {
      transform: translateX(500%);
    }
  }
  @keyframes live-text-ink {
    to {
      transform: translateX(-200%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .live-text-sweep {
      display: none;
      animation: none;
    }
    .live-text-ink {
      animation: none;
    }
  }
</style>

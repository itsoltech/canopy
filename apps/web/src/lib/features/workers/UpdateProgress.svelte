<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  let { label, value, class: className }: { label: string; value?: number; class?: ClassValue } = $props();
  const percent = $derived(value === undefined ? undefined : Math.min(100, Math.max(0, Math.round(value))));
</script>

<div
  role="progressbar"
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={percent}
  class={["h-0.5 overflow-hidden rounded-full bg-brand-500/15", className]}
>
  <div
    class={["h-full rounded-full bg-brand-600 dark:bg-brand-400", percent === undefined && "update-progress-pulse"]}
    style:width={`${percent ?? 35}%`}
  ></div>
</div>

<style>
  .update-progress-pulse {
    animation: update-progress calc(var(--duration-very-slow) * 3) var(--ease-in-out) infinite;
  }
  @keyframes update-progress {
    50% {
      translate: 180% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .update-progress-pulse {
      animation: none;
    }
  }
</style>

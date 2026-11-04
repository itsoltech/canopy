<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /**
   * A thin progress ring drawn around a small control (e.g. an icon button). `value` is 0–100 and is clamped; without
   * a value the ring shows an indeterminate arc that turns (still under reduced motion).
   */
  let { label, value, class: className }: { label: string; value?: number; class?: ClassValue } = $props();

  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const percent = $derived(value === undefined ? undefined : Math.min(100, Math.max(0, Math.round(value))));
  const dash = $derived(circumference * ((percent ?? 30) / 100));
</script>

<svg
  viewBox="0 0 24 24"
  role="progressbar"
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={percent}
  class={["pointer-events-none -rotate-90", percent === undefined && "progress-ring-turn", className]}
>
  <circle cx="12" cy="12" r={radius} fill="none" stroke-width="1.5" class="stroke-brand-500/15" />
  <circle
    cx="12"
    cy="12"
    r={radius}
    fill="none"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-dasharray={`${dash} ${circumference}`}
    class="stroke-brand-600 transition-[stroke-dasharray] duration-(--duration-fast) ease-smooth-out motion-reduce:transition-none dark:stroke-brand-400"
  />
</svg>

<style>
  .progress-ring-turn {
    animation: progress-ring-turn calc(var(--duration-very-slow) * 3) linear infinite;
  }
  @keyframes progress-ring-turn {
    to {
      rotate: 270deg;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .progress-ring-turn {
      animation: none;
    }
  }
</style>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  let {
    active,
    name,
    id,
    class: className,
  }: { active: boolean; name: string; id: string; class?: ClassValue } = $props();
</script>

<span role="status" aria-label={active ? name : undefined} class={className}>
  <span {id}>
    {#if active}
      <span
        class="working-badge relative inline-flex h-4 items-center overflow-hidden rounded-full bg-cyan-100 px-1.5 text-[0.6875rem]/4 font-medium whitespace-nowrap text-cyan-950 dark:bg-cyan-950 dark:text-cyan-100"
        >Working</span
      >
    {/if}
  </span>
</span>

<style>
  @media (prefers-reduced-motion: no-preference) {
    .working-badge::after {
      position: absolute;
      inset: auto 0 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, currentColor, transparent);
      content: "";
      transform: translateX(-100%);
      animation: working-sweep var(--duration-shimmer) var(--ease-linear) 2;
    }
  }

  @keyframes working-sweep {
    to {
      transform: translateX(100%);
    }
  }
</style>

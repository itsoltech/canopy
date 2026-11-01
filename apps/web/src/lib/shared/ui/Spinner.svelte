<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** Indeterminate progress, 16px. Decorative: pair it with visible or sr-only text. */
  let { class: className }: { class?: ClassValue } = $props();
</script>

<svg viewBox="0 0 16 16" fill="none" class={["size-4 shrink-0 motion-safe:animate-spin", className]} aria-hidden="true">
  <circle cx="8" cy="8" r="6" class="stroke-current opacity-20" stroke-width="2" />
  <path d="M14 8a6 6 0 0 0-6-6" class="stroke-current" stroke-width="2" stroke-linecap="round" />
</svg>

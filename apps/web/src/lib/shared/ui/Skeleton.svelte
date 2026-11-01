<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** Placeholder block while content loads; size it with classes (the final content's size). It pulses (motion.css `t-pulse`). */
  let { class: className }: { class?: ClassValue } = $props();
</script>

<div class={["t-pulse rounded-md bg-zinc-950/5 dark:bg-white/10", className]} aria-hidden="true"></div>

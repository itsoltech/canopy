<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** Placeholder block while content loads; size it with classes. */
  let { class: className }: { class?: ClassValue } = $props();
</script>

<div class={["rounded-md bg-zinc-950/5 motion-safe:animate-pulse dark:bg-white/10", className]} aria-hidden="true"></div>

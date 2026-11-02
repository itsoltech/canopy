<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** A hairline that fills the rest of a flex row (after a boundary label: "Turn 3", "Forked from …"). */
  let { class: className }: { class?: ClassValue } = $props();
</script>

<span class={["h-px flex-1 bg-zinc-950/5 dark:bg-white/10", className]} aria-hidden="true"></span>

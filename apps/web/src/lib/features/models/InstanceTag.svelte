<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import AccentDot from "./AccentDot.svelte";

  /** A provider instance named quietly: its accent dot (neutral without an accent) and its name, truncated. */
  let { name, accent, class: className }: { name: string; accent: string; class?: ClassValue } = $props();
</script>

<span class={["flex min-w-0 items-center gap-1.5 text-zinc-500 dark:text-zinc-400", className]}>
  <AccentDot {accent} class="size-2" />
  <span class="truncate">{name}</span>
</span>

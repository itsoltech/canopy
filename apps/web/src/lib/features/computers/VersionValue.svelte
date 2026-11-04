<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** One computer's value of a field in a conflict: whose it is, then the value (never a secret). */
  let { computer, value, class: className }: { computer: string; value: string; class?: ClassValue } = $props();
</script>

<div class={["min-w-0 rounded-lg bg-zinc-950/2.5 px-3 py-2 dark:bg-white/5", className]}>
  <p class="truncate text-sm/5 text-zinc-500 dark:text-zinc-400">{computer}</p>
  <p class="text-base/6 wrap-anywhere text-zinc-950 sm:text-sm/6 dark:text-white">{value}</p>
</div>

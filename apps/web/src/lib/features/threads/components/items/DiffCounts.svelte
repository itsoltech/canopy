<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  let { added, removed, class: className }: { added: number; removed: number; class?: ClassValue } = $props();
</script>

<span class={["shrink-0 font-mono tabular-nums", className]}>
  <span class="text-emerald-700 dark:text-emerald-400">+{added}</span>
  <span class="text-rose-700 dark:text-rose-400">−{removed}</span>
</span>

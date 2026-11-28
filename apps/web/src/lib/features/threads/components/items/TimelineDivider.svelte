<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<div class="flex min-w-0 items-center gap-3 py-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
  <span class="h-px min-w-2 flex-1 bg-zinc-950/10 dark:bg-white/10"></span>
  <div class="min-w-0 text-center text-pretty wrap-anywhere">{@render children()}</div>
  <span class="h-px min-w-2 flex-1 bg-zinc-950/10 dark:bg-white/10"></span>
</div>

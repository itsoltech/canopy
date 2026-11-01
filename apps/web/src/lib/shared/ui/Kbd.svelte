<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<kbd class="rounded-sm px-1 font-sans font-medium text-zinc-600 ring-1 ring-zinc-950/10 ring-inset dark:text-zinc-300 dark:ring-white/15">{@render children()}</kbd>

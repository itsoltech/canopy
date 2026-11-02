<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** What a call found when it found nothing ("No subagents yet.", "Nothing found."). */
  let { class: className, children }: { class?: ClassValue; children: Snippet } = $props();
</script>

<p class={["text-base/6 text-zinc-500 italic sm:text-sm/6 dark:text-zinc-400", className]}>{@render children()}</p>

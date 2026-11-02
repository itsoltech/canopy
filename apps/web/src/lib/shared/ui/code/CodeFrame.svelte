<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /**
   * The frame of a code block: a faint wash with a ring, a header row (language, actions) over a divider, then the
   * code. Shared by the chat's `CodeFence` and the composer's code block, so both read as the same thing.
   */
  let { header, children, class: className }: { header: Snippet; children: Snippet; class?: ClassValue } = $props();
</script>

<div class={["overflow-hidden rounded-lg bg-zinc-950/2.5 ring-1 ring-zinc-950/5 dark:bg-white/5 dark:ring-white/10", className]}>
  <!-- The header (language, actions) is chrome: a selection there is never quoted (Cite). -->
  <div data-quote-skip class="flex items-center justify-between gap-2 border-b border-zinc-950/5 pr-0.5 dark:border-white/10">{@render header()}</div>
  {@render children()}
</div>

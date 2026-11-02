<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** One fact of a compact summary (ThreadHoverCard): a 16px mark, the text (truncated), an optional aside on the right. */
  let { class: className, mark, children, aside }: { class?: ClassValue; mark: Snippet; children: Snippet; aside?: Snippet } = $props();
</script>

<li class={["flex min-w-0 items-center gap-2", className]}>
  <span class="grid size-4 shrink-0 place-items-center">{@render mark()}</span>
  <span class="flex min-w-0 flex-1 items-center gap-2 truncate">{@render children()}</span>
  {#if aside}<span class="flex shrink-0 items-center gap-1.5">{@render aside()}</span>{/if}
</li>

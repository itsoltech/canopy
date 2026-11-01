<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** Inline metadata separated by dots ("worker · Linux · /path"); wraps on narrow screens. Hidden items drop their dot too. */
  let { class: className, children }: { class?: ClassValue; children: Snippet } = $props();
</script>

<div class={["flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm/5 text-zinc-500 *:not-first:before:mr-2 *:not-first:before:text-zinc-300 *:not-first:before:content-['·'] dark:text-zinc-400 dark:*:not-first:before:text-zinc-600", className]}>
  {@render children()}
</div>

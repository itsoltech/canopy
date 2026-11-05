<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** Divider between groups of a `DropdownMenu`: `<MenuSeparator />`. Its spacing is padding, not margin. */
  let { class: className }: { class?: ClassValue } = $props();
</script>

<div role="separator" class={["px-2 py-1", className]}><div class="h-px bg-zinc-950/5 dark:bg-white/8"></div></div>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** Line before the first message you have not read yet. */
  let { class: className }: { class?: ClassValue } = $props();
</script>

<div role="separator" aria-label="New messages" class={["flex items-center gap-3", className]}>
  <span class="h-px flex-1 bg-brand-500/40"></span>
  <span class="text-sm/5 font-medium text-brand-600 sm:text-xs/5 dark:text-brand-400">New</span>
</div>

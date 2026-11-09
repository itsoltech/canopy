<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import ThreadStatusText from "#lib/features/threads/ThreadStatusText.svelte";

  /** Reserve the same space for age, activity and results so nearby text never shifts. */
  let { thread, label, class: className }: { thread: ui.Thread; label?: string; class?: string } = $props();
</script>

<span
  role="status"
  aria-atomic="true"
  class={[
    "sidebar-row-status flex h-4.5 w-24 shrink-0 items-center justify-end overflow-hidden text-sm/4.5 tabular-nums sm:h-4 sm:text-xs/4",
    "group-data-calm:opacity-60 pointer-fine:group-focus-within/row:invisible pointer-fine:group-hover/row:invisible",
    className,
  ]}
>
  {#if label}
    <span class="truncate text-amber-700 dark:text-amber-400" title={label}>{label}</span>
  {:else}
    <ThreadStatusText {thread} icons={false} />
  {/if}
</span>

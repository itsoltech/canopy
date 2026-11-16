<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import ThreadStatusText from "#lib/features/threads/ThreadStatusText.svelte";

  /** Reserve the same space for age, activity and results so nearby text never shifts. */
  let {
    thread,
    label,
    compact = false,
    class: className,
  }: { thread: ui.Thread; label?: string; compact?: boolean; class?: string } = $props();
</script>

<span
  role="status"
  aria-atomic="true"
  class={[
    "sidebar-swap-resting sidebar-row-status flex h-5 shrink-0 items-center justify-end overflow-hidden text-sm/5 tabular-nums sm:h-4.5 sm:text-xs/4.5",
    compact ? "w-18" : "w-24",
    className,
  ]}
>
  {#if label}
    <span class="truncate text-amber-700 dark:text-amber-400" title={label}>{label}</span>
  {:else}
    <ThreadStatusText {thread} icons={false} />
  {/if}
</span>

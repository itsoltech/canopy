<script lang="ts">
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";

  /** Placeholder rows on the tree's grid (row height, chevron slot, icon), where the first page will appear. */
  let { rowHeight = 32 }: { rowHeight?: number } = $props();
  const widths = ["w-20", "w-28", "w-16", "w-24", "w-32", "w-20"];
</script>

<div role="status" aria-label="Loading files…">
  {#each widths as width, index (index)}
    <div class="flex items-center gap-1 pr-2 pl-[1.875rem]" style:height={`${rowHeight}px`}>
      <Skeleton class="size-4 rounded-sm" />
      <Skeleton class={["ml-1 h-2.5", width]} />
    </div>
  {/each}
</div>

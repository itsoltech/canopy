<script lang="ts">
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";

  /** Placeholder lines on the reader's grid (gutter, inset, line height), shown only when a file is slow to open. */
  const widths = ["w-2/5", "w-3/5", "w-1/4", "w-0", "w-1/2", "w-2/3", "w-1/3", "w-0", "w-3/5", "w-2/5"];
</script>

<div
  class="flex flex-col py-2 font-mono text-[length:var(--canopy-mono-size)] leading-[1.6]"
  role="status"
  aria-label="Opening the file…"
>
  {#each widths as width, index (index)}
    <div class="flex h-[1.6em] items-center">
      <span class="shrink-0 pr-4 pl-3" style:width="calc(3ch + 1.75rem)"></span>
      {#if width !== "w-0"}<Skeleton class={["h-[0.75em]", width]} />{/if}
    </div>
  {/each}
</div>

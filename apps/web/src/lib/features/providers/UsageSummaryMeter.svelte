<script lang="ts">
  import type { UsageTone } from "@canopy/domain/sidebar-usage";
  import type { SummarySegment } from "@canopy/domain/usage-summary";

  /**
   * One window of a usage summary row: a column per account, sized by plan units and in the same place in every
   * window, and a caption below. An account without this window leaves its column empty.
   */
  let {
    segments,
    caption,
    left,
    leftTone = "neutral",
  }: { segments: readonly SummarySegment[]; caption: string; left?: string; leftTone?: UsageTone } = $props();

  const fill = (value: number) =>
    value <= 10
      ? "bg-rose-600 dark:bg-rose-400"
      : value <= 30
        ? "bg-amber-600 dark:bg-amber-400"
        : "bg-zinc-500 dark:bg-zinc-400";

  const text = (tone: UsageTone) =>
    tone === "danger"
      ? "text-rose-600 dark:text-rose-400"
      : tone === "warning"
        ? "text-amber-700 dark:text-amber-400"
        : "text-zinc-700 dark:text-zinc-300";
</script>

<div class="grid min-w-0 gap-1.5" aria-hidden="true">
  <div class="flex h-1 gap-1">
    {#each segments as segment, index (index)}
      {#if segment.percentLeft === undefined}
        <div class="min-w-1" style:flex={`${segment.units} 1 0%`}></div>
      {:else}
        <div
          class="h-full min-w-1 overflow-hidden rounded-full bg-zinc-950/10 dark:bg-white/10"
          style:flex={`${segment.units} 1 0%`}
        >
          <div class={["h-full rounded-full", fill(segment.percentLeft)]} style:width={`${segment.percentLeft}%`}></div>
        </div>
      {/if}
    {/each}
  </div>
  <div class="flex min-h-5 min-w-0 justify-between gap-2 text-sm/5 sm:text-xs/5">
    <span class="min-w-0 truncate text-zinc-500 dark:text-zinc-400">{caption}</span>
    {#if left}<span class={["shrink-0", text(leftTone)]}>{left}</span>{/if}
  </div>
</div>

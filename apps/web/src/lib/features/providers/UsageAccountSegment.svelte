<script lang="ts">
  import { segmentUsageLabel, segmentValueText, type SummarySegment } from "@canopy/domain/usage-summary";

  let {
    segment,
    index,
    period,
    showValue,
  }: {
    segment: SummarySegment;
    index: number;
    period: string;
    showValue: boolean;
  } = $props();

  const value = $derived(segmentValueText(segment));
</script>

<div
  role="img"
  aria-label={segmentUsageLabel(segment, index, period)}
  style:flex-grow={segment.units}
  class="@container flex min-w-0 basis-0 flex-col items-stretch gap-0.5 py-1 text-center text-xs/4 text-zinc-500 dark:text-zinc-400"
>
  {#if segment.percentLeft !== undefined}
    <span class="h-1.5 overflow-hidden rounded-full bg-zinc-950/10 dark:bg-white/10">
      <span
        class={[
          "block h-full rounded-full",
          segment.percentLeft <= 10
            ? "bg-rose-600 dark:bg-rose-400"
            : segment.percentLeft <= 30
              ? "bg-amber-600 dark:bg-amber-400"
              : "bg-zinc-500 dark:bg-zinc-400",
        ]}
        style:width={`${segment.percentLeft}%`}
      ></span>
    </span>
  {:else if segment.noLimit}
    <span class="no-limit h-1.5 rounded-full bg-zinc-950/5 text-zinc-500 dark:bg-white/5 dark:text-zinc-400"></span>
  {:else}
    <span class="h-1.5 rounded-full border border-dashed border-zinc-400 dark:border-zinc-500"></span>
  {/if}
  {#if showValue}
    <span
      class={[
        "hidden whitespace-nowrap",
        segment.percentLeft !== undefined
          ? "@min-[4.5ch]:block"
          : segment.noLimit
            ? "@min-[7ch]:block"
            : "@min-[10ch]:block",
      ]}>{value}</span
    >
  {/if}
</div>

<style>
  .no-limit {
    background-image: repeating-linear-gradient(125deg, transparent 0 3px, currentColor 3px 4px);
  }
</style>

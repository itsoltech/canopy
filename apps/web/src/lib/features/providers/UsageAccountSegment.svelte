<script lang="ts">
  import { segmentValueText, type SummarySegment } from "@canopy/domain/usage-summary";
  import HoverCard from "#lib/shared/ui/HoverCard.svelte";
  import Sensitive from "#lib/shared/ui/Sensitive.svelte";

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
  const detail = $derived(segment.percentLeft === undefined ? value : `${value} left`);
  const account = $derived(segment.sensitiveLabel ? `Account ${index + 1}` : segment.label);
  const label = $derived(`${account} · ${period} · ${detail}`);
</script>

<HoverCard {label} placement="top" class="w-max max-w-[min(16rem,calc(100vw-1rem))]">
  {#snippet trigger(props)}
    <button
      {...props}
      type="button"
      aria-label={label}
      style:flex-grow={segment.units}
      class="@container flex min-w-0 basis-0 flex-col items-stretch gap-0.5 rounded-sm py-1 text-xs/4 text-zinc-500 focus-ring hover:text-ink dark:text-zinc-400 pointer-coarse:min-h-6"
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
    </button>
  {/snippet}
  <div class="grid min-w-0 gap-0.5 text-sm/5 wrap-anywhere">
    {#if segment.sensitiveLabel}
      <Sensitive value={segment.label} label="Account identity" />
    {:else}
      <span>{segment.label}</span>
    {/if}
    <span class="text-xs/4 text-zinc-500 dark:text-zinc-400">{period} · {detail}</span>
  </div>
</HoverCard>

<style>
  .no-limit {
    background-image: repeating-linear-gradient(125deg, transparent 0 3px, currentColor 3px 4px);
  }
</style>

<script lang="ts">
  import { usageReset } from "@canopy/domain/provider-usage";
  import { percentLeftText, type SummarySegment, type SummaryWindow } from "@canopy/domain/usage-summary";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import UsageAccountSegment from "./UsageAccountSegment.svelte";

  let {
    segments,
    window: reading,
  }: {
    segments: readonly SummarySegment[];
    window?: SummaryWindow;
  } = $props();

  const period = $derived(reading?.name ?? "5-hour");
  const reset = $derived(reading && usageReset(reading, true, clock.now));
  const left = $derived(percentLeftText(reading));

  const showValues = $derived(
    segments.length > 1 &&
      (reading !== undefined || segments.some((segment) => segment.noLimit !== segments[0]?.noLimit)),
  );
</script>

<div class="min-w-0">
  <div class="flex items-baseline justify-between gap-2 text-sm/5 sm:text-xs/5">
    <span class="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      <span class="font-medium">{period}</span>
      {#if reset}<span class="text-zinc-500 dark:text-zinc-400">{reset}</span>{/if}
    </span>
    <span
      class={[
        "shrink-0",
        reading && reading.percentLeft <= 10
          ? "text-rose-600 dark:text-rose-400"
          : reading && reading.percentLeft <= 30
            ? "text-amber-700 dark:text-amber-400"
            : "text-zinc-700 dark:text-zinc-300",
      ]}>{left}</span
    >
  </div>
  <!-- Keep room for the tracks even when a proxy supplies many accounts. -->
  <div class="flex" style:column-gap={`min(0.25rem, ${20 / segments.length}%)`}>
    {#each segments as segment, index (index)}
      <UsageAccountSegment {segment} {index} {period} showValue={showValues} />
    {/each}
  </div>
</div>

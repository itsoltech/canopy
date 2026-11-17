<script lang="ts">
  import { usageProviderColor } from "./providers.ts";
  import { axisLabel, plotUsage, pointX } from "./chart.ts";
  import type { UsageDay, UsageRow, UsageView } from "./format.ts";

  let { days, providers, view, active }: { days: UsageDay[]; providers: UsageRow[]; view: UsageView; active: number } =
    $props();

  const id = $props.id();
  const plot = $derived(plotUsage(days, providers, view));
</script>

<div class="pointer-events-none absolute inset-0 grid grid-cols-[2.5rem_1fr] gap-3" aria-hidden="true">
  <div class="flex min-w-8 flex-col justify-between text-right text-xs/5 text-zinc-500 tabular-nums dark:text-zinc-400">
    <span>{axisLabel(plot.maximum, view)}</span>
    <span>{axisLabel(plot.maximum / 2, view)}</span>
    <span>{axisLabel(0, view)}</span>
  </div>
  <div class="relative min-w-0">
    <div class="absolute inset-x-0 top-[2%] border-t border-dashed border-divider"></div>
    <div class="absolute inset-x-0 top-1/2 border-t border-dashed border-divider"></div>
    <div class="absolute inset-x-0 bottom-[2%] border-t border-divider"></div>
    <svg class="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 1000 200" preserveAspectRatio="none">
      <defs>
        {#each plot.series as series, index (series.key)}
          <linearGradient id="{id}-{index}" x1="0" y1="0" x2="0" y2="1" style:--series={usageProviderColor(series.key)}>
            <stop offset="0%" stop-color="var(--series)" stop-opacity="0.13" />
            <stop offset="100%" stop-color="var(--series)" stop-opacity="0.01" />
          </linearGradient>
        {/each}
      </defs>
      {#each plot.series as series, index (series.key)}
        <g style:--series={usageProviderColor(series.key)}>
          {#each series.paths as path}
            {#if path.area}<path d={path.area} fill="url(#{id}-{index})" />{/if}
            <path
              d={path.line}
              fill="none"
              stroke="var(--series)"
              stroke-width={path.single ? 5 : 2}
              stroke-linecap="round"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
            />
          {/each}
        </g>
      {/each}
    </svg>
    <div
      class="absolute inset-y-0 border-l border-dashed border-zinc-400/60"
      style:left={`${pointX(active, days.length) / 10}%`}
    ></div>
    {#each plot.series as series (series.key)}
      {@const point = series.points[active]}
      {#if point}
        <span
          class="absolute size-2 -translate-1/2 rounded-full border-2 bg-surface"
          style:left={`${point.x / 10}%`}
          style:top={`${point.y / 2}%`}
          style:border-color={usageProviderColor(series.key)}
        ></span>
      {/if}
    {/each}
  </div>
</div>

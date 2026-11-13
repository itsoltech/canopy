<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { METRIC_DEFINITIONS, metricRows } from "@canopy/domain/diagnostics";
  import MetricsTable from "./MetricsTable.svelte";

  let { measures, class: className = "" }: { measures: readonly ui.DiagnosticsMeasure[]; class?: string } = $props();
  const distributions = $derived(measures.filter((row) => METRIC_DEFINITIONS.get(row.metricId)?.kind !== "gauge"));
</script>

<div class={`@container grid min-w-0 gap-3 ${className}`}>
  <MetricsTable {measures} />
  {#if distributions.length}<div class="grid min-w-0 gap-4 @sm:grid-cols-2">
      {#each distributions as measure (measure.metricId)}
        <div class="grid min-w-0 gap-2 text-base sm:text-sm">
          <h4 class="truncate font-medium" title={METRIC_DEFINITIONS.get(measure.metricId)?.name}>
            {METRIC_DEFINITIONS.get(measure.metricId)?.name}
          </h4>
          <dl class="grid gap-1 tabular-nums">
            {#each metricRows(measure) as [label, value] (label)}
              <div class="flex flex-wrap justify-between gap-x-3 gap-y-1">
                <dt class="text-muted">{label}</dt>
                <dd>{value}</dd>
              </div>
            {/each}
          </dl>
          {#if measure.incomplete}<p class="text-muted">Some measurements are missing.</p>{/if}
        </div>
      {/each}
    </div>{/if}
</div>

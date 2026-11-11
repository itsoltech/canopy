<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { METRIC_DEFINITIONS, metricRows } from "@canopy/domain/diagnostics";

  let { measures, class: className = "" }: { measures: readonly ui.DiagnosticsMeasure[]; class?: string } = $props();
</script>

<div class={`@container min-w-0 ${className}`}>
  <div class="grid min-w-0 gap-4 @sm:grid-cols-2">
    {#each measures as measure (measure.metricId)}
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
  </div>
</div>

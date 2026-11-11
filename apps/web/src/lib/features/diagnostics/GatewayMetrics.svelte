<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import {
    METRIC_DEFINITIONS,
    metricGroups,
    metricRows,
    histogramHelp,
    databaseCoverage,
    groupObserved,
  } from "@canopy/domain/diagnostics";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsCard from "#lib/shared/ui/SettingsCard.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import DatabaseFamilies from "./DatabaseFamilies.svelte";

  let { computer }: { computer: ui.ComputerDiagnostics } = $props();
</script>

{#if computer.detailsAvailable}
  <SettingsGroup title="Gateway health" description={computer.name} cards>
    {#if !computer.gatewayMeasuresSupported}
      <SettingsCard><p class="p-4 text-sm text-muted">Update this computer to measure gateway health.</p></SettingsCard>
    {:else}
      <p class="text-sm text-muted">{histogramHelp}</p>
      {#each metricGroups as group (group.id)}
        <SettingsCard>
          <Disclosure class="min-w-0 p-4" open={group.id === "process"}>
            {#snippet summary()}
              <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h3 class="font-medium">{group.title}</h3>
                <span class="text-sm text-muted">{groupObserved(computer, group.id)}</span>
              </div>
            {/snippet}
            <div class="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
              {#each computer.gatewayMeasures.filter((value) => METRIC_DEFINITIONS.get(value.metricId)?.group === group.id) as measure (measure.metricId)}
                <div class="min-w-0 text-sm">
                  <h4 class="mb-2 font-medium wrap-anywhere">
                    {METRIC_DEFINITIONS.get(measure.metricId)?.name}{METRIC_DEFINITIONS.get(measure.metricId)
                      ?.approximate
                      ? " · Estimate from last page read"
                      : ""}
                  </h4>
                  <dl class="grid gap-1 tabular-nums">
                    {#each metricRows(measure) as [label, value] (label)}
                      <div class="flex flex-wrap justify-between gap-x-3 gap-y-1">
                        <dt class="text-muted">{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    {/each}
                  </dl>
                  {#if measure.incomplete}<p class="mt-1 text-muted">Some measurements are missing.</p>{/if}
                </div>
              {:else}<p class="text-sm text-muted">Not measured in this window.</p>{/each}
            </div>
          </Disclosure>
        </SettingsCard>
      {/each}
      <SettingsCard
        ><div class="grid gap-3 p-4">
          <p class="text-sm text-muted">{databaseCoverage(computer)}</p>
          <DatabaseFamilies families={computer.database} />
        </div></SettingsCard
      >
    {/if}
  </SettingsGroup>
{/if}

<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import {
    METRIC_DEFINITIONS,
    workerMetricGroups,
    syncMetricGroups,
    measuresObserved,
    workerTurnHelp,
    workerResourceHelp,
    workerReplayHelp,
  } from "@canopy/domain/diagnostics";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsCard from "#lib/shared/ui/SettingsCard.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import MeasureGrid from "./MeasureGrid.svelte";

  let { computer }: { computer: ui.ComputerDiagnostics } = $props();
</script>

{#if computer.detailsAvailable && computer.links.length}
  <SettingsGroup title="Workers and synchronization" cards>
    {#each computer.links as link (`${link.kind}:${link.targetId}`)}
      <SettingsCard>
        <Disclosure class="min-w-0 p-4">
          {#snippet summary()}<div class="min-w-0">
              <h3 class="truncate font-medium" title={link.name}>{link.name}</h3>
              <p class="text-sm text-muted">
                {link.kind === "worker" ? "Worker" : "Linked computer"} · {link.online
                  ? "Online"
                  : "Offline · Last known data"}
              </p>
            </div>{/snippet}
          <div class="grid gap-4 pt-4">
            {#if !link.measuresSupported}
              <p class="text-base text-muted sm:text-sm">
                Update this computer to measure worker and synchronization health.
              </p>
            {:else}
              {#if link.kind === "worker"}
                <p class="text-sm text-muted sm:text-xs">{workerTurnHelp}</p>
              {:else}<p class="text-base text-muted sm:text-sm">
                  Mirror lag runs from local detection to local commit. An unknown backlog is not zero.
                </p>{/if}
              {#each link.kind === "worker" ? workerMetricGroups : syncMetricGroups as group (group.id)}
                {@const measures = link.measures.filter(
                  (row) => METRIC_DEFINITIONS.get(row.metricId)?.group === group.id,
                )}
                {#if measures.length}
                  <Disclosure>
                    {#snippet summary()}<div class="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
                        <h4 class="font-medium">{group.title}</h4>
                        <p class="text-sm text-muted">{measuresObserved(link.measures, group.id)}</p>
                      </div>{/snippet}
                    <MeasureGrid class="pt-2" {measures} />
                    {#if group.id === "journal"}<p class="pt-2 text-sm text-muted sm:text-xs">
                        {workerReplayHelp}
                      </p>{/if}
                  </Disclosure>
                {/if}
              {/each}
              {#if !link.measures.length}<p class="text-base text-muted sm:text-sm">
                  Not measured in this window.
                </p>{/if}
              {#if link.kind === "worker"}<p class="text-sm text-muted sm:text-xs">{workerResourceHelp}</p>{/if}
              {#if link.droppedSamples}<p class="text-sm text-muted">
                  Some measurements are missing: {link.droppedSamples.toString()} dropped samples.
                </p>{/if}
            {/if}
          </div>
        </Disclosure>
      </SettingsCard>
    {/each}
  </SettingsGroup>
{/if}

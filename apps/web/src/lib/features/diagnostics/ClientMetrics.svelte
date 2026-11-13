<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import MeasureGrid from "./MeasureGrid.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import { clientGroups } from "@canopy/domain/diagnostics";

  let { computer }: { computer: ui.ComputerDiagnostics } = $props();
</script>

{#if computer.detailsAvailable}
  <SettingsGroup title="Clients and delivery" description={computer.name}>
    <div class="grid min-w-0 gap-3 p-4">
      <p class="text-sm text-muted">
        Untrusted client observations: 10% of openings, up to 20/min. BFF operations are measured separately.
      </p>
      <p class="text-sm text-muted">
        Paint and JS frame delays are proxies. Unsupported timings are absent; samples are not total activity.
      </p>
      {#if computer.clientMeasures.length}
        {#each clientGroups(computer.clientMeasures) as group (group.source)}
          <Disclosure open={group.source === "bff"}>
            {#snippet summary()}<h3 class="font-medium">{group.title}</h3>{/snippet}
            <MeasureGrid class="pt-3" measures={group.measures} />
          </Disclosure>
        {/each}
      {:else}<p class="text-sm text-muted">No client observations in this window.</p>{/if}
    </div>
  </SettingsGroup>
{/if}

<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { findingText, diagnosticsFindings, duration } from "@canopy/domain/diagnostics";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Button from "#lib/shared/ui/Button.svelte";

  let { computers }: { computers: ui.ComputerDiagnostics[] } = $props();
  let expanded = $state(false);

  const findings = $derived(diagnosticsFindings(computers));
</script>

{#if findings.length}
  <SettingsGroup title="Findings">
    {#each findings.slice(0, expanded ? findings.length : 5) as { computer, finding, title, observers, observations } (`${computer.computerId}:${finding.ruleId}:${finding.subject}`)}
      <div class="grid gap-1 p-4">
        <p class="font-medium wrap-anywhere">
          {title} · {finding.severity}{finding.suspended ? " · Last known finding" : ""}
        </p>
        <p class="text-sm wrap-anywhere text-muted">{findingText(finding)}</p>
        <Disclosure class="text-sm text-muted">
          {#snippet summary()}Show details{/snippet}
          <p class="wrap-anywhere">
            {finding.subject} · {finding.samples.toString()} samples · {Math.floor(finding.observedSeconds / 60)} min observed
            · Observed by {observers.join(", ")}
          </p>
          {#if finding.ruleId === "link_slow"}{#each observations as observation (observation.id)}<p
                class="wrap-anywhere"
              >
                {observation.name}: p95 {duration(observation.value)} · {observation.samples.toString()} samples · {Math.floor(
                  observation.coverage / 60,
                )} min observed · {observation.freshness}
              </p>{/each}{/if}
        </Disclosure>
      </div>
    {/each}
    {#if findings.length > 5}<div class="p-3">
        <Button onclick={() => (expanded = !expanded)}>{expanded ? "Show fewer" : "Show all"}</Button>
      </div>{/if}
  </SettingsGroup>
{/if}

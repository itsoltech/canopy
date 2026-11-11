<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { databaseRows, databaseHelp, measured } from "@canopy/domain/diagnostics";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";

  let { families, linked = false }: { families: ui.DiagnosticsDatabaseFamily[]; linked?: boolean } = $props();
</script>

<div class="grid min-w-0 gap-3 text-sm">
  <h3 class="font-medium">{linked ? "DB families in this RPC" : "Slow query families"}</h3>
  <p class="text-muted">{databaseHelp}</p>
  {#if linked}<p class="text-muted">
      Only queries executed within this local RPC are included. Other queries may be unclassified or omitted when limits
      are reached.
    </p>{/if}
  {#if !families.length}<p class="text-muted">No measured query families in this window.</p>{/if}
  {#each families as family (family.family)}
    <Disclosure class="border-border min-w-0 rounded-lg border p-3" summaryClass="wrap-anywhere">
      {#snippet summary()}
        {family.family} · execute p95 {measured(family.executeMs)} · {family.executeMs?.samples ?? 0n} samples
      {/snippet}
      {#if family.incomplete}<p class="mt-2 text-muted">Some measurements are missing.</p>{/if}
      <dl class="mt-3 grid gap-2 tabular-nums">
        {#each databaseRows(family) as [label, value] (label)}
          <div class="flex flex-wrap justify-between gap-x-3 gap-y-1">
            <dt class="text-muted">{label}</dt>
            <dd>{value}</dd>
          </div>
        {/each}
      </dl>
    </Disclosure>
  {/each}
</div>

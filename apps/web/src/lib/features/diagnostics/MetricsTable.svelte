<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { metricsTableRows } from "@canopy/domain/diagnostics";

  let { measures }: { measures: readonly ui.DiagnosticsMeasure[] } = $props();
  const rows = $derived(metricsTableRows(measures));
</script>

{#if rows.length}
  <div class="min-w-0">
    <table class="w-full table-fixed text-sm tabular-nums">
      <caption class="sr-only">Measurements. A dash means not measured.</caption>
      <colgroup><col class="w-[34%]" /><col /><col /><col /></colgroup>
      <thead class="text-muted">
        <tr>
          <th scope="col" class="py-1 text-left font-normal">Metric</th>
          {#each ["Last", "Mean", "Max"] as heading (heading)}
            <th scope="col" class="py-1 pl-2 text-right font-normal">{heading}</th>
          {/each}
        </tr>
      </thead>
      <tbody class="divide-y divide-zinc-950/5 dark:divide-white/8">
        {#each rows as row (row.id)}
          <tr>
            <th
              scope="row"
              class="truncate py-1 text-left font-normal"
              title={row.description}
              aria-label={row.description}
            >
              {row.name}{row.incomplete ? " *" : ""}{row.approximate ? " ≈" : ""}
            </th>
            <td class="py-1 pl-2 text-right whitespace-nowrap">{row.last}</td>
            <td class="py-1 pl-2 text-right whitespace-nowrap">{row.mean}</td>
            <td class="py-1 pl-2 text-right whitespace-nowrap">{row.max}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if rows.some((row) => row.incomplete)}<p class="mt-1 text-sm text-muted sm:text-xs">
        * Some measurements are missing.
      </p>{/if}
    {#if rows.some((row) => row.approximate)}<p class="mt-1 text-sm text-muted sm:text-xs">
        ≈ Estimate from the last page read.
      </p>{/if}
  </div>
{/if}

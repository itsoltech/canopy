<script lang="ts">
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import UsageProviderMark from "./UsageProviderMark.svelte";
  import SpeedIcon from "#lib/features/models/SpeedIcon.svelte";
  import UsageCostCoverage from "./UsageCostCoverage.svelte";
  import {
    estimatedCost,
    hasEffectiveCost,
    metricValue,
    reportedCost,
    totalTokens,
    type UsageData,
    type UsageRow,
    type UsageView,
  } from "./format.ts";

  let { data, view }: { data: UsageData; view: UsageView } = $props();
  let group = $state("providers");

  function compareBots(a: UsageRow, b: UsageRow) {
    if (view === "cost") {
      const coverage = Number(hasEffectiveCost(b.amounts)) - Number(hasEffectiveCost(a.amounts));

      return coverage || b.amounts.effectiveCost - a.amounts.effectiveCost || a.label.localeCompare(b.label);
    }

    const aTokens = totalTokens(a.amounts);
    const bTokens = totalTokens(b.amounts);

    if (aTokens === bTokens) return a.label.localeCompare(b.label);

    return aTokens > bTokens ? -1 : 1;
  }

  const providerGroup = $derived({ value: "providers", label: "Provider", heading: "Provider", rows: data.providers });

  const groups = $derived([
    providerGroup,
    { value: "models", label: "Model", heading: "Model", rows: data.models },
    { value: "speeds", label: "Speed", heading: "Requested speed", rows: data.speeds },
    { value: "days", label: "Day", heading: "Day (UTC)", rows: data.days.toReversed() },
    ...(data.supportsActivityBreakdown && data.bots.length
      ? [{ value: "bots", label: "Bot", heading: "Bot", rows: data.bots.toSorted(compareBots) }]
      : []),
  ]);

  const selection = $derived(groups.find((option) => option.value === group) ?? providerGroup);
</script>

<section class="min-w-0">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
    <h3 class="text-base/6 font-medium sm:text-sm/6">Breakdown</h3>
    <SegmentedChoice label="Group usage by" bind:value={group} options={groups} class="flex-wrap" />
  </div>
  <div class="overflow-x-auto rounded-xl border border-divider">
    <table class="w-full text-left text-sm/5">
      <caption class="sr-only">Usage by {selection.value === "days" ? "day" : selection.heading.toLowerCase()}</caption>
      <thead class="bg-zinc-950/3 text-zinc-500 dark:bg-white/3 dark:text-zinc-400">
        <tr>
          <th scope="col" class="px-4 py-2.5 font-medium">{selection.heading}</th>
          <th scope="col" class="px-4 py-2.5 text-right font-medium whitespace-nowrap"
            >{view === "cost" ? "Cost" : "Tokens"}</th
          >
          {#if view === "cost"}
            <th scope="col" class="px-4 py-2.5 text-right font-medium whitespace-nowrap">Reported cost</th>
            <th scope="col" class="px-4 py-2.5 text-right font-medium whitespace-nowrap">Estimated API cost</th>
            <th scope="col" class="px-4 py-2.5 text-right font-medium whitespace-nowrap">Cost coverage</th>{/if}
        </tr>
      </thead>
      <tbody class="divide-y divide-divider">
        {#each selection.rows as row (row.key)}
          <tr>
            <th scope="row" class="max-w-40 min-w-36 px-4 py-3 font-normal sm:max-w-72">
              <div class="flex min-w-0 items-center gap-2">
                {#if group === "providers"}<UsageProviderMark provider={row.key} />{/if}
                {#if group === "speeds"}
                  {#if row.key}<SpeedIcon tier={row.key} />{:else}<span class="h-3.5 w-6 shrink-0" aria-hidden="true"
                    ></span>{/if}
                {/if}
                <TruncatedText text={row.label} />
              </div>
              {#if row.detail}<TruncatedText
                  text={row.detail}
                  class="text-xs/5 text-zinc-500 dark:text-zinc-400"
                />{/if}
            </th>
            <td class="px-4 py-3 text-right whitespace-nowrap tabular-nums select-text"
              >{metricValue(row.amounts, view)}</td
            >
            {#if view === "cost"}
              <td class="px-4 py-3 text-right whitespace-nowrap tabular-nums select-text"
                >{reportedCost(row.amounts)}</td
              >
              <td class="px-4 py-3 text-right whitespace-nowrap tabular-nums select-text"
                >{estimatedCost(row.amounts)}</td
              >
              <td class="min-w-40 px-4 py-3 text-right"><UsageCostCoverage amounts={row.amounts} /></td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
